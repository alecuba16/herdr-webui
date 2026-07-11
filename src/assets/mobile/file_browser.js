(function () {
  function create(deps) {
    const Tree = globalThis.HerdrFileTree;
    const Editor = globalThis.HerdrEditor;
    const state = deps.state;
    function createContentSearchState() {
      return { active: false, query: "", timer: null, files: [], expanded: {}, snippets: {}, loading: false, error: "", offset: 0, done: true, totalFiles: 0, totalMatches: 0, contextLines: 2, maxMatchesPerFile: 5, autoCollapseFiles: 8 };
    }
    const local = { path: "", entries: [], selected: "", file: null, error: "", loading: false, filter: "", filterVisible: false, filterTimer: null, filterOffset: 0, filterDone: true, filterKind: "file", scrollTop: 0, cwdOverride: "", gitStatus: null, contentSearch: createContentSearchState() };

    function cwd() {
      return local.cwdOverride || deps.currentWorkspaceCwd() || "";
    }

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
      if (!root || !local.filter.trim()) return;
      local.loading = true;
      renderPreservingFocus();
      try {
        const offset = append ? local.filterOffset : 0;
        const data = await deps.api(`/api/file-browser/tree?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(local.path || "")}&q=${encodeURIComponent(local.filter.trim())}&${Tree.searchKindQuery(local.filterKind)}&offset=${offset}&limit=100${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
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

    function syncContentSearchOptions() {
      const opts = contentSearchOptions();
      local.contentSearch.contextLines = opts.contextLines;
      local.contentSearch.maxMatchesPerFile = opts.maxMatchesPerFile;
      local.contentSearch.autoCollapseFiles = opts.autoCollapseFiles;
    }

    async function runContentSearch(append = false) {
      const root = cwd();
      const content = local.contentSearch;
      if (!root || !content.query.trim()) return;
      syncContentSearchOptions();
      const offset = append ? content.offset : 0;
      content.loading = true;
      content.error = "";
      deps.render();
      try {
        const data = await deps.api(`/api/file-browser/content-search?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(local.path || "")}&q=${encodeURIComponent(content.query.trim())}&offset=${offset}&limit=50&context_lines=${content.contextLines}&max_matches_per_file=${content.maxMatchesPerFile}`);
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
      deps.render();
    }

    function contentFile(path) {
      return local.contentSearch.files.find((file) => file.path === path) || null;
    }

    async function loadContentSearchFile(path, extraContext) {
      const root = cwd();
      const content = local.contentSearch;
      if (!root || !content.query.trim()) return;
      syncContentSearchOptions();
      const contextLines = Math.max(content.contextLines, Number(extraContext) || content.contextLines);
      const data = await deps.api(`/api/file-browser/content-search/file?cwd=${encodeURIComponent(root)}&file=${encodeURIComponent(path)}&q=${encodeURIComponent(content.query.trim())}&context_lines=${contextLines}&max_matches_per_file=500`);
      if (!data.file) return;
      const index = local.contentSearch.files.findIndex((file) => file.path === path);
      if (index >= 0) local.contentSearch.files[index] = data.file;
      local.contentSearch.expanded[path] = true;
    }

    function renderScreen() {
      if (!cwd()) return '<div class="mobile-loading">Select workspace with path first</div>';
      if (!local.entries.length && !local.loading && !local.error) load(local.path || "");
      if (local.file) return renderPreview();
      const tree = Tree.renderEntries(treeEntries(), { selectedPath: local.selected, callback: "HerdrMobileFiles", showMeta: true, filterTerm: local.filter });
      const more = local.filter.trim() && !local.filterDone ? `<button class="mobile-btn mobile-wide" onclick="HerdrMobile.filesLoadMore()">Load more</button>` : "";
      const resultCount = local.filter.trim() ? local.entries.length : treeEntries().length;
      const noun = Tree.searchKindNoun(local.filterKind);
      const label = Tree.searchKindLabel(local.filterKind);
      const filterVisible = local.filterVisible || local.filter.trim();
      const count = local.filter.trim() ? `<div class="mobile-help mobile-file-result-count">${resultCount} ${noun} result${resultCount === 1 ? "" : "s"}</div>` : `<div class="mobile-help mobile-file-result-count">Focus tree and type to filter</div>`;
      const filter = filterVisible ? `<div class="mobile-files-list-head"><div class="mobile-file-filter-row"><span class="mobile-file-filter"><span class="mobile-file-search-icon ${local.loading && local.filter.trim() ? "searching" : ""}" aria-hidden="true"></span><span class="mobile-file-filter-text">${deps.escapeHtml(local.filter || `Type to search ${noun}s`)}</span></span><button class="mobile-btn mobile-file-kind-toggle" onclick="HerdrMobile.filesToggleFilterKind()">${label}</button><button class="mobile-btn mobile-file-kind-toggle" onclick="HerdrMobile.filesClearFilter()">Clear</button></div>${count}</div>` : `<div class="mobile-files-list-head"><div class="mobile-help mobile-file-result-count">Focus tree and type to filter files. Alt+D folders.</div></div>`;
      const contentSearch = globalThis.HerdrContentSearch;
      const body = local.contentSearch.active && contentSearch ? contentSearch.render({ query: local.contentSearch.query, files: local.contentSearch.files, expanded: local.contentSearch.expanded, snippets: local.contentSearch.snippets, loading: local.contentSearch.loading, error: local.contentSearch.error, done: local.contentSearch.done, total_files: local.contentSearch.totalFiles, total_matches: local.contentSearch.totalMatches }, { callback: "HerdrMobileFilesContent", inputId: "mobileFileContentSearchInput", idPrefix: "mobileContentSearchSnippet" }) : `${filter}${local.loading ? '<div class="mobile-loading">Loading</div>' : tree}${more}`;
      setTimeout(mountContentSearchEditors, 0);
      return `<section class="mobile-section mobile-files" tabindex="0" onfocus="HerdrMobile.filesFocusTree()" onblur="HerdrMobile.filesBlurTree()" onkeydown="HerdrMobile.filesTypeToFilter(event)" onscroll="HerdrMobile.filesScroll(this)"><div class="mobile-files-head"><div><h2>Files</h2><p class="mobile-help">${deps.escapeHtml(local.path || cwd())}</p></div><div class="mobile-actions"><button class="mobile-btn ${local.contentSearch.active ? "active" : ""}" onclick="HerdrMobile.filesToggleContentSearch()">Search</button><button class="mobile-btn" onclick="HerdrMobile.filesRefresh()">Refresh</button></div></div>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${body}</section>`;
    }

    function renderPreservingFocus() {
      const active = document.activeElement;
      const section = active && active.closest ? active.closest(".mobile-files") : null;
      const refocusContentSearch = active && active.id === "mobileFileContentSearchInput";
      const refocusSection = section && active === section;
      deps.render();
      setTimeout(() => {
        const nextInput = document.getElementById("mobileFileContentSearchInput");
        const nextSection = document.querySelector(".mobile-files");
        if (refocusContentSearch && nextInput) {
          nextInput.focus({ preventScroll: true });
        } else if (refocusSection && nextSection) {
          nextSection.focus({ preventScroll: true });
        }
      }, 0);
    }

    function mountContentSearchEditors() {
      if (!local.contentSearch.active || !globalThis.HerdrContentSearch) return;
      for (const file of local.contentSearch.files || []) {
        for (const match of file.matches || []) {
          const key = globalThis.HerdrContentSearch.snippetKey(file.path, match);
          const snippet = local.contentSearch.snippets[key];
          if (!snippet || !snippet.editing) continue;
          const parent = document.getElementById(`mobileContentSearchSnippet-${globalThis.HerdrContentSearch.hashId(key)}`);
          if (!parent) continue;
          Editor.create({ parent, path: file.path, content: snippet.draft == null ? match.content || "" : snippet.draft, readonly: false, hideHeader: true, lineNumbers: lineNumbersEnabled(), onChange(value) { snippet.draft = value; snippet.dirty = value !== (match.content || ""); } });
        }
      }
    }

    globalThis.HerdrMobileFilesContent = {
      setQuery(value) {
        local.contentSearch.query = String(value || "");
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
        local.contentSearch.query = "";
        local.contentSearch.files = [];
        local.contentSearch.expanded = {};
        local.contentSearch.snippets = {};
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
      expandAll() {
        for (const file of local.contentSearch.files || []) local.contentSearch.expanded[file.path] = true;
        deps.render();
      },
      collapseAll() {
        for (const file of local.contentSearch.files || []) local.contentSearch.expanded[file.path] = false;
        deps.render();
      },
      editSnippet(encodedPath, encodedMatchId) {
        const path = decodeURIComponent(encodedPath);
        const file = contentFile(path);
        const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
        if (!match || !globalThis.HerdrContentSearch) return;
        const key = globalThis.HerdrContentSearch.snippetKey(path, match);
        local.contentSearch.snippets[key] = { editing: true, draft: match.content || "", dirty: false };
        deps.render();
      },
      cancelSnippet(encodedPath, encodedMatchId) {
        const path = decodeURIComponent(encodedPath);
        const file = contentFile(path);
        const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
        if (!match || !globalThis.HerdrContentSearch) return;
        delete local.contentSearch.snippets[globalThis.HerdrContentSearch.snippetKey(path, match)];
        deps.render();
      },
      async saveSnippet(encodedPath, encodedMatchId) {
        const path = decodeURIComponent(encodedPath);
        const file = contentFile(path);
        const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
        if (!match || !globalThis.HerdrContentSearch) return;
        const key = globalThis.HerdrContentSearch.snippetKey(path, match);
        const snippet = local.contentSearch.snippets[key];
        if (!snippet) return;
        try {
          await deps.api("/api/file-browser/content-search/snippet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: cwd(), path, expected_hash: file.hash || "", start_line: match.start_line, end_line: match.end_line, content: snippet.draft == null ? "" : snippet.draft }),
          });
          delete local.contentSearch.snippets[key];
          await loadContentSearchFile(path);
          deps.render();
        } catch (error) {
          snippet.error = error.message || String(error);
          deps.render();
        }
      },
      async expandSnippet(encodedPath, _index, direction) {
        const path = decodeURIComponent(encodedPath);
        const extra = local.contentSearch.contextLines + (direction === "up" || direction === "down" ? 2 : 2);
        try {
          await loadContentSearchFile(path, extra);
          local.contentSearch.contextLines = Math.min(20, extra);
          deps.render();
        } catch (error) {
          local.contentSearch.error = error.message || String(error);
          deps.render();
        }
      },
    };

    function treeEntries() {
      if (local.filter.trim()) {
        const entries = Tree.searchTreeEntriesByKind(local.entries, local.filterKind, local.filter);
        return Tree.applyGitStatus(entries, local.gitStatus);
      }
      const entries = local.entries.map((entry) => Object.assign({}, entry));
      const currentRoot = local.cwdOverride || deps.currentWorkspaceCwd() || "";
      const canGoUp = local.path || (currentRoot && Tree.parentDirectory(currentRoot) !== currentRoot);
      if (!local.filter.trim() && canGoUp) entries.unshift(Tree.upEntry(local.path, 0));
      return Tree.applyGitStatus(entries, local.gitStatus);
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
        if (parent && local.file) Editor.create({ parent, path: local.file.path, content: local.file.content || "", readonly: true, hideHeader: true, lineNumbers: lineNumbersEnabled() });
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
          local.filter = "";
          local.filterVisible = false;
          local.filterKind = "file";
          local.cwdOverride = "";
          local.contentSearch = createContentSearchState();
        },
      toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
      select(encodedPath) { openFile(decodeURIComponent(encodedPath)); },
        setFilterKind(kind) {
          local.filterKind = Tree.normalizeSearchKind(kind);
          local.filterVisible = true;
          if (local.filter.trim()) loadFiltered(false);
          else renderPreservingFocus();
        },
      toggleFilterKind() { this.setFilterKind(Tree.toggleSearchKind(local.filterKind)); },
      up() {
        if (local.path) { load(Tree.parentPath(local.path)); return; }
        const wsCwd = deps.currentWorkspaceCwd() || "";
        const currentRoot = local.cwdOverride || wsCwd;
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
          clearTimeout(local.filterTimer);
          local.filterTimer = setTimeout(() => {
            if (local.filter.trim()) loadFiltered(false);
            else load(local.path, true);
          }, 500);
        },
        clearFilter() {
          local.filter = "";
          local.filterVisible = false;
          clearTimeout(local.filterTimer);
          load(local.path, true);
        },
        focusTree() {
          if (local.contentSearch.active) return;
          local.filterVisible = true;
          renderPreservingFocus();
        },
        blurTree() {
          if (local.contentSearch.active || local.filter.trim()) return;
          local.filterVisible = false;
          deps.render();
        },
        toggleContentSearch() {
          local.contentSearch.active = !local.contentSearch.active;
          local.filterVisible = false;
          syncContentSearchOptions();
          deps.render();
        },
        loadMore() { loadFiltered(true); },
      scroll(node) {
        local.scrollTop = node.scrollTop;
        if (!local.filter.trim() || local.loading || local.filterDone) return;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) loadFiltered(true);
      },
        typeToFilter(event) {
          if (local.contentSearch.active) return;
          if (!event || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
          if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); this.setFilterKind("file"); return; }
          if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); this.setFilterKind("dir"); return; }
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
      backToTree() { local.file = null; deps.render(); },
      refreshFile() { if (local.file) openFile(local.file.path); },
    };
  }

  globalThis.HerdrMobileFileBrowser = { create };
})();
