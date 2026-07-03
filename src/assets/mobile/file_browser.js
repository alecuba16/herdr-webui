(function () {
  function create(deps) {
    const Tree = globalThis.HerdrFileTree;
    const Editor = globalThis.HerdrEditor;
    const state = deps.state;
    const local = { path: "", entries: [], selected: "", file: null, error: "", loading: false, filter: "", filterTimer: null, filterOffset: 0, filterDone: true, filterKind: "file", scrollTop: 0, cwdOverride: "", gitStatus: null };

    function cwd() {
      return local.cwdOverride || deps.currentWorkspaceCwd() || "";
    }

    function gitStatusEnabled() {
      try {
        const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
        return parsed.fileBrowserGitStatus !== false;
      } catch (_) { return true; }
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

    function renderScreen() {
      if (!cwd()) return '<div class="mobile-loading">Select workspace with path first</div>';
      if (!local.entries.length && !local.loading && !local.error) load(local.path || "");
      if (local.file) return renderPreview();
      const tree = Tree.renderEntries(treeEntries(), { selectedPath: local.selected, callback: "HerdrMobileFiles", showMeta: true, filterTerm: local.filter });
      const more = local.filter.trim() && !local.filterDone ? `<button class="mobile-btn mobile-wide" onclick="HerdrMobile.filesLoadMore()">Load more</button>` : "";
      const resultCount = treeEntries().length;
      const noun = Tree.searchKindNoun(local.filterKind);
      const label = Tree.searchKindLabel(local.filterKind);
      const count = local.filter.trim() ? `<div class="mobile-help mobile-file-result-count">${resultCount} ${noun} result${resultCount === 1 ? "" : "s"}</div>` : "";
      return `<section class="mobile-section mobile-files" tabindex="0" onkeydown="HerdrMobile.filesTypeToFilter(event)" onscroll="HerdrMobile.filesScroll(this)"><div class="mobile-files-head"><div><h2>Files</h2><p class="mobile-help">${deps.escapeHtml(local.path || cwd())}</p></div><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobile.filesRefresh()">Refresh</button></div></div>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}<div class="mobile-files-list-head"><div class="mobile-file-filter-row"><label class="mobile-file-filter"><span class="mobile-file-search-icon ${local.loading && local.filter.trim() ? "searching" : ""}" aria-hidden="true"></span><input id="mobileFileFilter" value="${deps.escapeHtml(local.filter)}" placeholder="Search ${noun}s (Alt+F/Alt+D)" oninput="HerdrMobile.filesFilter(this.value)"></label><button class="mobile-btn mobile-file-kind-toggle" onclick="HerdrMobile.filesToggleFilterKind()">${label}</button></div>${count}</div>${local.loading ? '<div class="mobile-loading">Loading</div>' : tree}${more}</section>`;
    }

    function renderPreservingFocus() {
      const active = document.activeElement;
      const input = document.getElementById("mobileFileFilter");
      const section = input && input.closest ? input.closest(".mobile-files") : null;
      const refocusInput = active && active.id === "mobileFileFilter";
      const refocusSection = !refocusInput && section && active === section;
      const selectionStart = refocusInput ? active.selectionStart : null;
      const selectionEnd = refocusInput ? active.selectionEnd : null;
      deps.render();
      setTimeout(() => {
        const nextInput = document.getElementById("mobileFileFilter");
        const nextSection = nextInput && nextInput.closest ? nextInput.closest(".mobile-files") : null;
        if (refocusInput && nextInput) {
          nextInput.focus({ preventScroll: true });
          const start = selectionStart == null ? nextInput.value.length : Math.min(selectionStart, nextInput.value.length);
          const end = selectionEnd == null ? start : Math.min(selectionEnd, nextInput.value.length);
          nextInput.setSelectionRange(start, end);
        } else if (refocusSection && nextSection) {
          nextSection.focus({ preventScroll: true });
        }
      }, 0);
    }

    function treeEntries() {
      if (local.filter.trim()) {
        const entries = Tree.searchTreeEntriesByKind(local.entries, local.filterKind);
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
        local.filter = "";
        local.filterKind = "file";
        local.cwdOverride = "";
      },
      toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
      select(encodedPath) { openFile(decodeURIComponent(encodedPath)); },
      setFilterKind(kind) {
        local.filterKind = Tree.normalizeSearchKind(kind);
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
        clearTimeout(local.filterTimer);
        local.filterTimer = setTimeout(() => {
          if (local.filter.trim()) loadFiltered(false);
          else load(local.path, true);
        }, 500);
      },
      loadMore() { loadFiltered(true); },
      scroll(node) {
        local.scrollTop = node.scrollTop;
        if (!local.filter.trim() || local.loading || local.filterDone) return;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) loadFiltered(true);
      },
      typeToFilter(event) {
        if (!event || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
        if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); this.setFilterKind("file"); return; }
        if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); this.setFilterKind("dir"); return; }
        if (event.altKey || event.defaultPrevented) return;
        if (event.target && event.target.closest && event.target.closest("input, textarea, select")) return;
        if (event.key === "Backspace") {
          event.preventDefault();
          this.filter(local.filter.slice(0, -1));
          const input = document.getElementById("mobileFileFilter");
          if (input) {
            input.value = local.filter;
            input.focus({ preventScroll: true });
            input.setSelectionRange(input.value.length, input.value.length);
          }
          return;
        }
        if (event.key.length !== 1) return;
        event.preventDefault();
        this.filter(local.filter + event.key);
        const input = document.getElementById("mobileFileFilter");
        if (input) {
          input.value = local.filter;
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
        }
      },
      backToTree() { local.file = null; deps.render(); },
      refreshFile() { if (local.file) openFile(local.file.path); },
    };
  }

  globalThis.HerdrMobileFileBrowser = { create };
})();
