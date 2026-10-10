// Embedded search sidebar view (Phase 4). Hosts the workspace search in
// the right sidebar column as the third rail view (Files/Git/Search),
// next to the modal palette. The modal palette (search.js) keeps the
// keyboard-first flow; this panel is the always-visible column view.
// Markup reuses the palette section renderers (renderActionSection,
// renderTargetSection, renderWorkspacePathSection,
// renderWorkspaceContentSection) so both surfaces stay identical.
(function () {
  // Own state: the panel keeps its query while the column is collapsed
  // and re-runs its search on reopen, mirroring the palette contract.
  let panelState = null;

  function freshState() {
    const helper = window.HerdrWorkspaceSearch;
    return {
      query: "",
      timer: null,
      requestSeq: 0,
      pathKind: "file",
      pathEntries: [],
      pathGitStatus: null,
      pathOffset: 0,
      pathDone: true,
      pathLoading: false,
      pathError: "",
      recent: [],
      recentLoaded: false,
      // The palette row renderer ranks rows through results/selectedIndex;
      // the panel keeps them local so palette selection is never touched.
      selectedIndex: 0,
      results: [],
      content: helper ? helper.createContentState() : { query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 },
      sectionsExpanded: { actions: true, recent: true, workspaces: true, files: true, content: true },
    };
  }

  function ensureState() {
    if (!panelState) panelState = freshState();
    return panelState;
  }

  function panelNode() {
    let panel = document.getElementById("searchPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "searchPanel";
      panel.className = "search-panel";
    }
    return panel;
  }

  function isOpen() {
    const panel = document.getElementById("searchPanel");
    return !!(panel && panel.parentNode);
  }

  // The search root: the selected workspace folder, else the default
  // folder. currentSearchWorkspace alone returns null on the boot-clean
  // desktop (nothing selected after a restart), which used to leave the
  // panel without a cwd and every keystroke searched nowhere.
  function panelSearchWorkspace() {
    if (typeof currentSearchWorkspace === "function") {
      const selected = currentSearchWorkspace();
      if (selected) return selected;
    }
    if (typeof selectedOrDefaultWorkspace === "function") return selectedOrDefaultWorkspace();
    return null;
  }

  function renderPanel() {
    const panel = document.getElementById("searchPanel");
    if (!panel) return;
    const helper = window.HerdrWorkspaceSearch;
    const state = ensureState();
    const query = state.query || "";
    const opts = helper ? helper.settings() : { searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, searchSectionOrder: ["workspaces", "files", "content"] };
    const order = opts.searchSectionOrder || ["workspaces", "files", "content"];
    // The palette section renderers read the search.js `let searchPaletteState`
    // binding. That binding shadows any window property, so swapping
    // window.searchPaletteState does nothing for them. Swap the binding value
    // itself instead: search.js owns resolveSearchPaletteState(), which the
    // panel points at its own state for the duration of the render.
    const paletteBackup = window.resolveSearchPaletteState ? window.resolveSearchPaletteState(state) : null;
    try {
      const cb = { panel: "HerdrSearchPanel.panel", choose: "HerdrSearchPanel.chooseSearchResult", tree: "HerdrSearchPanel.tree", content: "HerdrSearchPanel.content", idPrefix: "searchPanelContent" };
      const actionsOnly = typeof actionsOnlyQuery === "function" && actionsOnlyQuery(query);
      const actions = typeof searchActionCandidates === "function" ? searchActionCandidates(query) : [];
      const targets = actionsOnly ? [] : (typeof searchCandidates === "function" ? searchCandidates(query) : []);
      state.results = typeof buildSearchSelectionRows === "function"
        ? buildSearchSelectionRows(actions, targets, actionsOnly ? [] : order, opts)
        : [];
      if (state.selectedIndex >= state.results.length)
        state.selectedIndex = Math.max(0, state.results.length - 1);
      const sections = {
        actions: typeof renderActionSection === "function" ? renderActionSection(actions, { actionsOnly }, cb) : "",
        workspaces: actionsOnly || opts.searchWorkspacesEnabled === false || !query.trim() ? "" : (typeof renderTargetSection === "function" ? renderTargetSection(targets, cb) : ""),
        files: actionsOnly || !(typeof pathSearchAvailable === "function" && pathSearchAvailable(opts)) ? "" : (typeof renderWorkspacePathSection === "function" ? renderWorkspacePathSection(opts, cb) : ""),
        content: actionsOnly || opts.searchContentEnabled === false ? "" : (typeof renderWorkspaceContentSection === "function" ? renderWorkspaceContentSection(cb) : ""),
      };
      const recent = actionsOnly || typeof recentWorkspaceCandidates !== "function" ? [] : recentWorkspaceCandidates(state.recent);
      // innerHTML replaces the head with the input node; capture focus and
      // caret before the swap and restore after so typing keeps the caret.
      const active = document.activeElement && document.activeElement.id === "searchPanelInput" ? document.activeElement : null;
      const caret = active && typeof active.selectionStart === "number" ? active.selectionStart : 0;
      const caretEnd = active && typeof active.selectionEnd === "number" ? active.selectionEnd : caret;
      panel.innerHTML = `<div class="search-panel-head"><span class="search-icon" aria-hidden="true">⌕</span><input id="searchPanelInput" class="search-panel-input" placeholder="Search workspaces, files, folders, or file contents..."${inputAttrs("search")} aria-label="Search workspaces, files, folders, or file contents" /><button class="mini settings-close" id="searchPanelClear" title="Clear" aria-label="Clear search"><span aria-hidden="true">✕</span></button></div><div class="search-panel-results" id="searchPanelResults">${typeof renderRecentSection === "function" ? renderRecentSection(recent, cb) : ""}${order.map((key) => sections[key] || "").join("")}</div>`;
      const input = panel.querySelector("#searchPanelInput");
      const clear = panel.querySelector("#searchPanelClear");
      if (input) {
        input.value = state.query;
        if (!input.__herdrWired) {
          input.__herdrWired = true;
          input.addEventListener("input", () => {
            const s = ensureState();
            s.query = input.value;
            if (s.timer) clearTimeout(s.timer);
            s.timer = setTimeout(() => runSearch(false), 180);
            renderPanel();
          });
          input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              const s = ensureState();
              if (s.query) {
                input.value = "";
                s.query = "";
                runSearch(false).then(renderPanel);
              } else if (window.HerdrRightSidebar) {
                window.HerdrRightSidebar.setCollapsed(true);
              }
            }
          });
        }
        if (active) {
          input.focus();
          if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caretEnd);
        }
      }
      if (clear) {
        clear.onclick = () => {
          const s = ensureState();
          const keepOpen = !!s.query;
          s.query = "";
          s.pathEntries = [];
          s.pathDone = true;
          s.pathLoading = false;
          s.pathError = "";
          s.pathGitStatus = null;
          s.pathOffset = 0;
          if (window.HerdrWorkspaceSearch) window.HerdrWorkspaceSearch.resetContentState(s.content, "");
          renderPanel();
          if (keepOpen) {
            const next = document.getElementById("searchPanelInput");
            if (next) next.focus();
          }
        };
      }
    } finally {
      if (window.resolveSearchPaletteState) window.resolveSearchPaletteState(paletteBackup);
    }
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  async function runSearch(append = false) {
    const helper = window.HerdrWorkspaceSearch;
    if (!helper || !isOpen()) return;
    const state = ensureState();
    const seq = ++state.requestSeq;
    const query = String(state.query || "").trim();
    const workspace = panelSearchWorkspace();
    const cwd = helper.workspaceCwd(workspace);
    const opts = helper.settings();
    if (!query || !cwd || (typeof actionsOnlyQuery === "function" && actionsOnlyQuery(query))) {
      state.pathEntries = [];
      state.pathGitStatus = null;
      state.pathDone = true;
      state.pathLoading = false;
      state.pathError = "";
      helper.resetContentState(state.content, "");
      renderPanel();
      return;
    }
    const tasks = [];
    if (typeof pathSearchAvailable === "function" && pathSearchAvailable(opts)) tasks.push(runPathSearch(seq, query, cwd, append && state.pathLoading === false));
    if (opts.searchContentEnabled !== false) tasks.push(runContentSearch(seq, query, cwd, append && state.content.loading === false));
    // The tasks set their loading flags synchronously before the first await,
    // so painting here shows the inline searching row while results stream.
    renderPanel();
    await Promise.allSettled(tasks);
    if (seq === state.requestSeq) renderPanel();
  }

  async function runPathSearch(seq, query, cwd, append) {
    const helper = window.HerdrWorkspaceSearch;
    const state = ensureState();
    const offset = append ? state.pathOffset : 0;
    state.pathLoading = true;
    state.pathError = "";
    try {
      const data = await helper.searchPaths({ cwd, query, kind: state.pathKind, offset });
      if (seq !== state.requestSeq) return;
      const entries = data.entries || [];
      state.pathEntries = append ? state.pathEntries.concat(entries) : entries;
      state.pathGitStatus = data.git_status || null;
      state.pathOffset = offset + entries.length;
      state.pathDone = !data.truncated || entries.length === 0;
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.pathError = error.message || String(error);
      state.pathDone = true;
    } finally {
      if (seq === state.requestSeq) state.pathLoading = false;
    }
  }

  async function runContentSearch(seq, query, cwd, append) {
    const helper = window.HerdrWorkspaceSearch;
    const state = ensureState();
    const opts = helper.settings();
    state.content.query = query;
    if (query.length < opts.contentMinChars) {
      helper.resetContentState(state.content, query);
      state.content.error = query ? `Type at least ${opts.contentMinChars} characters to search contents.` : "";
      return;
    }
    const offset = append ? state.content.offset : 0;
    state.content.loading = true;
    state.content.error = "";
    try {
      const data = await helper.searchContent({ cwd, query, offset, contextLines: state.content.contextLines });
      if (seq !== state.requestSeq) return;
      helper.applyContentResults(state.content, data, append);
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.content.error = error.message || String(error);
      state.content.done = true;
    } finally {
      if (seq === state.requestSeq) state.content.loading = false;
    }
  }

  async function loadRecent() {
    const state = ensureState();
    if (!window.HerdrActionRegistry || !window.HerdrActionRegistry.loadRecent) return;
    const recent = await window.HerdrActionRegistry.loadRecent();
    state.recent = recent;
    state.recentLoaded = true;
  }

  async function open(workspaceId, options) {
    const openOptions = options || {};
    if (typeof rememberWorkspaceShellMode === "function") rememberWorkspaceShellMode("search", workspaceId);
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
    if (!openOptions.forceOpen && window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) {
      window.HerdrRightSidebar.setCollapsed(false);
    }
    const panel = panelNode();
    if (window.HerdrRightSidebar) {
      const ensurePanel = () => panel;
      await window.HerdrRightSidebar.openView("search", workspaceId, ensurePanel);
    }
    const state = ensureState();
    renderPanel();
    await loadRecent();
    renderPanel();
    await runSearch(false);
    const input = document.getElementById("searchPanelInput");
    if (input) {
      input.focus();
      if (typeof input.select === "function") input.select();
    }
    if (typeof render === "function") render();
  }

  function close() {
    const panel = document.getElementById("searchPanel");
    if (panel) panel.remove();
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  // The palette section callbacks (HerdrSearchPaletteTree.select,
  // HerdrSearchPaletteContent.*) are palette-scoped: they read
  // searchPaletteState. The panel re-exports its own callbacks with the
  // same behavior against panelState.
  const PanelTree = {
    select(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const state = ensureState();
      const entry = (state.pathEntries || []).find((item) => item.path === path);
      openWorkspaceSearchPath(path, entry && entry.kind === "dir" ? "dir" : state.pathKind);
    },
  };

  const PanelContent = {
    toggleFile(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const state = ensureState();
      state.content.expanded[path] = !state.content.expanded[path];
      renderPanel();
    },
    openFile(encodedPath) {
      openWorkspaceSearchPath(decodeURIComponent(encodedPath), "file");
    },
    openMatch(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const state = ensureState();
      const file = (state.content.files || []).find((item) => item.path === path);
      const match = window.HerdrContentSearch && window.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
      openWorkspaceSearchContent(file, match);
    },
    expandAll() {
      const state = ensureState();
      for (const file of state.content.files || []) state.content.expanded[file.path] = true;
      renderPanel();
    },
    collapseAll() {
      const state = ensureState();
      for (const file of state.content.files || []) state.content.expanded[file.path] = false;
      renderPanel();
    },
    loadMore() {
      runSearch(true);
    },
    async loadFile(encodedPath) {
      const helper = window.HerdrWorkspaceSearch;
      const state = ensureState();
      const workspace = panelSearchWorkspace();
      const path = decodeURIComponent(encodedPath || "");
      const query = String(state.query || "").trim();
      const cwd = helper && helper.workspaceCwd(workspace);
      if (!helper || !path || !query || !cwd || !helper.searchContentFile) return;
      const seq = ++state.requestSeq;
      try {
        const data = await helper.searchContentFile({ cwd, file: path, query, contextLines: state.content.contextLines, matchesPerFile: 500 });
        if (seq !== state.requestSeq || !data.file) return;
        const index = state.content.files.findIndex((file) => file.path === path);
        if (index >= 0) state.content.files[index] = data.file;
        state.content.expanded[path] = true;
        renderPanel();
      } catch (error) {
        if (seq !== state.requestSeq) return;
        state.content.error = error.message || String(error);
        renderPanel();
      }
    },
  };

  const Panel = {
    chooseSearchResult(index) {
      const state = ensureState();
      const result = state.results[index == null ? state.selectedIndex : index];
      if (!result || (result.type === "recent" && result.isOpen)) return;
      close();
      if (result.type === "path") {
        openWorkspaceSearchPath(result.path, result.kind);
      } else if (result.type === "content") {
        openWorkspaceSearchContent(result.file, result.match);
      } else if (result.type === "action") {
        runSearchAction(result.action);
      } else if (result.type === "recent") {
        openRecentWorkspace(result.path, result.label);
      } else {
        go(result.ws, result.tab, result.pane);
      }
    },
    async clearRecent(event) {
      if (event) event.stopPropagation();
      try {
        await api("/api/recent-workspaces/clear", { method: "POST" });
      } catch (_) {}
      const state = ensureState();
      state.recent = [];
      if (window.HerdrActionRegistry && window.HerdrActionRegistry.invalidateRecent) window.HerdrActionRegistry.invalidateRecent();
      renderPanel();
    },
    async removeRecent(event, path) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!path) return;
      try {
        await api("/api/recent-workspaces/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
      } catch (error) {
        alert(error.message || String(error));
        return;
      }
      const state = ensureState();
      state.recent = (state.recent || []).filter((item) => (item && item.path) !== path);
      if (window.HerdrActionRegistry && window.HerdrActionRegistry.invalidateRecent) window.HerdrActionRegistry.invalidateRecent();
      renderPanel();
    },
    toggleSection(section) {
      const state = ensureState();
      if (!["actions", "recent", "workspaces", "files", "content"].includes(section)) return;
      state.sectionsExpanded[section] = state.sectionsExpanded[section] === false;
      renderPanel();
    },
    setPathKind(kind) {
      const opts = window.HerdrWorkspaceSearch ? window.HerdrWorkspaceSearch.settings() : {};
      if (kind === "dir" && opts.searchFoldersEnabled === false) return;
      if (kind !== "dir" && opts.searchFilesEnabled === false) return;
      const state = ensureState();
      state.pathKind = kind === "dir" ? "dir" : "file";
      state.pathEntries = [];
      state.pathOffset = 0;
      state.pathDone = true;
      renderPanel();
      runSearch(false);
    },
    loadMorePaths() {
      const state = ensureState();
      const helper = window.HerdrWorkspaceSearch;
      const cwd = helper.workspaceCwd(panelSearchWorkspace());
      runPathSearch(++state.requestSeq, state.query, cwd, true).then(renderPanel);
    },
  };

  window.HerdrSearchPanel = {
    open,
    close,
    isOpen,
    render: renderPanel,
    search: runSearch,
    tree: PanelTree,
    content: PanelContent,
    panel: Panel,
  };
})();
