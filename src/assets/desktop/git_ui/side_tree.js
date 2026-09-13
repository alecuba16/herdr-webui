(function () {
  function createGitUiSideTree({ active, esc, arg, currentMode, diffFile, fileListMode, largeSectionFileLimit, titleWithGitShortcut, FileTree }) {
    function section(title, files, kind) {
      const view = active() || {};
      const list = files || [];
      const collapsed = !!((view.collapsedSections || {})[title]);
      const action = sectionBulkAction(title, kind, list);
      const limit = largeSectionFileLimit();
      const limited = limit > 0 && list.length > limit && !((view.expandedLargeSections || {})[title]);
      const visibleList = limited ? list.slice(0, limit) : list;
      const largeNote = limited ? `<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.expandLargeSection('${arg(title)}')"><strong>Show all ${esc(title.toLowerCase())} files</strong></button><p>Showing first ${limit} of ${list.length} files to keep browser responsive.</p></div>` : "";
      return `<div class="git-ui-section"><div class="git-ui-section-head"><button class="git-ui-section-toggle" onclick="HerdrGitUi.toggleSection('${arg(title)}')"><span>${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><strong>${esc(title)}</strong><em>${list.length}</em></button>${action}</div>${collapsed ? "" : `<div class="git-ui-list" role="tree" aria-label="${esc(title)} files">${visibleList.length ? renderFileTree(visibleList, kind, view) : `<div class="git-ui-empty-row">No ${esc(title.toLowerCase())} files</div>`}${largeNote}</div>`}</div>`;
    }

    function sectionBulkAction(title, kind, files) {
      if (!files || !files.length) return "";
      if (kind === "S") return `<button class="git-ui-section-action" title="${esc(titleWithGitShortcut(`Unstage all ${title.toLowerCase()} files`, "unstageFile"))}" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('unstage','${arg(title)}')">−</button>`;
      if (kind === "M" || kind === "?") return `<button class="git-ui-section-action" title="${esc(titleWithGitShortcut(`Stage all ${title.toLowerCase()} files`, "stageFile"))}" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('stage','${arg(title)}')">+</button>`;
      return "";
    }

    function treeIcon(name) {
      const safe = ["chevron-right", "chevron-down", "folder"].includes(name) ? name : "file";
      return `<span class="git-tree-icon git-tree-icon-${safe}" aria-hidden="true"></span>`;
    }

    function renderFileTree(files, kind, view, options) {
      const overrides = options || {};
      const selectMethod = overrides.selectMethod || "selectFile";
      const selectedPath = overrides.selectedPath !== undefined ? overrides.selectedPath : view.file;
      const selectedKind = overrides.selectedKind !== undefined ? overrides.selectedKind : view.diffKind;
      const metaForPath = overrides.metaForPath !== undefined ? overrides.metaForPath : fileSummary;
      const statusForPath = overrides.statusForPath !== undefined ? overrides.statusForPath : fileTreeStatus;
      if (FileTree && FileTree.renderPathTree) {
        return FileTree.renderPathTree(files, {
          callback: "HerdrGitUi",
          toggleMethod: "toggleDir",
          selectMethod,
          activateMethod: "activateTreeItem",
          contextMethod: "fileMenu",
          dirContextKind: "dir",
          dataPrefix: "git",
          rowClass: "git-ui-file",
          dirClass: "git-ui-file git-ui-dir",
          kind,
          selectedPath,
          selectedKind,
          collapsedDirs: view.collapsedDirs || {},
          expandedCompactDirs: view.expandedCompactDirs || {},
          expandCompactMethod: "expandCompactDir",
          filterTerm: view.fileFilter || "",
          metaForPath,
          statusForPath,
        });
      }
      if (fileListMode() === "flat") return renderFlatFileList(files, kind, view, selectMethod, selectedPath, metaForPath);
      const root = { dirs: new Map(), files: [] };
      for (const file of files) {
        const parts = String(file).split("/").filter(Boolean);
        let node = root;
        for (const part of parts.slice(0, -1)) {
          if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
          node = node.dirs.get(part);
        }
        node.files.push({ name: parts[parts.length - 1] || file, path: file });
      }
      return renderTreeNode(root, "", kind, view, 0, selectMethod, selectedPath, metaForPath);
    }

    function renderFlatFileList(files, kind, view, selectMethod, selectedPath, metaForPath) {
      return (files || [])
        .slice()
        .sort((a, b) => pathBasename(a).localeCompare(pathBasename(b)) || String(a).localeCompare(String(b)))
        .map((file) => renderSideFile(file, pathBasename(file), kind, view, 0, selectMethod, selectedPath, metaForPath))
        .join("");
    }

    function pathBasename(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      return parts[parts.length - 1] || String(path || "");
    }

    function renderTreeNode(node, path, kind, view, level, selectMethod, selectedPath, metaForPath) {
      const entries = [
        ...Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([dir, child]) => ({ type: "dir", name: dir, child })),
        ...node.files.sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({ type: "file", name: file.name, path: file.path })),
      ];
      return entries.map((entry) => {
        if (entry.type === "dir") {
          const dirPath = path ? `${path}/${entry.name}` : entry.name;
          const collapsed = !!((view.collapsedDirs || {})[dirPath]);
          return `<div class="git-ui-file git-ui-dir" role="treeitem" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" style="--level:${level}" onclick="HerdrGitUi.toggleDir('${arg(dirPath)}')" onkeydown="HerdrGitUi.activateTreeItem(event)"><span class="git-ui-tree-caret">${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><span class="git-ui-tree-icon folder">${treeIcon("folder")}</span><span class="git-ui-path">${esc(entry.name)}</span></div>${collapsed ? "" : renderTreeNode(entry.child, dirPath, kind, view, level + 1, selectMethod, selectedPath, metaForPath)}`;
        }
        return renderSideFile(entry.path, entry.name, kind, view, level, selectMethod, selectedPath, metaForPath);
      }).join("");
    }

    function renderSideFile(file, name, kind, view, level, selectMethod, selectedPath, metaForPath) {
      const method = selectMethod || "selectFile";
      const activePath = selectedPath !== undefined ? selectedPath : view.file;
      const metaFn = metaForPath !== undefined ? metaForPath : fileSummary;
      const summary = metaFn ? metaFn(file, kind) : "";
      return `<div class="git-ui-file ${activePath === file ? "active" : ""}" role="treeitem" tabindex="0" data-git-path="${esc(file)}" data-git-kind="${esc(kind)}" style="--level:${level}" onclick="HerdrGitUi.${method}('${arg(file)}','${kind}')" onkeydown="HerdrGitUi.activateTreeItem(event)" oncontextmenu="return HerdrGitUi.fileMenu(event,'${arg(file)}','${kind}')"><span class="git-ui-tree-caret"></span><span class="git-ui-tree-icon file">${treeIcon("file")}</span><span class="git-ui-path" title="${esc(file)}">${FileTree && FileTree.highlight ? FileTree.highlight(name, (active() || {}).fileFilter) : esc(name)}</span><span class="git-ui-file-meta">${summary}</span></div>`;
    }

    function dirMenuTargetPaths(menu) {
      const view = active() || {};
      const status = view.status || {};
      const dir = String(menu.file || "").replace(/\/+$/, "");
      if (!dir) return [];
      const prefix = `${dir}/`;
      return [...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || []), ...(status.conflicted || [])]
        .map((path) => String(path || ""))
        .filter((path) => path === dir || path === `${dir}/` || path.startsWith(prefix))
        .filter((path, index, all) => all.indexOf(path) === index);
    }

    function renderDirContextMenu(menu) {
      const dir = String(menu.file || "");
      const targets = dirMenuTargetPaths(menu);
      const count = targets.length;
      const countLabel = count === 1 ? "1 file" : `${count} files`;
      // Folder mutations target the working tree, so they only make sense in
      // the changes view. Compare and stash trees keep their dir menus read-only,
      // matching file rows which hide mutations outside changes mode.
      const mutable = currentMode() === "changes";
      const actions = [];
      actions.push(`<button onclick="HerdrGitUi.menuAction('showInExplorer')">Show in file explorer</button>`);
      actions.push(`<button onclick="HerdrGitUi.menuAction('showHistory')">Show history</button>`);
      if (count && mutable) {
        actions.push(`<button onclick="HerdrGitUi.menuAction('stage')">Stage folder (${countLabel})</button>`);
        actions.push(`<button onclick="HerdrGitUi.menuAction('unstage')">Unstage folder (${countLabel})</button>`);
        actions.push(`<button onclick="HerdrGitUi.menuAction('discard')">Discard folder (${countLabel})</button>`);
      }
      return `<div class="git-ui-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${actions.join("")}</div>`;
    }

    function renderGitViewTabs(tabs, activeTab) {
      return `<div class="git-ui-view-toggle-group" role="tablist" aria-label="Git views">${tabs.map((tab) => {
        const disabled = tab.disabled ? " disabled" : "";
        const title = tab.disabled ? ` title="${esc(tab.disabledReason || "Unavailable")}"` : "";
        const onclick = tab.disabled ? "" : ` onclick="HerdrGitUi.tab('${tab.id}')"`;
        return `<button class="git-ui-view-toggle ${tab.id === "cleanup" ? "git-ui-cleanup-tab" : ""} ${activeTab === tab.id ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === tab.id ? "true" : "false"}"${title}${onclick}${disabled}>${tab.label}</button>`;
      }).join("")}</div>`;
    }

    function hasStagedChanges(view) {
      const status = (view && view.status) || {};
      return (status.staged || []).length > 0;
    }

    function stashCount(view) {
      return Math.max(0, Number(((view && view.status) || {}).stashes || 0));
    }

    function canOpenStashView(view) {
      return stashCount(view) > 0;
    }

    function commitPreviewFile(path) {
      const preview = ((active() || {}).selectedCommitPreview) || {};
      return ((preview.diff && preview.diff.files) || []).find((file) => file.path === path);
    }

    function commitPreviewSection(view, filter) {
      const selected = view.selectedLogCommits || [];
      if (view.tab !== "log" || selected.length !== 1) return "";
      const preview = view.selectedCommitPreview || {};
      const label = selected[0].slice(0, 12);
      if (preview.loading) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Committed files</strong><em>${esc(label)}</em></div><div class="git-ui-empty-row">Loading commit files…</div></div>`;
      if (preview.error) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Committed files</strong><em>${esc(label)}</em></div><div class="git-ui-error">${esc(preview.error)}</div></div>`;
      const files = ((preview.diff && preview.diff.files) || []).map((file) => file.path);
      return section(`Committed files ${label}`, filterFiles(files, filter), "C");
    }

    function stashListHtml(view) {
      const stashes = view.stashData && view.stashData.stashes ? view.stashData.stashes : [];
      const items = stashes.map((s) => {
        const name = String(s.name || "");
        const selected = view.selectedStash === name ? " active" : "";
        const meta = [s.date, s.message].filter(Boolean).map((v) => esc(v)).join(" · ");
        return `<div class="git-ui-stash-entry${selected}" data-stash-name="${esc(name)}" onclick="HerdrGitUi.selectStash('${arg(name)}')"><span class="git-ui-stash-name">${esc(name)}</span><span class="git-ui-stash-meta">${meta}</span></div>`;
      }).join("");
      return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Stashes</strong><em>${esc(String(stashes.length))}</em></div><div class="git-ui-list git-ui-stash-list">${items || `<div class="git-ui-empty-row">No stashes</div>`}</div></div>`;
    }

    function stashFileSection(view, filter) {
      const name = view.selectedStash;
      if (!name) return "";
      const preview = view.selectedStashDiff;
      const label = String(name).replace(/^stash@\{(\d+)\}$/, "stash $1");
      if (preview && preview.loading) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Stash files</strong><em>${esc(label)}</em></div><div class="git-ui-empty-row">Loading stash files…</div></div>`;
      if (preview && preview.error) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Stash files</strong><em>${esc(label)}</em></div><div class="git-ui-error">${esc(preview.error)}</div></div>`;
      const files = (preview && preview.diff && preview.diff.files) ? preview.diff.files.map((f) => f.path) : [];
      const filtered = filterFiles(files, filter);
      return stashFileSectionList(`Stash files ${label}`, filtered, view);
    }

    function stashFileSectionList(title, files, view) {
      const list = files || [];
      const collapsed = !!((view.collapsedSections || {})[title]);
      const limit = largeSectionFileLimit();
      const limited = limit > 0 && list.length > limit && !((view.expandedLargeSections || {})[title]);
      const visibleList = limited ? list.slice(0, limit) : list;
      const largeNote = limited ? `<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.expandLargeSection('${arg(title)}')"><strong>Show all ${esc(title.toLowerCase())} files</strong></button><p>Showing first ${limit} of ${list.length} files to keep browser responsive.</p></div>` : "";
      const body = visibleList.length ? renderFileTree(visibleList, "C", view, { selectMethod: "selectStashFile", selectedPath: view.stashFile, selectedKind: "", metaForPath: null, statusForPath: null }) : `<div class="git-ui-empty-row">No files in this stash</div>`;
      return `<div class="git-ui-section"><div class="git-ui-section-head"><button class="git-ui-section-toggle" onclick="HerdrGitUi.toggleSection('${arg(title)}')"><span>${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><strong>${esc(title)}</strong><em>${list.length}</em></button></div>${collapsed ? "" : `<div class="git-ui-list" role="tree" aria-label="${esc(title)} files">${body}${largeNote}</div>`}</div>`;
    }

    function fileSummary(path, kind) {
      const files = fileSummaryEntries(path, kind);
      const status = fileTreeStatus(path, kind);
      const icon = status === "added" || status === "untracked" ? "+" : status === "deleted" ? "−" : status === "conflict" ? "!" : "✎";
      const cls = status === "added" || status === "untracked" ? "add" : status === "deleted" ? "del" : status === "conflict" ? "conflict" : "edit";
      const totals = files.reduce((total, entry) => {
        const additions = Number(entry.additions);
        const deletions = Number(entry.deletions);
        if (Number.isFinite(additions)) total.additions += additions;
        if (Number.isFinite(deletions)) total.deletions += deletions;
        return total;
      }, { additions: 0, deletions: 0 });
      const hasCounts = files.some((entry) => Number.isFinite(Number(entry.additions)) || Number.isFinite(Number(entry.deletions)));
      const counts = hasCounts ? `<span class="git-ui-file-counts"><b>+${totals.additions}</b><i>-${totals.deletions}</i></span>` : "";
      return `<span class="git-ui-file-summary"><span class="git-ui-file-icon ${cls}">${icon}</span>${counts}</span>`;
    }

    function fileSummaryEntries(path, kind) {
      const exact = fileSummaryForPath(path, kind);
      if (exact) return [exact];
      const prefix = `${String(path || "").replace(/\/+$/, "")}/`;
      return filesForKind(kind)
        .filter((file) => String(file || "").startsWith(prefix))
        .map((file) => fileSummaryForPath(file, kind))
        .filter(Boolean);
    }

    function fileSummaryForPath(path, kind) {
      const view = active() || {};
      const statusSummaries = ((view.status || {}).summaries) || {};
      const summary = kind === "S" ? (statusSummaries.staged || {})[path] : kind === "M" ? (statusSummaries.unstaged || {})[path] : null;
      return (kind === "C" ? commitPreviewFile(path) : null) || diffFile(path) || summary || null;
    }

    function filesForKind(kind) {
      const view = active() || {};
      const status = view.status || {};
      if (kind === "S") return status.staged || [];
      if (kind === "M") return status.unstaged || [];
      if (kind === "?") return status.untracked || [];
      if (kind === "U") return status.conflicted || [];
      if (kind === "C") {
        if (view.tab === "log") return (((view.selectedCommitPreview || {}).diff || {}).files || []).map((file) => file.path);
        if (view.compareFilePaths && view.compareFilePaths.length) return view.compareFilePaths;
        return ((view.diff && view.diff.files) || []).map((file) => file.path);
      }
      return [];
    }

    function fileTreeStatus(path, kind) {
      const entries = fileSummaryEntries(path, kind);
      const statuses = entries.map((entry) => normalizeFileTreeStatus(entry.status, kind));
      if (!entries.length) statuses.push(normalizeFileTreeStatus("", kind));
      if (statuses.includes("conflict")) return "conflict";
      if (statuses.includes("deleted")) return "deleted";
      if (statuses.includes("modified")) return "modified";
      if (statuses.includes("changed")) return "changed";
      if (statuses.includes("untracked")) return "untracked";
      if (statuses.includes("added")) return "added";
      return statuses[0] || "modified";
    }

    function normalizeFileTreeStatus(status, kind) {
      const value = String(status || "").toLowerCase();
      if (kind === "U" || value.includes("conflict")) return "conflict";
      if (kind === "?" || value === "untracked") return "untracked";
      if (value === "added" || value === "new") return "added";
      if (value === "deleted" || value === "removed") return "deleted";
      if (value === "renamed" || value === "copied") return "changed";
      return "modified";
    }

    function filterFiles(files, filter) {
      const needle = String(filter || "").trim().toLowerCase();
      if (!needle) return files || [];
      return (files || []).filter((file) => String(file || "").toLowerCase().includes(needle));
    }

    function sideFileCount(view) {
      if (!view) return 0;
      const status = view.status || {};
      if (view.tab === "log") return (((view.selectedCommitPreview || {}).diff || {}).files || []).length;
      if (view.tab === "stash") {
        const stashes = (view.stashData && view.stashData.stashes) ? view.stashData.stashes.length : 0;
        const preview = view.selectedStashDiff;
        const files = (preview && preview.diff && preview.diff.files) ? preview.diff.files.length : 0;
        return stashes + files;
      }
      if (view.temporaryHistoryCompare && view.file) return 1;
      if (currentMode() === "changes") {
        return [status.conflicted, status.staged, status.unstaged, status.untracked]
          .reduce((total, list) => total + ((list || []).length), 0);
      }
      const compared = view.compareFilePaths && view.compareFilePaths.length
        ? view.compareFilePaths
        : ((view.diff && view.diff.files) || []).map((file) => file.path);
      return (compared || []).length;
    }

    return {
      section,
      sectionBulkAction,
      treeIcon,
      renderFileTree,
      renderFlatFileList,
      pathBasename,
      renderTreeNode,
      renderSideFile,
      dirMenuTargetPaths,
      renderDirContextMenu,
      renderGitViewTabs,
      hasStagedChanges,
      stashCount,
      canOpenStashView,
      commitPreviewFile,
      commitPreviewSection,
      stashListHtml,
      stashFileSection,
      stashFileSectionList,
      fileSummary,
      fileSummaryEntries,
      fileSummaryForPath,
      filesForKind,
      fileTreeStatus,
      normalizeFileTreeStatus,
      filterFiles,
      sideFileCount
    };
  }

  globalThis.HerdrGitUiSideTreeModule = { create: createGitUiSideTree };
})();
