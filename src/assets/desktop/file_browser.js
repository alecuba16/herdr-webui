(function () {
  const Tree = window.HerdrFileTree;
  // Phase 3b split: this module is the sidebar tree plus the per-file
  // editor registry. Files open as center editor tabs (workspace_panes.js
  // owns the tab identity); per-file editor state (content, draft, dirty,
  // editing, CodeMirror instance) lives here, keyed `${wsKey}|${path}`,
  // independent of which tree row is selected. The tree no longer has a
  // selected-file concept and no longer renders a center preview surface.
  const stateCache = {};
  // Per-workspace editor instance cache (IDE-review C4): CodeMirror views
  // are expensive to create, so the editor mount reattaches the cached
  // editor DOM node when the file's editor signature (content,
  // editability, preview mode, search highlight, editor options) is
  // unchanged instead of recreating the instance.
  const editorCache = new Map();
  const fileStates = new Map();
  let activeKey = "";
  let state = createState();

  function createState(initial) {
    return Object.assign({ open: false, cwd: "", root: "", home: "", path: "", entries: [], children: {}, expanded: {}, loading: {}, error: "", permissionRequired: false, contextMenu: null, refreshing: false, gitStatus: null }, initial || {});
  }

  function esc(value) { return Tree.esc(value); }
  const hashId = HerdrAppHelpers.hashId;
  function arg(value) { return Tree.arg(value); }

  function gitStatusEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserGitStatus !== false;
    } catch (_) { return true; }
  }

  function lineNumbersEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserLineNumbers !== false;
    } catch (_) { return true; }
  }

  function editorOptions() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
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
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserAllowParent === true;
    } catch (_) { return false; }
  }

  function cacheTreeRoots(target, data) {
    if (!target || !data) return;
    if (data.root) target.root = String(data.root);
    if (data.home) target.home = String(data.home);
  }

  function normalizeDisplayPath(path) {
    return String(path || "").replace(/\/+/g, "/");
  }

  function absoluteFilePath(path) {
    const value = String(path || "");
    if (!value) return normalizeDisplayPath(state.root || state.cwd || "");
    if (value === "~" || value.startsWith("~/") || value.startsWith("/")) return normalizeDisplayPath(value);
    const root = String(state.root || state.cwd || "").replace(/\/+$/, "");
    if (!root || root === "/") return normalizeDisplayPath(`/${value.replace(/^\/+/, "")}`);
    return normalizeDisplayPath(`${root}/${value.replace(/^\/+/, "")}`);
  }

  function fileTabTooltipPath(path) {
    const absolute = absoluteFilePath(path);
    const home = normalizeDisplayPath(state.home || "").replace(/\/+$/, "");
    if (home && absolute === home) return "~";
    if (home && absolute.startsWith(`${home}/`)) return `~/${absolute.slice(home.length + 1)}`;
    return absolute;
  }

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.open) render();
  });
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest ? event.target : event.target && event.target.parentElement;
    const button = target && target.closest && target.closest(".file-browser-menu [data-file-menu-action]");
    if (!button) return undefined;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    return handleMenuAction(button.dataset.fileMenuAction);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!state.open || !state.contextMenu || event.key !== "Escape") return;
    event.preventDefault();
    state.contextMenu = null;
    render();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!state.open || !state.contextMenu || !event || event.defaultPrevented) return;
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    const items = Array.from(document.querySelectorAll('.file-browser-menu [role="menuitem"]') || []);
    if (!items.length) return;
    event.preventDefault();
    const active = items.find((b) => b === document.activeElement);
    const delta = key === "ArrowDown" ? 1 : -1;
    const activeIndex = items.indexOf(active);
    let index;
    if (key === "Home") index = 0;
    else if (key === "End") index = items.length - 1;
    else if (activeIndex < 0) index = key === "ArrowDown" ? 0 : items.length - 1;
    else index = (activeIndex + delta + items.length) % items.length;
    const target = items[index];
    if (target && typeof target.focus === "function") target.focus();
  }, true);

  // Cmd/Ctrl-S saves the active editor tab. Editor tabs live in the center
  // pane regardless of the sidebar's visibility, so this runs whenever the
  // module is loaded, not only while the tree column is open. The pane tree
  // records the active file; the focused mount is the fallback for when a
  // non-active editor somehow holds focus (split views, Phase 4).
  window.addEventListener("keydown", (event) => {
    if (!event || event.defaultPrevented || event.altKey || event.shiftKey) return;
    const key = String(event.key || "").toLowerCase();
    if (key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    const path = activeEditorPath() || focusedFilePath(event.target);
    const file = path ? fileFor(path) : null;
    if (!file || file.binary || file.truncated) return;
    event.preventDefault();
    event.stopPropagation();
    if (file.saving) return;
    saveFile(file.path);
  }, true);

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    if (window.HerdrWorkspacePath) return window.HerdrWorkspacePath(workspace);
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    return workspace.cwd || workspace.path || "";
  }

  function workspaceKey(workspace) {
    if (typeof workspace === "string") return workspace;
    return (workspace && workspace.workspace_id) || workspaceCwd(workspace) || "default";
  }

  function stopTransientWork(stateToStop) {
    if (!stateToStop) return;
    stateToStop.refreshing = false;
    stateToStop.loading = {};
    stateToStop.contextMenu = null;
  }

  function activateState(key, cwd) {
    stopTransientWork(state);
    if (activeKey && activeKey !== key && stateCache[activeKey]) stateCache[activeKey].open = false;
    activeKey = key;
    if (!stateCache[key]) stateCache[key] = createState({ cwd });
    state = stateCache[key];
    state.cwd = cwd || state.cwd;
    stopTransientWork(state);
  }

  function renderIfActive(target, preserveScroll) {
    if (state !== target || !target.open) return;
    if (preserveScroll) renderPreservingScroll();
    else render();
  }

  function ensurePanel() {
    let panel = document.getElementById("fileBrowserPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fileBrowserPanel";
      panel.className = "file-browser-panel";
    }
    return panel;
  }

  async function hostPanel(workspace) {
    if (window.HerdrSearchPanel) window.HerdrSearchPanel.close();
    if (window.HerdrRightSidebar)
      await window.HerdrRightSidebar.openView("files", workspace, ensurePanel);
  }

  async function api(url, opt) {
    // Shared client keeps session/backend headers and 401 handling uniform.
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url, opt);
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  function setError(target, error) {
    const permissionRequired = !!(error.details && error.details.permission_required);
    target.permissionRequired = permissionRequired;
    target.error = permissionRequired
      ? "Herdr needs folder access to browse or search this folder."
      : error.message || String(error);
  }

  async function open(workspace, options) {
    const openOptions = options || {};
    const cwd = workspaceCwd(workspace);
    const key = workspaceKey(workspace);
    if (state.open && activeKey === key && !openOptions.forceOpen) {
      hide();
      return;
    }
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    activateState(key, cwd);
    state.open = true;
    // Desktop host takes the panel into the right sidebar column before
    // the first render so the tree renders hosted from the start. Test
    // harnesses and temp overlays fall back to the legacy surface
    // (openView returns "legacy"). forceOpen only bypasses the rail's
    // collapse toggle; it does not change where the panel mounts.
    await hostPanel(workspace);
    render();
    await loadTree(state.path || "");
  }

  // openAt is the single entry point for every external file/dir open:
  // search palette results, git-ui showInExplorer. Dirs steer the sidebar
  // tree; files open as a center editor tab.
  async function openAt(workspace, path, opts) {
    const options = opts || {};
    const cwd = workspaceCwd(workspace);
    const key = workspaceKey(workspace);
    if (!cwd) return;
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    await hostPanel(workspace);
    if (window.rememberWorkspaceShellMode) window.rememberWorkspaceShellMode("files", workspace);
    if (window.syncShellModeButtons) window.syncShellModeButtons();
    activateState(key, cwd);
    state.open = true;
    if (options.kind === "dir") {
      render();
      await loadTree(path || "");
      return;
    }
    if (!path) return;
    // Files opened through external entry points (search results, git-ui)
    // get the same pane-strip tab a tree click creates: route through the
    // panes funnel so paneEnsureEditorTab registers the tab before the
    // mount. Harnesses without the panes module keep the direct mount.
    const panes = window.HerdrWorkspacePanes;
    if (panes && panes.openEditorTab) {
      await panes.openEditorTab(path, options.highlight || null);
      return;
    }
    await openEditorTab(path, options.highlight || null);
  }

  function hide() {
    stopTransientWork(state);
    state.open = false;
    const panel = document.getElementById("fileBrowserPanel");
    if (panel) panel.remove();
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  function forgetWorkspace(workspace) {
    const key = workspaceKey(workspace);
    const cached = stateCache[key];
    stopTransientWork(cached);
    for (const cacheKey of Array.from(editorCache.keys())) {
      if (cacheKey.startsWith(`${key}|`)) forgetEditor(cacheKey.slice(key.length + 1));
    }
    for (const stateKey of Array.from(fileStates.keys())) {
      if (stateKey.startsWith(`${key}|`)) fileStates.delete(stateKey);
    }
    delete stateCache[key];
    if (activeKey !== key) return;
    state.open = false;
    activeKey = "";
    state = createState();
    const panel = document.getElementById("fileBrowserPanel");
    if (panel) panel.remove();
  }

  async function fetchEntries(path, target = state) {
    if (!target.cwd) return;
    const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path || "")}&depth=0${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
    cacheTreeRoots(target, data);
    return data.entries || [];
  }

  async function loadTree(path, preserveFocus = false) {
    const target = state;
    if (!target.cwd) return;
    target.refreshing = true;
    renderIfActive(target, preserveFocus);
    try {
      target.error = "";
      target.permissionRequired = false;
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path || "")}&depth=0${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      cacheTreeRoots(target, data);
      target.path = data.path || "";
      target.entries = data.entries || [];
      target.gitStatus = data.git_status || null;
      target.children = {};
      target.expanded = {};
      target.loading = {};
    } catch (error) {
      setError(target, error);
    }
    target.refreshing = false;
    renderIfActive(target, preserveFocus);
  }

  function renderPreservingScroll() {
    const side = document.querySelector(".file-browser-side");
    const top = side ? side.scrollTop : 0;
    const active = document.activeElement;
    const refocusSide = !!(side && active === side);
    render();
    const next = document.querySelector(".file-browser-side");
    if (next) next.scrollTop = top;
    if (refocusSide && next) next.focus({ preventScroll: true });
  }

  // ---- per-file editor registry -------------------------------------------
  // fileFor/fileStates hold one entry per open editor tab, keyed
  // `${wsKey}|${path}`. The pane tree owns the tab list; this registry is
  // the state the panes strip reads for dirty dots.

  function fileStateKey(path) {
    return `${activeKey}|${path}`;
  }

  function fileFor(path) {
    return fileStates.get(fileStateKey(path)) || null;
  }

  function ensureFileState(path) {
    const key = fileStateKey(path);
    let file = fileStates.get(key);
    if (!file) {
      file = { path, content: "", draft: "", hash: "", editing: false, dirty: false, saving: false, error: "", searchHighlight: null, previewSource: false, binary: false, truncated: false, partialPreview: false, linesHtml: null, size: 0 };
      fileStates.set(key, file);
    }
    return file;
  }

  function openEditorTabs() {
    // Tab list comes from the pane tree; the registry answers for state.
    // Every leaf, not just the active one: LSP refresh and external-change
    // checks must cover files in any pane.
    const panes = window.HerdrWorkspacePanes;
    if (!panes) return [];
    const roots = panes.paneLeaves ? panes.paneLeaves(panes.paneRoot()) : [panes.paneRoot()];
    return roots
      .flatMap((leaf) => leaf && leaf.tabs ? leaf.tabs : [])
      .map((tabId) => panes.editorTabPath(tabId))
      .filter(Boolean)
      .map((path) => fileFor(path))
      .filter(Boolean);
  }

  function activeEditorPath() {
    const panes = window.HerdrWorkspacePanes;
    if (!panes) return "";
    return panes.editorTabPath(panes.paneActiveTab(panes.paneRoot()));
  }

  // ---- editor tab open/close (called by workspace_panes) ------------------
  // openEditorTab loads the file, mounts the editor container into the
  // active pane's content slot, and marks the pane tab active. The dirty
  // confirm on close keeps the legacy open-file wording.

  // Whether the pane tree still holds the editor tab for path. The open
  // path awaits a fetch: the tab can be closed mid-flight, and mounting
  // after that would resurrect the active pointer for a strip tab that
  // no longer exists. The tree owns tab identity, so it is the arbiter:
  // no pane module (mobile parity paths) keeps the old always-open
  // behavior, but a present tree with no leaf holding the id is closed.
  function editorTabStillOpen(path) {
    const panes = window.HerdrWorkspacePanes;
    if (!panes || !panes.paneRoot) return true;
    try {
      const root = panes.paneRoot();
      if (!root) return true;
      const leaves = panes.paneLeaves ? panes.paneLeaves(root) : [root];
      const tabId = panes.editorTabId(path);
      return leaves.some((leaf) => leaf && leaf.tabs && leaf.tabs.includes(tabId));
    } catch (_) {
      return true;
    }
  }

  async function openEditorTab(path, searchHighlight) {
    const target = state;
    try {
      target.error = "";
      target.permissionRequired = false;
      const existing = fileFor(path);
      if (existing) {
        existing.searchHighlight = searchHighlight || null;
        // Search matches must stay usable when the markdown file is open
        // in rendered preview: force the source view so the highlight
        // line is visible.
        if (searchHighlight) existing.previewSource = true;
        await mountEditorTab(path);
        return;
      }
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path)}&render=lines`);
      // The tab may have been closed while the fetch was in flight: the
      // tree dropped the id, and mounting now would resurrect a ghost
      // active pointer with no strip tab, while recreating file state
      // would undo the closeEditorState teardown. Drop the fetch result;
      // a reopen simply fetches again.
      if (!editorTabStillOpen(path)) return;
      const linesHtml = file.lines_gutter_html != null && file.lines_code_html != null ? { gutter: file.lines_gutter_html, code: file.lines_code_html } : null;
      // Markdown opens read-only so the rendered preview engages; every
      // other file keeps the edit-by-default behavior. Search highlights
      // force the source view so the matches stay visible.
      const isMarkdown = markdownPath(path);
      const editing = !isMarkdown;
      const entry = ensureFileState(path);
      Object.assign(entry, {
        content: file.content || "",
        draft: file.content || "",
        hash: file.hash || "",
        editing,
        dirty: false,
        saving: false,
        error: "",
        searchHighlight: searchHighlight || null,
        previewSource: !!searchHighlight,
        binary: !!file.binary,
        truncated: !!file.truncated,
        partialPreview: false,
        linesHtml,
        size: Number(file.size) || 0,
      });
      await mountEditorTab(path);
    } catch (error) {
      setError(target, error);
      // The tab strip placeholder is dropped by the caller on failure when
      // the file never got state; surface the error on the tree column.
      renderIfActive(target, true);
    }
  }

  // Mounts the editor container for path into the active pane content slot
  // and marks the pane tab active. The container persists per file (one
  // DOM node per open tab, hidden when inactive) so CodeMirror keeps its
  // scroll and cursor when switching tabs.
  async function mountEditorTab(path) {
    const panes = window.HerdrWorkspacePanes;
    if (!panes || !panes.renderWorkspacePanes) return;
    // Ensure the strip shows the tab before the mount so the signature
    // gate does not clear the just-added button.
    panes.setActivePaneTab(panes.editorTabId(path));
    // The mount follows the tab's owning pane: a strip click on another
    // pane focuses that pane first, and the container must land there.
    const pane = (panes.paneElementForTab && panes.paneElementForTab(panes.editorTabId(path)))
      || (panes.activePaneElement && panes.activePaneElement())
      || document.querySelector("#workspacePanes .workspace-pane");
    const content = pane && pane.querySelector(".pane-content");
    if (!content) return;
    let container = document.getElementById(paneEditorMountId(path));
    if (!container) {
      container = document.createElement("section");
      container.id = paneEditorMountId(path);
      container.className = "pane-editor-container";
      container.dataset.path = path;
    }
    // Splits park rescued containers in #workspacePanes: re-parent into
    // the active leaf's content slot on every mount so an editor opened
    // after a split lands in the pane the strip points at.
    if (container.parentElement !== content) content.appendChild(container);
    // Hide every other editor container; the active tab owns the slot.
    content.querySelectorAll(".pane-editor-container").forEach((node) => {
      if (node !== container) node.style.display = "none";
      else node.style.display = "";
    });
    renderEditorInto(container, path);
    renderIfActive(state, true);
  }

  function renderEditorInto(container, path) {
    const file = fileFor(path);
    if (!file) return;
    const configured = editorOptions();
    container.innerHTML = editorPlaceholderHtml(file);
    if (file.binary || (file.truncated && !file.partialPreview)) return;
    mountCodeMirror(container, file, configured);
  }

  function editorPlaceholderHtml(file) {
    if (file.binary) return '<div class="file-browser-empty">Binary file preview unavailable.</div>';
    if (file.truncated) {
      // A4: oversize text files offer a backend partial read instead of a
      // dead end. Editing stays blocked.
      if (file.partialPreview) return "";
      return `<div class="file-browser-empty">File too large to preview (${Tree.formatBytes(file.size)}).<button class="git-ui-btn file-browser-load-partial" onclick="HerdrFileBrowser.loadPartial('${arg(file.path)}')">Load first 256 KB</button></div>`;
    }
    return "";
  }

  function editorSignature(file, configured) {
    return JSON.stringify({
      content: file.editing ? file.draft : file.content || "",
      editing: !!file.editing,
      previewSource: !!file.previewSource,
      searchHighlight: file.searchHighlight || null,
      lineNumbers: lineNumbersEnabled(),
      options: configured,
      linesHtml: file.linesHtml || null,
    });
  }

  function forgetEditor(path) {
    const key = editorCacheKey(path);
    const entry = editorCache.get(key);
    if (!entry) return;
    editorCache.delete(key);
    if (entry.api && entry.api.destroy) {
      try { entry.api.destroy(); } catch (_) {}
    }
  }

  function editorCacheKey(path) {
    return `${activeKey}|${path}`;
  }

  function mountCodeMirror(parent, file, configured) {
    const signature = editorSignature(file, configured);
    const cacheKey = editorCacheKey(file.path);
    const cached = editorCache.get(cacheKey);
    const mountPoint = ensureEditorMountPoint(parent);
    // Only an editor-bearing wrapper can be reattached. The first mount in
    // a session can race the lazy CodeMirror load: HerdrEditor.create()
    // returns a loading shell and replaces it later. Cache entries are
    // written at onReady (after that swap), so a well-formed entry is safe;
    // the structural loading-shell check below is the belt-and-braces guard
    // against any entry written before the swap.
    const cachedIsUsable = cached && cached.signature === signature && cached.mount
      && (cached.editorReady === true
        || !(cached.mount.querySelector && cached.mount.querySelector(".herdr-editor-loading")));
    if (cachedIsUsable) {
      // Same content, editability, and options: reattach the existing
      // editor DOM (and its listeners) instead of recreating the instance.
      try { mountPoint.appendChild(cached.mount); } catch (_) { editorCache.delete(cacheKey); return; }
      if (cached.api && cached.api.attach) cached.api.attach(mountPoint);
      else mountPoint._herdrEditorApi = cached.api;
      return;
    }
    forgetEditor(file.path);
    const partialPreview = !!(file.truncated && file.partialPreview);
    window.HerdrEditor.create({
      parent: mountPoint,
      path: file.path,
      content: file.editing && !partialPreview ? file.draft : file.content || "",
      readonly: !file.editing || partialPreview,
      editorEnabled: configured.editorEnabled,
      hideHeader: true,
      // The pane strip's find control replaces the in-editor floating
      // toggle (the strip is where pane-level controls live).
      hideFindToggle: true,
      lineNumbers: lineNumbersEnabled(),
      wordWrap: configured.wordWrap,
      tabSize: configured.tabSize,
      bracketMatching: configured.bracketMatching,
      folding: configured.folding,
      activeLine: configured.activeLine,
      whitespace: configured.whitespace,
      markdownPreview: !file.editing && !file.previewSource && !partialPreview,
      searchHighlight: file.searchHighlight || null,
      linesHtml: file.editing && !partialPreview ? null : file.linesHtml || null,
      size: file.size,
      onChange(value) {
        if (partialPreview) return; // read-only partial view; no draft tracking
        file.draft = value;
        file.dirty = value !== (file.content || "");
        renderPaneStrips();
        lspDidChange(file.path, value);
      },
      onReady() {
        lspRenderDiagnostics(file.path);
        // onReady fires after the lazy CodeMirror mount settled, so the
        // wrapper cached here is the live editor, not the loading shell
        // create() returned. Cache the editor's own wrapper node (not the
        // container). When create() produced no wrapper (plain fallback
        // markup), there is no stable node to reattach; skip caching
        // instead of accidentally reattaching the container itself.
        const wrapper = mountPoint.querySelector(".herdr-editor");
        if (wrapper) editorCache.set(cacheKey, { api: mountPoint._herdrEditorApi, mount: wrapper, signature, editorReady: true });
      },
    });
    lspDidOpen(file);
  }

  // The CodeMirror instance needs one stable mount point inside the
  // per-file container, below the toolbar.
  function ensureEditorMountPoint(container) {
    let mount = container.querySelector(".pane-editor-mount");
    if (!mount) {
      mount = document.createElement("div");
      mount.className = "pane-editor-mount herdr-editor-mount";
      container.appendChild(mount);
    }
    return mount;
  }

  function renderPaneStrips() {
    if (window.HerdrWorkspacePanes && window.HerdrWorkspacePanes.renderWorkspacePanes)
      window.HerdrWorkspacePanes.renderWorkspacePanes();
  }

  function paneEditorMountId(path) {
    return `pane-editor-${hashId(path)}`;
  }

  // Close with the legacy dirty wording. The strip ✕ lands here via the
  // panes module; confirm, then ask the pane tree to drop the tab id via
  // its immediate path (closeEditorTabImmediate, which calls teardownEditorTab
  // below), then finish our own state teardown. The pane-facing entry point
  // must not round-trip back to the strip's closeEditorTab (that loops).
  async function closeEditorTab(encodedPath) {
    let path = encodedPath;
    try { path = decodeURIComponent(encodedPath); }
    catch (_) {}
    const file = fileFor(path);
    if (file && file.dirty && !confirm(`Close ${path} with unsaved changes?`)) return false;
    const panes = window.HerdrWorkspacePanes;
    if (panes && panes.closeEditorTabImmediate) await panes.closeEditorTabImmediate(encodedPath);
    closeEditorState(path);
    return true;
  }

  // Pane tree close callback: teardown of per-file state after the tab id
  // was already removed from the tree. No strip round-trip (that would be
  // a loop); just drop state, editor cache, and the container.
  function closeEditorState(path) {
    lspDidClose(path);
    forgetEditor(path);
    fileStates.delete(fileStateKey(path));
    const container = document.getElementById(paneEditorMountId(path));
    if (container) container.remove();
    renderIfActive(state, true);
  }

  // ── Language server integration ──────────────────────────────────────

  function lspEnabled() {
    if (!window.HerdrLsp) return false;
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.lspEnabled === true;
    } catch (_) {
      return false;
    }
  }

  function lspDidChange(path, value) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didChange(ws, path, value);
  }

  function lspDidOpen(file) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd || file.binary || file.truncated) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didOpen(ws, file.path, file.editing ? file.draft : file.content || "").catch(() => {});
    lspRenderDiagnostics(file.path);
  }

  function lspDidClose(path) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didClose(ws, path).catch(() => {});
  }

  function lspDiagnosticsFor(path) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return [];
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    return window.HerdrLsp.diagnosticsFor(ws, path) || [];
  }

  function refreshLspDiagnostics() {
    if (!lspEnabled()) return;
    for (const file of openEditorTabs()) {
      if (!file.binary && !file.truncated) lspRenderDiagnostics(file.path);
    }
  }

  if (typeof window !== "undefined") {
    window.HerdrLspHooks = window.HerdrLspHooks || [];
    window.HerdrLspHooks.push(function lspFileBrowserHook() {
      refreshLspDiagnostics();
    });
  }

  function lspRenderDiagnostics(path) {
    if (typeof document.querySelectorAll !== "function") return;
    const diagnostics = lspDiagnosticsFor(path);
    const mount = document.getElementById(paneEditorMountId(path));
    if (!mount) return;
    const api = mount._herdrEditorApi;
    if (!api) return;
    const view = api._view;
    const effects = [];
    if (view && view.state) {
      const doc = view.state.doc;
      for (const diagnostic of diagnostics) {
        const range = diagnostic && diagnostic.range;
        if (!range || !range.start) continue;
        const line = Math.max(0, Number(range.start.line) || 0);
        if (line >= doc.lines) continue;
        const from = doc.line(line + 1).from;
        const to = doc.line(line + 1).to;
        const severity = Number(diagnostic.severity) === 1 ? "error" : Number(diagnostic.severity) === 2 ? "warning" : "info";
        effects.push({ from, to, severity, message: diagnostic.message || "" });
      }
    } else if (typeof api.getValue === "function") {
      // Fallback without a live view: approximate offsets by splitting lines.
      const text = String(api.getValue() || "");
      const lines = text.split("\n");
      let offset = 0;
      const lineOffsets = lines.map((text2) => {
        const start = offset;
        offset += text2.length + 1;
        return start;
      });
      for (const diagnostic of diagnostics) {
        const range = diagnostic && diagnostic.range;
        if (!range || !range.start) continue;
        const line = Math.max(0, Number(range.start.line) || 0);
        if (line >= lineOffsets.length) continue;
        const from = lineOffsets[line];
        const to = from + (lines[line] ? lines[line].length : 0);
        const severity = Number(diagnostic.severity) === 1 ? "error" : Number(diagnostic.severity) === 2 ? "warning" : "info";
        effects.push({ from, to, severity, message: diagnostic.message || "" });
      }
    } else {
      return;
    }
    renderDiagnosticsInline(mount, effects);
  }

  function renderDiagnosticsInline(mount, diagnostics) {
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
      .map((d) => `<div class="herdr-lsp-diagnostic ${esc(d.severity)}" data-from="${d.from}" data-to="${d.to}">${esc(d.message)}</div>`)
      .join("");
    list.querySelectorAll(".herdr-lsp-diagnostic").forEach((item) => {
      item.addEventListener("click", () => {
        const mount2 = item.closest(".herdr-editor-mount") || mount;
        const editorApi = (mount2.closest("[id^='pane-editor-']") || mount)._herdrEditorApi;
        if (!editorApi || !editorApi.selectRange) return;
        editorApi.selectRange(Number(item.dataset.from), Number(item.dataset.to));
      });
    });
  }

  function toggleFind(path) {
    const parent = document.getElementById(paneEditorMountId(path));
    if (!parent || !parent._herdrEditorApi || !parent._herdrEditorApi.toggleFind) return;
    parent._herdrEditorApi.toggleFind(true);
  }

  // Find-in-file for the active editor tab; called by the ⌕ shortcut when
  // an editor tab is active.
  function openFindForPath(path) {
    if (!path) return false;
    const parent = document.getElementById(paneEditorMountId(path));
    if (window.HerdrEditor && window.HerdrEditor.openFind && window.HerdrEditor.openFind(parent)) return true;
    return false;
  }

  function focusedFilePath(target) {
    if (!state.open) return "";
    const container = target && target.closest && target.closest(".pane-editor-container");
    if (container && container.getAttribute) {
      try { return decodeURIComponent(container.getAttribute("data-path") || ""); }
      catch (_) { return ""; }
    }
    return "";
  }

  // A4: partial read of an oversized text file. The backend clamps the
  // budget (16 KB..1 MB) and returns truncated=true with the first N bytes;
  // the editor mounts read-only and the save path is unreachable (empty
  // hash can never satisfy the expected_hash check).
  async function loadPartial(path) {
    try {
      state.error = "";
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}&max_bytes=262144`);
      const entry = fileFor(path);
      if (!entry) return;
      Object.assign(entry, {
        content: file.content || "",
        draft: file.content || "",
        hash: "",
        editing: true,
        dirty: false,
        saving: false,
        error: "",
        searchHighlight: null,
        previewSource: true,
        partialPreview: true,
        truncated: true,
        size: Number(file.size) || entry.size || 0,
      });
      entry.linesHtml = file.lines_gutter_html != null && file.lines_code_html != null ? { gutter: file.lines_gutter_html, code: file.lines_code_html } : null;
      await mountEditorTab(path);
    } catch (error) {
      setError(state, error);
      renderIfActive(state, true);
    }
  }

  async function reloadFile(path) {
    const entry = fileFor(path);
    if (!entry) return;
    const keepEditing = !!entry.editing;
    const keepPreviewSource = !!entry.previewSource;
    const next = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}&render=lines`);
    const linesHtml = next.lines_gutter_html != null && next.lines_code_html != null ? { gutter: next.lines_gutter_html, code: next.lines_code_html } : null;
    Object.assign(entry, next, {
      draft: next.content || "",
      editing: keepEditing,
      dirty: false,
      saving: false,
      error: "",
      searchHighlight: entry.searchHighlight || null,
      previewSource: keepPreviewSource,
      // A plain reload is never a partial preview: a still-truncated file
      // falls back to the oversized placeholder, a shrunk file mounts the
      // full editor.
      partialPreview: false,
      linesHtml,
    });
    await mountEditorTab(path);
  }

  async function saveFile(path) {
    const file = fileFor(path);
    if (!file || file.saving || !file.editing) return;
    file.saving = true;
    file.error = "";
    if (typeof showBlocking === "function") showBlocking("Saving file...");
    try {
      const result = await api("/api/file-browser/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path: file.path, content: file.draft, expected_hash: file.hash || "" }),
      });
      file.content = file.draft;
      file.hash = result.hash || file.hash;
      file.dirty = false;
    } catch (error) {
      file.error = error.message || String(error);
    }
    file.saving = false;
    if (typeof hideBlocking === "function") hideBlocking();
    renderPaneStrips();
    renderIfActive(state, true);
  }

  function fileName(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || path || "";
  }

  function mutateTreeForRename(from, to, nextName) {
    // Remap editor cache entries and file state to the renamed path so the
    // cached instance is reused (not recreated) for the renamed file.
    for (const cacheKey of Array.from(editorCache.keys())) {
      if (!cacheKey.startsWith(`${activeKey}|`)) continue;
      const cachedPath = cacheKey.slice(activeKey.length + 1);
      const nextPath = Tree.replacePathPrefix(cachedPath, from, to);
      if (nextPath === cachedPath) continue;
      const entry = editorCache.get(cacheKey);
      editorCache.delete(cacheKey);
      editorCache.set(editorCacheKey(nextPath), entry);
    }
    for (const stateKey of Array.from(fileStates.keys())) {
      if (!stateKey.startsWith(`${activeKey}|`)) continue;
      const filePath = stateKey.slice(activeKey.length + 1);
      const nextPath = Tree.replacePathPrefix(filePath, from, to);
      if (nextPath === filePath) continue;
      const entry = fileStates.get(stateKey);
      fileStates.delete(stateKey);
      entry.path = nextPath;
      fileStates.set(fileStateKey(nextPath), entry);
      const container = document.getElementById(paneEditorMountId(filePath));
      if (container) {
        container.id = paneEditorMountId(nextPath);
        container.dataset.path = nextPath;
      }
    }
    state.entries = Tree.renamePathInEntries(state.entries, from, to, nextName);
    state.children = Tree.remapPathMap(state.children, from, to, (entries) => Tree.renamePathInEntries(entries, from, to, nextName));
    state.expanded = Tree.remapPathMap(state.expanded, from, to);
    state.loading = Tree.remapPathMap(state.loading, from, to);
  }

  function mutateTreeForDelete(path) {
    for (const cacheKey of Array.from(editorCache.keys())) {
      if (!cacheKey.startsWith(`${activeKey}|`)) continue;
      const cachedPath = cacheKey.slice(activeKey.length + 1);
      if (cachedPath === path || cachedPath.startsWith(`${path}/`)) forgetEditor(cachedPath);
    }
    for (const stateKey of Array.from(fileStates.keys())) {
      if (!stateKey.startsWith(`${activeKey}|`)) continue;
      const filePath = stateKey.slice(activeKey.length + 1);
      if (filePath === path || filePath.startsWith(`${path}/`)) {
        fileStates.delete(stateKey);
        const container = document.getElementById(paneEditorMountId(filePath));
        if (container) container.remove();
      }
    }
    state.entries = Tree.removePathFromEntries(state.entries, path);
    state.children = Tree.prunePathMap(state.children, path, (entries) => Tree.removePathFromEntries(entries, path));
    state.expanded = Tree.prunePathMap(state.expanded, path);
    state.loading = Tree.prunePathMap(state.loading, path);
  }

  async function refreshParentAfterMutation(path) {
    const parent = Tree.parentPath(path);
    if (parent === state.path) {
      renderPreservingScroll();
      return;
    }
    if (state.expanded[parent]) {
      try { state.children[parent] = await fetchEntries(parent); }
      catch (error) { state.error = error.message || String(error); }
    }
    renderPreservingScroll();
  }

  async function renamePath(path) {
    const nextName = prompt("Rename to", fileName(path));
    if (!nextName || nextName === fileName(path)) return;
    if (!confirm(`Rename ${path} to ${nextName}?`)) return;
    if (typeof showBlocking === "function") showBlocking("Renaming...");
    try {
      await api("/api/file-browser/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path, new_name: nextName }),
      });
      const parent = Tree.parentPath(path);
      const to = parent ? `${parent}/${nextName}` : nextName;
      mutateTreeForRename(path, to, nextName);
      await refreshParentAfterMutation(to);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function deletePath(path) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    if (typeof showBlocking === "function") showBlocking("Deleting...");
    try {
      await api("/api/file-browser/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path }),
      });
      mutateTreeForDelete(path);
      await refreshParentAfterMutation(path);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function copyPermalink(path) {
    const data = await api(`/api/git-ui/permalink?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}`);
    const url = data && data.url;
    if (!url) throw new Error("permalink URL was empty");
    await navigator.clipboard.writeText(url);
  }

  // Right-click "Open workspace here": resolve the folder, then ask the
  // backend whether it is a git checkout. /api/worktrees?cwd=<dir> returns
  // the worktree rows of the REPO that contains the dir (empty for plain
  // folders), so the dir itself is a checkout only when one row's path
  // matches it. Checkouts open through worktree.open, which focuses an
  // already-open workspace instead of duplicating it; plain folders fall
  // back to workspace create + recents record, like the open modal.
  async function openWorkspaceHere(path) {
    const dir = absoluteFilePath(path);
    if (!dir) return;
    if (typeof showBlocking === "function") showBlocking("Opening folder...");
    let row = null;
    try {
      const data = await api(`/api/worktrees?cwd=${encodeURIComponent(dir)}`);
      const rows = ((data && data.result) || {}).worktrees || [];
      row = rows.find((candidate) => sameMenuPath(candidate.path, dir)) || null;
      if (row) {
        const response = await api("/api/worktrees/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace_id: null, cwd: null, path: row.path, label: null, branch: null, open_terminal: typeof workspaceOpenTerminalFlag === "function" && workspaceOpenTerminalFlag() }),
        });
        navigateToOpenedWorkspace(response);
        return;
      }
      const created = await api("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: Tree.basename(dir) || dir, cwd: dir, open_terminal: typeof workspaceOpenTerminalFlag === "function" && workspaceOpenTerminalFlag() }),
      });
      try {
        await api("/api/recent-workspaces/record", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: dir, label: Tree.basename(dir) || dir }),
        });
      } catch (_) {} // recents are a nice-to-have; the workspace is open
      navigateToOpenedWorkspace(created);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  // worktree.open and workspace.create both answer with the workspace plus
  // its focused tab and root pane; navigating with all three lands directly
  // on a live terminal panel instead of waiting for the next refresh.
  function navigateToOpenedWorkspace(response) {
    const navigate = typeof go === "function" ? go : null;
    if (!navigate) return;
    const result = (response && response.result) || {};
    hide();
    navigate(
      result.workspace && result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  }

  function sameMenuPath(a, b) {
    return String(a || "").replace(/\\/g, "/").replace(/\/+$/, "") === String(b || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  async function showHistoryPath(path) {
    if (!path) return;
    // Phase 3c: file history opens as a center git tab. git_ui lazy-loads,
    // so route through the desktop shell's loader-aware entry point (a
    // session that never opened the Git drawer has no HerdrGitUi yet).
    const cwd = state.cwd || "";
    if (window.HerdrShowFileHistory) {
      hide();
      window.HerdrShowFileHistory(cwd, path);
      return;
    }
    if (!window.HerdrGitUi || !window.HerdrGitUi.openFileHistory) return;
    hide();
    window.HerdrGitUi.openFileHistory(encodeURIComponent(cwd), encodeURIComponent(path));
  }

  async function handleMenuAction(action) {
    const menu = state.contextMenu;
    if (!menu) return;
    state.contextMenu = null;
    try {
      if (action === "enter") await loadTree(menu.path);
      if (action === "openWorkspaceHere") { if (menu.kind === "dir") await openWorkspaceHere(menu.path); return; }
      if (action === "history") { showHistoryPath(menu.path); return; }
      if (action === "rename") await renamePath(menu.path);
      if (action === "delete") await deletePath(menu.path);
      if (action === "copyPermalink") await copyPermalink(menu.path);
      if (action === "copyPath") await navigator.clipboard.writeText(`${state.cwd}/${menu.path}`);
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      if (state.open) render();
    }
  }

  // ── A6: external-change awareness ────────────────────────────────────
  // When the window regains focus (tab refocus, Cmd+Tab back), re-hash the
  // open files via the cheap hash_only endpoint. If a file changed on disk
  // while we hold no local edits, offer a reload prompt. Dirty files are
  // skipped: their draft is newer than disk and the save path already
  // surfaces hash mismatches.
  let a6CheckInFlight = false;
  async function checkOpenFilesForExternalChanges() {
    if (a6CheckInFlight) return;
    const candidates = openEditorTabs().filter((file) => file && !file.dirty && !file.truncated && file.hash);
    if (!candidates.length) return;
    a6CheckInFlight = true;
    try {
      for (const file of candidates) {
        let remote = null;
        try {
          remote = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(file.path)}&hash_only=true`);
        } catch (_) { continue; } // deleted or unreadable: leave the tab alone
        const fresh = fileFor(file.path);
        if (!fresh || fresh.dirty) continue;
        if (remote && remote.hash && remote.hash !== fresh.hash) {
          if (confirm(`${file.path}\nchanged on disk. Reload?`)) await reloadFile(file.path);
        }
      }
    } finally {
      a6CheckInFlight = false;
    }
  }
  if (typeof document !== "undefined" && document.addEventListener && !document.__herdrA6FocusWatcher) {
    document.__herdrA6FocusWatcher = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkOpenFilesForExternalChanges();
    });
    window.addEventListener("focus", checkOpenFilesForExternalChanges);
  }

  function render() {
    if (!state.open) return;
    let panel = document.getElementById("fileBrowserPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fileBrowserPanel";
      panel.className = "file-browser-panel";
      const shell = document.getElementById("terminalShell");
      (shell && shell.parentNode ? shell.parentNode : document.body).appendChild(panel);
    }
    const entries = treeEntries();
    const currentRow = Tree.renderCurrentDirectoryRow({ callback: "HerdrFileBrowser", canGoUp: canGoUp(), path: currentDirectoryPath(), label: currentDirectoryLabel(), title: currentDirectoryTitle() });
    const sideBody = `${currentRow}${Tree.renderEntries(entries, { callback: "HerdrFileBrowser", showMeta: true, dirClickMethod: "none", dirDoubleClickMethod: "enter", contextMethod: "menu", shiftSelectMode: true })}`;
    const sideHtml = `<aside class="file-browser-side" tabindex="0"><div class="file-browser-head"><div class="file-browser-title-row"><div class="file-browser-title">Files</div><div class="file-browser-actions">${appRefreshIconButton({ className: "file-browser-refresh", title: "Refresh", label: "Refresh files", spinning: !!state.refreshing, onclick: "HerdrFileBrowser.refresh()" })}</div></div><div class="file-browser-subtitle">${esc(state.path || state.cwd || "No workspace")}</div></div>${renderAccessError()}${sideBody}</aside>`;
    panel.innerHTML = `${sideHtml}${renderContextMenu()}`;
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  function renderAccessError() {
    if (!state.error) return "";
    const action = state.permissionRequired ? `<button class="git-ui-btn primary" onclick="HerdrFileBrowser.requestAccess()">Grant folder access</button>` : "";
    return `<div class="file-browser-error"><span>${esc(state.error)}</span>${action}</div>`;
  }

  async function requestAccess() {
    try {
      const data = await api("/api/file-browser/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path: state.path || "" }),
      });
      if (data.path) {
        state.cwd = data.path;
        state.path = "";
      }
      await loadTree(state.path || "");
    } catch (error) {
      setError(state, error);
      renderIfActive(state);
    }
  }

  function treeEntries() {
    const entries = flattenEntries(state.entries, 0);
    return Tree.applyGitStatus(entries, state.gitStatus);
  }

  function currentDirectoryPath() {
    return state.path || state.cwd || "";
  }

  function currentDirectoryLabel() {
    if (state.path) return Tree.basename(state.path);
    return Tree.basename(state.cwd) || state.cwd || "Files";
  }

  function currentDirectoryTitle() {
    return state.path ? `${state.cwd.replace(/\/+$/, "")}/${state.path}` : state.cwd;
  }

  function canGoUp() {
    return !!(state.path || (parentFoldersEnabled() && state.cwd && Tree.parentDirectory(state.cwd) !== state.cwd));
  }

  async function goUp() {
    if (state.path) {
      await loadTree(Tree.parentPath(state.path));
      return;
    }
    if (!parentFoldersEnabled()) return;
    const parent = Tree.parentDirectory(state.cwd);
    if (!parent || parent === state.cwd) return;
    state.cwd = parent;
    await loadTree("");
  }

  function flattenEntries(entries, level) {
    const rows = [];
    for (const entry of entries || []) {
      const row = Object.assign({}, entry, { level, expanded: !!state.expanded[entry.path] });
      rows.push(row);
      if (entry.kind === "dir" && state.expanded[entry.path] && state.children[entry.path])
        rows.push(...flattenEntries(state.children[entry.path], level + 1));
    }
    return rows;
  }

  async function toggleDir(path) {
    const target = state;
    if (target.expanded[path]) {
      target.expanded[path] = false;
      renderIfActive(target, true);
      return;
    }
    target.expanded[path] = true;
    if (!target.children[path] && !target.loading[path]) {
      target.loading[path] = true;
      renderIfActive(target, true);
      try {
        target.children[path] = await fetchEntries(path, target);
      } catch (error) {
        target.error = error.message || String(error);
        target.expanded[path] = false;
      }
      delete target.loading[path];
    }
    renderIfActive(target, true);
  }

  function markdownPath(path) {
    return !!(window.HerdrEditor && window.HerdrEditor.isMarkdownPath && window.HerdrEditor.isMarkdownPath(path));
  }

  function menuIcon(action, label, extra = "") {
    const icons = {
      enter: "/assets/icons/folder-up.svg",
      history: "/assets/icons/clock.svg",
      copyPath: "/assets/icons/copy.svg",
      copyPermalink: "/assets/icons/link.svg",
      rename: "/assets/icons/pencil.svg",
      delete: "/assets/icons/trash.svg",
      openWorkspaceHere: "/assets/icons/terminal.svg",
    };
    const src = icons[action];
    const icon = src ? ` style="mask-image:url('${src}');-webkit-mask-image:url('${src}')"` : "";
    const attrs = extra ? ` ${extra.trim()}` : "";
    return `<button type="button" role="menuitem"${attrs} data-file-menu-action="${action}"><span class="file-browser-menu-icon"${icon} aria-hidden="true"></span><span class="file-browser-menu-text">${esc(label)}</span></button>`;
  }

  function menuPos(menu) {
    const x = Math.max(0, Number(menu.x) || 0);
    const y = Math.max(0, Number(menu.y) || 0);
    const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    const width = 240;
    const height = 320;
    let left = x;
    let top = y;
    if (vw && x + width > vw - 8) left = Math.max(8, vw - width - 8);
    if (vh && y + height > vh - 8) top = Math.max(8, vh - height - 8);
    return `left:${left}px;top:${top}px`;
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const name = Tree.basename(menu.path) || menu.path;
    const title = `<span class="file-browser-menu-label" title="${arg(menu.path)}">${esc(name)}</span><span class="file-browser-menu-sep"></span>`;
    // Dirs enter; files would open a center tab, which the row click
    // already does, so the menu shows folder navigation and file actions
    // that do not need the tree to own a selection.
    const enter = menu.kind !== "file" ? menuIcon("enter", "Enter folder") : "";
    const history = menu.kind === "file" ? menuIcon("history", "Show history") : "";
    const permalink = menu.kind === "file" ? menuIcon("copyPermalink", "Copy permalink") : "";
    const openWorkspaceHere = menu.kind === "dir" ? menuIcon("openWorkspaceHere", "Open workspace here") : "";
    return `<div class="file-browser-menu" role="menu" style="${menuPos(menu)}" onclick="event.stopPropagation()">${title}<div class="file-browser-menu-section">${enter}${history}${permalink}</div><span class="file-browser-menu-sep"></span><div class="file-browser-menu-section">${openWorkspaceHere}${menuIcon("rename", "Rename")}${menuIcon("copyPath", "Copy path")}</div><span class="file-browser-menu-sep"></span><div class="file-browser-menu-section">${menuIcon("delete", "Delete", ' class="danger"')}</div></div>`;
  }

  window.HerdrFileBrowser = {
    open,
    openAt,
    close: hide,
    hide,
    forgetWorkspace,
    refresh() { loadTree(state.path); },
    refreshLsp() { refreshLspDiagnostics(); },
    requestAccess,
    up() { goUp(); },
    toggle(encodedPath) { toggleDir(decodeURIComponent(encodedPath)); },
    enter(encodedPath) { loadTree(decodeURIComponent(encodedPath)); },
    // Tree clicks route through the pane module so the tab lands in the
    // pane tree (identity, ordering, persistence) before the registry
    // mounts the editor; a missing pane module falls back to the direct
    // registry open (mobile parity paths, standalone boots).
    select(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openEditorTab) { void panes.openEditorTab(path); return; }
      openEditorTab(path);
    },
    openEditorTab,
    closeEditorTab,
    closeEditorState,
    editorFor(path) { return fileFor(path); },
    activeEditorPath,
    openFocusedFind(target) { return openFindForPath(activeEditorPath() || focusedFilePath(target)); },
    toggleFind(encodedPath) { toggleFind(decodeURIComponent(encodedPath || "")); },
    save(encodedPath) { saveFile(decodeURIComponent(encodedPath)); },
    reload(encodedPath) { reloadFile(decodeURIComponent(encodedPath)).catch((error) => { state.error = error.message || String(error); renderIfActive(state, true); }); },
    loadPartial(encodedPath) { loadPartial(decodeURIComponent(encodedPath)); },
    checkOpenFilesForExternalChanges,
    showHistory(encodedPath) { showHistoryPath(decodeURIComponent(encodedPath || "")); },
    menu(event, encodedPath, kind) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { x: event.clientX, y: event.clientY, path: decodeURIComponent(encodedPath), kind };
      render();
      return false;
    },
    menuAction(action) { return handleMenuAction(action); },
    isVisible() { return state.open; },
    activeWorkspaceId() { return state.open ? (activeKey || "") : ""; },
    isWorkspaceVisible(workspace) { return state.open && activeKey === workspaceKey(workspace); },
  };
})();
