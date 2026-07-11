(function () {
  const Tree = globalThis.HerdrFileTree;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function arg(value) {
    return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
  }

  function storedOptions() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function normalizeSectionOrder(value) {
    const allowed = ["workspaces", "files", "content"];
    const seen = new Set();
    const order = [];
    for (const part of String(value || "").split(",")) {
      const key = part.trim().toLowerCase();
      if (allowed.includes(key) && !seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    for (const key of allowed) if (!seen.has(key)) order.push(key);
    return order;
  }

  function settings() {
    const parsed = storedOptions();
    const contextRaw = Number(parsed.fileContentSearchContextLines);
    const autoCollapseRaw = Number(parsed.fileContentSearchAutoCollapseFiles);
    return {
      searchWorkspacesEnabled: parsed.searchWorkspacesEnabled !== false,
      searchFilesEnabled: parsed.searchFilesEnabled !== false,
      searchFoldersEnabled: parsed.searchFoldersEnabled !== false,
      searchContentEnabled: parsed.searchContentEnabled !== false,
      searchSectionOrder: normalizeSectionOrder(parsed.searchSectionOrder),
      pathSearchEnabled: parsed.fileBrowserPathSearch !== false,
      pathPageSize: Math.max(10, Math.min(500, Number(parsed.fileBrowserSearchPageSize) || 100)),
      gitStatusEnabled: parsed.fileBrowserGitStatus !== false,
      contentMinChars: Math.max(1, Math.min(20, Number(parsed.fileContentSearchMinChars) || 3)),
      contentPageSize: Math.max(10, Math.min(500, Number(parsed.fileContentSearchPageSize) || 50)),
      contextLines: Math.max(0, Math.min(20, Number.isFinite(contextRaw) ? contextRaw : 2)),
      autoCollapseFiles: Math.max(0, Math.min(200, Number.isFinite(autoCollapseRaw) ? autoCollapseRaw : 0)),
      defaultExpanded: parsed.fileContentSearchDefaultExpanded !== false,
      matchesPerFile: Math.max(1, Math.min(50, Number(parsed.fileContentSearchMatchesPerFile) || 5)),
    };
  }

  function defaultContentExpanded(opts, fileCount) {
    return !!(opts.defaultExpanded && !(opts.autoCollapseFiles > 0 && fileCount > opts.autoCollapseFiles));
  }

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    if (globalThis.HerdrWorkspacePath) return globalThis.HerdrWorkspacePath(workspace);
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    return workspace.cwd || workspace.path || "";
  }

  async function apiJson(url, opt) {
    const fetcher = globalThis.fetch;
    const res = await fetcher(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  async function searchPaths({ cwd, query, kind = "file", offset = 0, limit, path = "" }) {
    const opts = settings();
    const normalizedKind = Tree && Tree.normalizeSearchKind ? Tree.normalizeSearchKind(kind) : kind === "dir" ? "dir" : "file";
    const kindEnabled = normalizedKind === "dir" ? opts.searchFoldersEnabled : opts.searchFilesEnabled;
    if (!opts.pathSearchEnabled || !kindEnabled) return { entries: [], git_status: null, truncated: false, disabled: true };
    const kindQuery = Tree && Tree.searchKindQuery ? Tree.searchKindQuery(normalizedKind) : `search_kind=${normalizedKind}`;
    const url = `/api/file-browser/tree?cwd=${encodeURIComponent(cwd || "")}&path=${encodeURIComponent(path || "")}&q=${encodeURIComponent(String(query || "").trim())}&${kindQuery}&offset=${Number(offset) || 0}&limit=${Number(limit || opts.pathPageSize)}${opts.gitStatusEnabled ? "&include_git_status=true" : ""}`;
    return apiJson(url);
  }

  async function searchContent({ cwd, query, offset = 0, limit, path = "", contextLines, matchesPerFile }) {
    const opts = settings();
    if (!opts.searchContentEnabled) return { files: [], total_files: 0, total_matches: 0, truncated: false, disabled: true };
    const context = Math.max(0, Math.min(20, Number.isFinite(Number(contextLines)) ? Number(contextLines) : opts.contextLines));
    const perFile = Math.max(1, Math.min(50, Number.isFinite(Number(matchesPerFile)) ? Number(matchesPerFile) : opts.matchesPerFile));
    const url = `/api/file-browser/content-search?cwd=${encodeURIComponent(cwd || "")}&path=${encodeURIComponent(path || "")}&q=${encodeURIComponent(String(query || "").trim())}&offset=${Number(offset) || 0}&limit=${Number(limit || opts.contentPageSize)}&context_lines=${context}&max_matches_per_file=${perFile}`;
    return apiJson(url);
  }

  function createContentState(initial) {
    const opts = settings();
    return Object.assign({
      query: "",
      files: [],
      expanded: {},
      snippets: {},
      loading: false,
      error: "",
      done: true,
      offset: 0,
      total_files: 0,
      total_matches: 0,
      contextLines: opts.contextLines,
    }, initial || {});
  }

  function resetContentState(state, query) {
    state.query = query || "";
    state.files = [];
    state.expanded = {};
    state.snippets = {};
    state.error = "";
    state.done = true;
    state.offset = 0;
    state.total_files = 0;
    state.total_matches = 0;
    state.contextLines = settings().contextLines;
  }

  function applyContentResults(state, data, append) {
    const files = data.files || [];
    state.files = append ? state.files.concat(files) : files;
    state.total_files = data.total_files || state.files.length;
    state.total_matches = data.total_matches || 0;
    state.offset = (append ? state.offset : 0) + files.length;
    state.done = !data.truncated || files.length === 0;
    if (!append) {
      const opts = settings();
      state.expanded = {};
      const expanded = defaultContentExpanded(opts, state.files.length);
      for (const file of state.files) state.expanded[file.path] = expanded;
    } else {
      const expanded = defaultContentExpanded(settings(), state.files.length);
      for (const file of files) if (!Object.prototype.hasOwnProperty.call(state.expanded, file.path)) state.expanded[file.path] = expanded;
    }
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

  function flattenContentMatches(files) {
    const rows = [];
    for (const file of files || []) {
      for (const match of file.matches || []) rows.push({ type: "content", file, match });
    }
    return rows;
  }

  function renderPathTree(entries, opts) {
    if (!Tree || !Tree.renderEntries) return "";
    const rows = Tree.applyGitStatus ? Tree.applyGitStatus(Tree.searchTreeEntriesByKind ? Tree.searchTreeEntriesByKind(entries || [], opts.kind || "file", opts.query || "") : entries || [], opts.gitStatus || null) : entries || [];
    return Tree.renderEntries(rows, {
      selectedPath: opts.selectedPath || "",
      callback: opts.callback || "HerdrWorkspaceSearchTree",
      showMeta: true,
      dirClickMethod: "select",
      dirDoubleClickMethod: "select",
      toggleMethod: "select",
      selectMethod: "select",
      filterTerm: opts.query || "",
      compactSingleChildDirs: true,
    });
  }

  function renderContentPicker(state, opts) {
    const contentSearch = globalThis.HerdrContentSearch;
    if (!contentSearch || !contentSearch.render) return "";
    return contentSearch.render(state, Object.assign({
      callback: opts.callback || "HerdrWorkspaceSearchContent",
      hideInput: true,
      disableSnippetEditing: true,
      idPrefix: opts.idPrefix || "workspaceSearchContent",
    }, opts || {}));
  }

  globalThis.HerdrWorkspaceSearch = {
    arg,
    esc,
    settings,
    workspaceCwd,
    searchPaths,
    searchContent,
    createContentState,
    resetContentState,
    applyContentResults,
    matchHighlight,
    flattenContentMatches,
    renderPathTree,
    renderContentPicker,
  };
})();
