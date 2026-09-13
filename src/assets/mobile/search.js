(function () {
  function createMobileSearch({
    el,
    state,
    escapeHtml,
    currentWorkspace,
    currentWorkspaceCwd,
    workspaceTitle,
    workspaceMeta,
    worktreeForWorkspace,
    tabTitle,
    selectWorkspace,
    selectAgent,
    showScreen,
    openAt,
    runAction,
    searchDisabledFn,
  }) {
    const mobileSearch = {
      query: "",
      pathKind: "file",
      timer: null,
      requestSeq: 0,
      actions: [],
      targets: [],
      pathEntries: [],
      pathGitStatus: null,
      pathLoading: false,
      pathError: "",
      pathDone: true,
      pathOffset: 0,
      content: globalThis.HerdrWorkspaceSearch ? globalThis.HerdrWorkspaceSearch.createContentState() : { query: "", files: [], expanded: {}, snippets: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 },
      sectionsExpanded: { actions: true, workspaces: true, files: true, content: true },
    };

    function open() {
      if (searchDisabledFn()) return;
      const sheet = el("mobileSearchSheet");
      const input = el("mobileSearchInput");
      if (!sheet || !input) return;
      mobileSearch.query = "";
      mobileSearch.actions = mobileActionCandidates("");
      mobileSearch.targets = mobileSearchTargets("");
      mobileSearch.pathEntries = [];
      mobileSearch.pathError = "";
      if (globalThis.HerdrWorkspaceSearch) globalThis.HerdrWorkspaceSearch.resetContentState(mobileSearch.content, "");
      input.value = "";
      sheet.hidden = false;
      render();
      input.oninput = schedule;
      input.onkeydown = keydown;
      el("mobileSearchClose").onclick = close;
      setTimeout(() => input.focus(), 0);
    }

    function close() {
      const sheet = el("mobileSearchSheet");
      if (sheet) sheet.hidden = true;
      if (mobileSearch.timer) clearTimeout(mobileSearch.timer);
    }

    function mobileSearchTargets(query) {
      const helper = globalThis.HerdrWorkspaceSearch;
      if (helper && helper.settings && helper.settings().searchWorkspacesEnabled === false) return [];
      const needle = String(query || "").trim().toLowerCase();
      if (!needle) return [];
      const rows = [];
      for (const workspace of state.workspaces) {
        const text = mobileSearchText(
          workspaceTitle(workspace),
          workspaceMeta(workspace),
          workspace.workspace_id,
          workspace.worktree && workspace.worktree.checkout_path,
          mobileWorkspaceRepoFields(workspace),
          mobileWorkspaceTagFields(workspace),
          mobileWorkspaceBranchFields(workspace),
          mobileWorkspacePanelFields(workspace.workspace_id),
        ).toLowerCase();
        if (text.includes(needle)) rows.push({ type: "workspace", workspace, title: workspaceTitle(workspace), subtitle: workspaceMeta(workspace) });
      }
      for (const agent of state.agents) {
        const title = agent.name || agent.display_agent || agent.agent || agent.terminal_id || "agent";
        const text = [title, agent.workspace_id, agent.tab_id, agent.pane_id].filter(Boolean).join(" ").toLowerCase();
        if (!needle || text.includes(needle)) rows.push({ type: "agent", agent, title, subtitle: agent.workspace_id || "agent" });
      }
      return rows.slice(0, 10);
    }

    function mobileActionCandidates(query) {
      return globalThis.HerdrActionRegistry.candidates(query, {
        platform: "mobile",
        hasWorkspace: !!currentWorkspace(),
      });
    }

    function mobileTextParts(...values) {
      const out = [];
      for (const value of values) {
        if (Array.isArray(value)) out.push(...mobileTextParts(...value));
        else if (value && typeof value === "object") out.push(...mobileTextParts(...Object.values(value)));
        else if (value != null && String(value).trim()) out.push(String(value).trim());
      }
      return out;
    }

    function mobileSearchText(...values) {
      return mobileTextParts(...values).join(" ");
    }

    function mobileUniqueTextParts(...values) {
      const seen = new Set();
      return mobileTextParts(...values).filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function mobileWorkspaceRepoFields(workspace) {
      const wt = workspace && workspace.worktree;
      return mobileUniqueTextParts(wt && wt.repo_name, wt && wt.repo_key, wt && wt.repo_root, wt && wt.source_repo_name, wt && wt.source_repo_key, wt && wt.source_repo_root);
    }

    function mobileWorkspaceTagFields(workspace) {
      const wt = workspace && workspace.worktree;
      return mobileUniqueTextParts(workspace && workspace.tags, workspace && workspace.tag, workspace && workspace.labels, wt && wt.tags, wt && wt.tag, wt && wt.labels);
    }

    function mobileWorkspaceBranchFields(workspace) {
      const wt = workspace && workspace.worktree;
      const row = worktreeForWorkspace(workspace);
      return mobileUniqueTextParts(
        row && (row.branch || (row.is_detached ? "detached" : "")),
        workspace && workspace.branch,
        wt && wt.branch,
        wt && wt.base_branch,
        row && row.base_branch,
        row && row.upstream_branch,
      );
    }

    function mobileWorkspacePanelFields(workspaceId) {
      return mobileUniqueTextParts(state.allTabs.concat(state.tabs).filter((tab) => tab && tab.workspace_id === workspaceId).map((tab) => [tabTitle(tab), tab.label, tab.title, tab.name, tab.tab_id]));
    }

    function mobileSearchSettings() {
      return globalThis.HerdrWorkspaceSearch && globalThis.HerdrWorkspaceSearch.settings
        ? globalThis.HerdrWorkspaceSearch.settings()
        : { searchSectionOrder: ["workspaces", "files", "content"], searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true };
    }

    function mobilePathSearchAvailable(opts = mobileSearchSettings()) {
      const helper = globalThis.HerdrWorkspaceSearch;
      return helper && helper.pathSearchAvailable ? helper.pathSearchAvailable(opts) : opts.searchFilesEnabled !== false || opts.searchFoldersEnabled !== false;
    }

    function normalizeMobilePathKind(opts = mobileSearchSettings()) {
      const helper = globalThis.HerdrWorkspaceSearch;
      mobileSearch.pathKind = helper && helper.normalizePathKind
        ? helper.normalizePathKind(mobileSearch.pathKind, opts)
        : mobileSearch.pathKind === "dir" && opts.searchFoldersEnabled === false && opts.searchFilesEnabled !== false
          ? "file"
          : mobileSearch.pathKind !== "dir" && opts.searchFilesEnabled === false && opts.searchFoldersEnabled !== false
            ? "dir"
            : mobileSearch.pathKind === "dir" ? "dir" : "file";
    }

    function schedule() {
      const input = el("mobileSearchInput");
      mobileSearch.query = input ? input.value : "";
      mobileSearch.actions = mobileActionCandidates(mobileSearch.query);
      mobileSearch.targets = mobileSearchTargets(mobileSearch.query);
      render();
      if (mobileSearch.timer) clearTimeout(mobileSearch.timer);
      mobileSearch.timer = setTimeout(() => runMobileWorkspaceSearch(false), 180);
    }

    async function runMobileWorkspaceSearch(append) {
      const helper = globalThis.HerdrWorkspaceSearch;
      if (!helper) return;
      const query = String(mobileSearch.query || "").trim();
      const cwd = currentWorkspaceCwd();
      const seq = ++mobileSearch.requestSeq;
      const opts = helper.settings();
      normalizeMobilePathKind(opts);
      if (!query || !cwd) {
        mobileSearch.pathEntries = [];
        helper.resetContentState(mobileSearch.content, query);
        render();
        return;
      }
      const tasks = [];
      if (mobilePathSearchAvailable(opts)) tasks.push(runMobilePathSearch(seq, query, cwd, append));
      else {
        mobileSearch.pathEntries = [];
        mobileSearch.pathGitStatus = null;
        mobileSearch.pathOffset = 0;
        mobileSearch.pathDone = true;
        mobileSearch.pathLoading = false;
        mobileSearch.pathError = "";
      }
      if (opts.searchContentEnabled !== false) tasks.push(runMobileContentSearch(seq, query, cwd, append));
      else helper.resetContentState(mobileSearch.content, query);
      await Promise.allSettled(tasks);
      if (seq === mobileSearch.requestSeq) render();
    }

    async function runMobilePathSearch(seq, query, cwd, append) {
      const helper = globalThis.HerdrWorkspaceSearch;
      mobileSearch.pathLoading = true;
      mobileSearch.pathError = "";
      render();
      try {
        const offset = append ? mobileSearch.pathOffset : 0;
        const data = await helper.searchPaths({ cwd, query, kind: mobileSearch.pathKind, offset });
        if (seq !== mobileSearch.requestSeq) return;
        const entries = data.entries || [];
        mobileSearch.pathEntries = append ? mobileSearch.pathEntries.concat(entries) : entries;
        mobileSearch.pathGitStatus = data.git_status || null;
        mobileSearch.pathOffset = offset + entries.length;
        mobileSearch.pathDone = !data.truncated || entries.length === 0;
        mobileSearch.pathError = "";
      } catch (error) {
        if (seq !== mobileSearch.requestSeq) return;
        mobileSearch.pathError = error.message || String(error);
        mobileSearch.pathDone = true;
      }
      if (seq === mobileSearch.requestSeq) mobileSearch.pathLoading = false;
    }

    function renderPreservingScroll() {
      const box = el("mobileSearchResults");
      const top = box ? box.scrollTop : 0;
      render();
      const next = el("mobileSearchResults");
      if (next) next.scrollTop = top;
    }

    async function runMobileContentSearch(seq, query, cwd, append, options = {}) {
      const helper = globalThis.HerdrWorkspaceSearch;
      const opts = helper.settings();
      mobileSearch.content.query = query;
      if (query.length < opts.contentMinChars) {
        helper.resetContentState(mobileSearch.content, query);
        mobileSearch.content.error = query ? `Type at least ${opts.contentMinChars} characters to search contents.` : "";
        return;
      }
      mobileSearch.content.loading = true;
      mobileSearch.content.error = "";
      (options.preserveScroll ? renderPreservingScroll : render)();
      try {
        const offset = append ? mobileSearch.content.offset : 0;
        const data = await helper.searchContent({ cwd, query, offset, contextLines: mobileSearch.content.contextLines });
        if (seq !== mobileSearch.requestSeq) return;
        helper.applyContentResults(mobileSearch.content, data, append, { preserveExpanded: !!options.preserveExpanded });
      } catch (error) {
        if (seq !== mobileSearch.requestSeq) return;
        mobileSearch.content.error = error.message || String(error);
        mobileSearch.content.done = true;
      }
      if (seq === mobileSearch.requestSeq) mobileSearch.content.loading = false;
    }

    function render() {
      const box = el("mobileSearchResults");
      const helper = globalThis.HerdrWorkspaceSearch;
      if (!box || !helper) return;
      const opts = helper.settings();
      normalizeMobilePathKind(opts);
      const query = String(mobileSearch.query || "").trim();
      const actionRows = mobileSearch.actions.length
        ? mobileSearch.actions.map((row, index) => `<button class="mobile-row" onclick="HerdrMobileSearch.openAction(${index})"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.subtitle)}</span></button>`).join("")
        : '<div class="mobile-loading">No matching actions.</div>';
      const targetRows = mobileSearch.targets.length
        ? mobileSearch.targets.map((row, index) => `<button class="mobile-row" onclick="HerdrMobileSearch.openTarget(${index})"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.subtitle || row.type)}</span></button>`).join("")
        : '<div class="mobile-loading">No workspace or agent matches.</div>';
      const pathNoun = mobileSearch.pathKind === "dir" ? "folders" : "files";
      const pathMore = query && !mobileSearch.pathDone && !mobileSearch.pathLoading
        ? `<button class="mobile-btn mobile-search-more" onclick="HerdrMobileSearch.loadMorePaths()">${mobileSearch.pathLoading ? "Searching..." : `Load more ${pathNoun}`}</button>`
        : "";
      const pathTree = (query
        ? mobileSearch.pathEntries.length
          ? helper.renderPathTree(mobileSearch.pathEntries, { query, kind: mobileSearch.pathKind, gitStatus: mobileSearch.pathGitStatus, callback: "HerdrMobileSearchTree" })
          : `<div class="mobile-loading">${mobileSearch.pathLoading ? "Searching..." : "No files or folders found."}</div>`
        : '<div class="mobile-loading">Type to search files or folders.</div>') + pathMore;
      const contentBody = !opts.searchContentEnabled
        ? '<div class="mobile-loading">File content search is disabled in Settings.</div>'
        : query.length < opts.contentMinChars
          ? `<div class="mobile-loading">Type at least ${opts.contentMinChars} characters to search file contents.</div>`
          : helper.renderContentPicker(mobileSearch.content, { callback: "HerdrMobileSearchContent", idPrefix: "mobileUnifiedSearchContent", disableSnippetEditing: true });
      const sections = {
        actions: renderSection("actions", "Actions", String(mobileSearch.actions.length), actionRows),
        workspaces: opts.searchWorkspacesEnabled === false || !query ? "" : renderSection("workspaces", "Workspaces and agents", String(mobileSearch.targets.length), targetRows),
        files: mobilePathSearchAvailable(opts) ? renderSection("files", "Files and folders", mobileSearch.pathKind === "dir" ? "Folders" : "Files", `<div class="mobile-actions"><button class="mobile-btn ${mobileSearch.pathKind === "file" ? "active" : ""}" ${opts.searchFilesEnabled === false ? "disabled" : ""} onclick="HerdrMobileSearch.setPathKind('file')">Files</button><button class="mobile-btn ${mobileSearch.pathKind === "dir" ? "active" : ""}" ${opts.searchFoldersEnabled === false ? "disabled" : ""} onclick="HerdrMobileSearch.setPathKind('dir')">Folders</button></div>${mobileSearch.pathError ? `<div class="mobile-error">${escapeHtml(mobileSearch.pathError)}</div>` : ""}${pathTree}`) : "",
        content: opts.searchContentEnabled === false ? "" : renderSection("content", "File content", `${Number(mobileSearch.content.total_matches || 0)} matches`, contentBody),
      };
      box.innerHTML = sections.actions + opts.searchSectionOrder.map((key) => sections[key] || "").join("");
    }

    function renderSection(key, title, meta, body) {
      const expanded = mobileSearch.sectionsExpanded[key] !== false;
      return `<section class="mobile-search-section"><button class="mobile-search-section-toggle" onclick="HerdrMobileSearch.toggleSection('${key}')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>${escapeHtml(title)}</strong><span>${escapeHtml(meta || "")}</span></button>${expanded ? body : ""}</section>`;
    }

    function keydown(event) {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.altKey && (event.key === "1" || event.code === "Digit1")) { event.preventDefault(); globalThis.HerdrMobileSearch.toggleSection("workspaces"); }
      else if (event.altKey && (event.key === "2" || event.code === "Digit2")) { event.preventDefault(); globalThis.HerdrMobileSearch.toggleSection("files"); }
      else if (event.altKey && (event.key === "3" || event.code === "Digit3")) { event.preventDefault(); globalThis.HerdrMobileSearch.toggleSection("content"); }
      else if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); globalThis.HerdrMobileSearchContent.expandSnippet("", "", "up"); }
      else if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); globalThis.HerdrMobileSearchContent.expandSnippet("", "", "down"); }
      else if (event.key === "Enter") { event.preventDefault(); openFirstResult(); }
      else if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); globalThis.HerdrMobileSearch.setPathKind("file"); }
      else if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); globalThis.HerdrMobileSearch.setPathKind("dir"); }
    }

    function openFirstResult() {
      const opts = mobileSearchSettings();
      if (mobileSearch.sectionsExpanded.actions !== false && mobileSearch.actions[0]) { globalThis.HerdrMobileSearch.openAction(0); return; }
      for (const section of opts.searchSectionOrder || ["workspaces", "files", "content"]) {
        if (mobileSearch.sectionsExpanded[section] === false) continue;
        if (section === "workspaces" && opts.searchWorkspacesEnabled !== false && mobileSearch.targets[0]) { globalThis.HerdrMobileSearch.openTarget(0); return; }
        if (section === "files" && mobilePathSearchAvailable(opts)) {
          const pathEntry = (mobileSearch.pathEntries || []).find((entry) => (entry.kind === "dir" ? "dir" : "file") === mobileSearch.pathKind);
          if (pathEntry) { globalThis.HerdrMobileSearch.openPath(pathEntry.path, pathEntry.kind); return; }
        }
        if (section === "content" && opts.searchContentEnabled !== false) {
          const file = (mobileSearch.content.files || [])[0];
          const match = file && (file.matches || [])[0];
          if (file && match) { globalThis.HerdrMobileSearch.openContent(file.path, match.id); return; }
        }
      }
    }

    globalThis.HerdrMobileSearch = {
      toggleSection(section) {
        if (!["actions", "workspaces", "files", "content"].includes(section)) return;
        mobileSearch.sectionsExpanded[section] = mobileSearch.sectionsExpanded[section] === false;
        render();
      },
      openAction(index) {
        const row = mobileSearch.actions[index];
        if (!row) return;
        close();
        runAction(row.action);
      },
      setPathKind(kind) {
        const opts = mobileSearchSettings();
        if (kind === "dir" && opts.searchFoldersEnabled === false) return;
        if (kind !== "dir" && opts.searchFilesEnabled === false) return;
        mobileSearch.pathKind = kind === "dir" ? "dir" : "file";
        mobileSearch.pathEntries = [];
        mobileSearch.pathOffset = 0;
        render();
        runMobileWorkspaceSearch(false);
      },
      loadMorePaths() {
        if (mobileSearch.pathLoading || mobileSearch.pathDone) return;
        runMobilePathSearch(++mobileSearch.requestSeq, mobileSearch.query, currentWorkspaceCwd(), true).then(renderPreservingScroll);
      },
      openTarget(index) {
        const row = mobileSearch.targets[index];
        if (!row) return;
        close();
        if (row.type === "workspace") selectWorkspace(row.workspace.workspace_id);
        else if (row.agent) selectAgent(row.agent.workspace_id, row.agent.tab_id, row.agent.pane_id);
      },
      openPath(path, kind) {
        close();
        showScreen("files");
        const resolvedKind = kind === "dir" ? "dir" : "file";
        openAt(path, { kind: resolvedKind, preserveContext: resolvedKind === "file" });
      },
      openContent(path, matchId) {
        const helper = globalThis.HerdrWorkspaceSearch;
        const file = (mobileSearch.content.files || []).find((item) => item.path === path);
        const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, matchId);
        close();
        showScreen("files");
        openAt(path, { kind: "file", preserveContext: true, highlight: helper && helper.matchHighlight(match, mobileSearch.query) });
      },
    };

    globalThis.HerdrMobileSearchTree = {
      select(encodedPath) {
        const path = decodeURIComponent(encodedPath);
        const entry = (mobileSearch.pathEntries || []).find((item) => item.path === path);
        globalThis.HerdrMobileSearch.openPath(path, entry && entry.kind === "dir" ? "dir" : mobileSearch.pathKind);
      },
    };

    globalThis.HerdrMobileSearchContent = {
      toggleFile(encodedPath) {
        const path = decodeURIComponent(encodedPath);
        mobileSearch.content.expanded[path] = !mobileSearch.content.expanded[path];
        render();
      },
      openFile(encodedPath) { globalThis.HerdrMobileSearch.openPath(decodeURIComponent(encodedPath), "file"); },
      openMatch(encodedPath, encodedMatchId) { globalThis.HerdrMobileSearch.openContent(decodeURIComponent(encodedPath), decodeURIComponent(encodedMatchId)); },
      expandAll() { for (const file of mobileSearch.content.files || []) mobileSearch.content.expanded[file.path] = true; render(); },
      collapseAll() { for (const file of mobileSearch.content.files || []) mobileSearch.content.expanded[file.path] = false; render(); },
      loadMore() { runMobileContentSearch(++mobileSearch.requestSeq, mobileSearch.query, currentWorkspaceCwd(), true, { preserveScroll: true }).then(renderPreservingScroll); },
      loadFile(_path) {},
      expandSnippet(_path, _match, _direction) {
        const helper = globalThis.HerdrWorkspaceSearch;
        const opts = helper ? helper.settings() : { contextLines: 2 };
        const current = Number(mobileSearch.content.contextLines ?? opts.contextLines ?? 2);
        mobileSearch.content.contextLines = globalThis.HerdrLineContext && globalThis.HerdrLineContext.nextContextSize
          ? globalThis.HerdrLineContext.nextContextSize(current, { min: 3, max: 20 })
          : Math.min(20, current < 3 ? 3 : current * 2);
        const path = decodeURIComponent(_path || "");
        if (path) mobileSearch.content.expanded[path] = true;
        runMobileContentSearch(++mobileSearch.requestSeq, mobileSearch.query, currentWorkspaceCwd(), false, { preserveExpanded: true, preserveScroll: true }).then(renderPreservingScroll);
      },
    };

    return {
      close,
      open,
      render,
      state: mobileSearch,
    };
  }

  globalThis.HerdrMobileSearchModule = { create: createMobileSearch };
})();