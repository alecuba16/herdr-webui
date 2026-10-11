// Center pane tree for the desktop shell. Phase 4: the tree is a real
// binary layout ({kind:"pane"} leaves, {kind:"row"|"column", sizes,
// children} split nodes) rendered recursively with resizable dividers.
// Phase 3b/3c tab identity is unchanged: terminal tabs use backend
// tab ids, editor tabs are editor:<path> (one per file), git tabs are
// git:<view-key> (one per view).
//
// Exactly one live terminal surface exists (#terminalShell, one wterm
// instance), so the tree enforces a terminal singleton at command
// time: only the leaf holding the route terminal tab ever holds
// terminal tabs, splits never clone it, and the move command refuses
// it. Editor and git tabs can land in any leaf.
//
// The pane tree is client-owned and exists only while its workspace is open,
// mirroring the backend's client-owned
// pane/tab surface model: terminal tabs bind 1:1 to backend tabs exactly
// like the single-terminal shell and temp terminals do today.
//
// Tab identity lives here so strips render editor tabs even while the
// lazily-loaded file browser module is still being fetched: labels come
// from tab metadata, and clicking a placeholder tab ensures the module is
// loaded before the real open. Per-file editor state (content, draft,
// dirty, CodeMirror instance) stays in file_browser.js's workspace-keyed
// registry; the pane module only owns identity, ordering, and mounting.
const WORKSPACE_PANES_STORAGE_KEY = "herdr-web-workspace-panes";
const EDITOR_TAB_PREFIX = "editor:";
// Seed tab id for a fresh tree. Never a backend id: the first real panel
// ids replace it (syncTerminalTabsIntoTree).
const TERMINAL_TAB_PLACEHOLDER = "terminal";
// Route tab the pane tree last synced from. The strip highlight must
// follow explicit terminal navigation (go(), boot restore, shortcuts,
// panel menu, agent picks): when state.tab moves to a live panel, the
// tree's active pointer moves with it. The shadow keeps an open editor
// tab in the highlight: opening a file does not change the route, so a
// route-equality check alone would yank the editor highlight away on
// every render. Only an actual route change re-syncs. The unset value
// also means "first render": boot re-syncs so a stored editor pointer
// never blanks the pane while the URL says the terminal view.
let lastSyncedRouteTab;
// Whether the tree ever had a pointer set by an explicit open/activation
// (setActivePaneTab) rather than the sync/heal paths. The boot sync must
// not steal a pointer the same tick an editor open just set: when a
// route names a live panel but the user explicitly opened a file before
// any render ran, the editor pointer is the freshest signal.
let sawExplicitActive;

function editorTabId(path) {
  return `${EDITOR_TAB_PREFIX}${path}`;
}

function editorTabPath(tabId) {
  return typeof tabId === "string" && tabId.startsWith(EDITOR_TAB_PREFIX) ? tabId.slice(EDITOR_TAB_PREFIX.length) : "";
}

function isEditorTab(tabId) {
  return typeof tabId === "string" && tabId.startsWith(EDITOR_TAB_PREFIX);
}

function editorTabLabel(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "file";
}

// ---- git tab identity ---------------------------------------------------
// git:<view-key> with view-key one of changes, log, stash, cleanup,
// conflicts, history@<path>, diff@<path>, compare@<base>..<target>. One
// tab per view-key per workspace (the pane tree is per-workspace), so a
// different status file reuses the changes/diff tab and moves its focus.
const GIT_TAB_PREFIX = "git:";

function gitTabId(viewKey) {
  return `${GIT_TAB_PREFIX}${viewKey}`;
}

function gitTabViewKey(tabId) {
  return typeof tabId === "string" && tabId.startsWith(GIT_TAB_PREFIX) ? tabId.slice(GIT_TAB_PREFIX.length) : "";
}

function isGitTab(tabId) {
  return typeof tabId === "string" && tabId.startsWith(GIT_TAB_PREFIX);
}

function gitTabLabel(viewKey) {
  const key = String(viewKey || "");
  const at = key.indexOf("@");
  const kind = at > 0 ? key.slice(0, at) : key;
  const target = at > 0 ? key.slice(at + 1) : "";
  switch (kind) {
    case "changes": return "gitchanges";
    case "log": return "gitlog";
    case "stash": return "gitstash";
    case "cleanup": return "gitcleanup";
    case "conflicts": return "gitconflicts";
    case "history": return `history ${target ? editorTabLabel(target) : ""}`.trim();
    case "diff": return `diff ${target ? editorTabLabel(target) : ""}`.trim();
    case "compare": return compareGitLabel(target);
    default: return kind || "git";
  }
}

// Compare tabs name their refs in the strip: a hash shows as its 7-char
// short form, the working tree as "current", branch names truncate to 7
// chars, and master sorts first when it is one of the two sides.
function shortGitRef(refs) {
  const value = String(refs || "").trim();
  if (!value) return "current";
  const parts = value.split("..");
  const label = (part) => {
    if (part === "." || part === "") return "current";
    return part.slice(0, 7);
  };
  return parts.map(label).join(" vs ");
}

function compareGitLabel(refs) {
  const value = String(refs || "").trim();
  if (!value) return "gitcmp current vs current";
  const parts = value.split("..");
  if (parts.length !== 2) return `gitcmp ${shortGitRef(value)}`;
  const base = shortGitRef(parts[0]);
  const target = shortGitRef(parts[1]);
  if (target === "master") return `gitcmp master vs ${base}`;
  return `gitcmp ${base} vs ${target}`;
}

// Full hover text for one git tab. Compare tabs spell their refs out in
// full (the strip label carries the short forms); every other tab reuses
// its own label, so the hover says what the tab already says.
function gitTabTitle(viewKey) {
  const key = String(viewKey || "");
  const at = key.indexOf("@");
  const kind = at > 0 ? key.slice(0, at) : key;
  const target = at > 0 ? key.slice(at + 1) : "";
  if (kind === "compare") return `gitcmp ${target || "current"}`;
  return gitTabLabel(viewKey);
}

function paneGitMountId(viewKey) {
  const hash = (typeof HerdrAppHelpers !== "undefined" && HerdrAppHelpers.hashId)
    ? HerdrAppHelpers.hashId(`git|${viewKey}`)
    : String(viewKey || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `pane-git-${hash}`;
}

// Strip html for one git tab. The label derives from the view key alone,
// so placeholder tabs render identically before git_ui.js loads; the
// click handler loads the module and finishes the open.
function paneGitTabButtonHtml(tabId, isActive) {
  const viewKey = gitTabViewKey(tabId);
  const label = gitTabLabel(viewKey);
  return `<button class="pane-tab git ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="git" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(gitTabTitle(viewKey))}" onclick="activatePaneTab('${escapeAttr(tabId)}')"><span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close Git view" aria-label="Close Git view" onclick="event.stopPropagation();closeGitTab('${escapeAttr(viewKey)}')">✕</span></button>`;
}

function paneEditorMountId(path) {
  const hash = (typeof HerdrAppHelpers !== "undefined" && HerdrAppHelpers.hashId)
    ? HerdrAppHelpers.hashId(path)
    : String(path || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `pane-editor-${hash}`;
}

// Strip html for one editor tab. Needs no file-browser state: the dirty
// flag comes from the file browser registry when loaded, the label from
// the path. Placeholder tabs (module not loaded yet, no registry entry)
// render the same markup with no dirty dot; the click handler loads the
// module and finishes the open.
function paneEditorTabButtonHtml(tabId, isActive) {
  const path = editorTabPath(tabId);
  const registry = window.HerdrFileBrowser;
  const file = registry && registry.editorFor ? registry.editorFor(path) : null;
  const dirty = !!(file && file.dirty && file.editing);
  const label = editorTabLabel(path);
  const encoded = encodeURIComponent(path);
  return `<button class="pane-tab editor ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="editor" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(path)}" onclick="activatePaneTab('${escapeAttr(tabId)}')">${dirty ? '<span class="pane-tab-dirty" title="Modified" aria-hidden="true">●</span>' : ""}<span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close file" aria-label="Close file" onclick="event.stopPropagation();closeEditorTab('${escapeAttr(encoded)}')">✕</span></button>`;
}

function panesStateFor(id = state.ws) {
  const key = workspaceShellKey(id);
  if (!state.workspacePanes[key]) {
    state.workspacePanes[key] = {
      root: newLeaf("p1"),
      at: Date.now(),
    };
  }
  return state.workspacePanes[key];
}

// ---- maximize (Phase 5) ---------------------------------------------
// The tree stays intact while a leaf is maximized: renderWorkspacePanes
// swaps the effective root for the maximized leaf only, so the strip, the
// active pointer, and the stored sizes survive the toggle. Persistence is
// deliberate: a reload keeps the maximized view (the same call heals a
// stale id on boot by dropping it).
function maximizedLeaf(root) {
  const entry = panesStateFor();
  if (!entry.maximizedPaneId) return null;
  if (!paneTreeRenderable(root)) return null;
  const leaf = paneLeaves(root).find((l) => l.paneId === entry.maximizedPaneId);
  if (!leaf) {
    entry.maximizedPaneId = null;
    saveWorkspacePanesStates();
    return null;
  }
  return leaf;
}

function maximizeActivePane() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  if (paneLeaves(root).length < 2) return false;
  const leaf = activeLeaf(root);
  if (!leaf) return false;
  const entry = panesStateFor();
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  else entry.maximizedPaneId = leaf.paneId;
  // The maximized leaf is the one on screen; keep the active pointer
  // with it so split/close/move commands act on the visible pane.
  root.activePaneId = leaf.paneId;
  entry.at = Date.now();
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  // Cross-module guard: standalone harnesses load this file alone, and
  // fitTerminalSurface lives in terminal.js.
  if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  return true;
}

function paneIsMaximized() {
  return !!maximizedLeaf(paneRootFor());
}

// ---- tree model (Phase 4) ----------------------------------------------
// Leaves carry a stable paneId used by the DOM reconcile and the active
// pane pointer; split nodes carry flex-grow sizes. The walk helpers below
// are the only sanctioned access: everything that used to assume
// "the pane" goes through paneForTab/paneForPaneId/paneLeaves so a tab in
// any leaf resolves, not just the first one.

// Class test that works on real DOM elements and the minimal fakes the
// node harnesses use (className string, no classList/nodeType).
function hasClass(node, name) {
  return !!(node && typeof node.className === "string"
    && node.className.split(/\s+/).indexOf(name) >= 0);
}

// Recursive pane lookup by paneId. querySelector with attribute selectors
// is avoided on purpose: the node-test DOM stubs only support #id and
// .class selectors, and split trees bury panes several levels deep.
function findPaneElementById(element, paneId) {
  for (const child of element.children || []) {
    if (hasClass(child, "workspace-pane") && child.dataset && child.dataset.paneId === paneId)
      return child;
    const found = findPaneElementById(child, paneId);
    if (found) return found;
  }
  return null;
}

let paneIdCounter = 0;
// Every workspace's tree shares this id set: duplicates would break the
// DOM reconcile (two panes keyed by one id) and paneForPaneId lookups.
const usedPaneIds = new Set();

function newLeaf(paneId) {
  let id = paneId;
  if (!id) {
    do id = `p${++paneIdCounter}`;
    while (usedPaneIds.has(id));
  }
  usedPaneIds.add(id);
  return { kind: "pane", paneId: id, tabs: [TERMINAL_TAB_PLACEHOLDER], active: TERMINAL_TAB_PLACEHOLDER };
}

function newEmptyLeaf() {
  const leaf = newLeaf();
  leaf.tabs = [];
  leaf.active = null;
  return leaf;
}

function isPaneLeaf(node) {
  return !!(node && node.kind === "pane" && Array.isArray(node.tabs));
}

function isPaneSplit(node) {
  return !!(node && (node.kind === "row" || node.kind === "column")
    && Array.isArray(node.children) && node.children.length >= 2);
}

function paneLeaves(root) {
  const out = [];
  const walk = (node) => {
    if (isPaneSplit(node)) node.children.forEach(walk);
    else if (isPaneLeaf(node)) out.push(node);
  };
  walk(root);
  return out.length ? out : [];
}

// The leaf that renders: the active leaf when the pointer names a live
// leaf, else the first leaf. Single-leaf trees (Phase 3b/3c sessions,
// standalone harnesses) resolve to the root, which is what the old
// helpers returned.
function activeLeaf(root) {
  const leaves = paneLeaves(root);
  if (!leaves.length) return null;
  const byId = root.activePaneId && leaves.find((l) => l.paneId === root.activePaneId);
  return byId || leaves[0];
}

function paneForPaneId(root, paneId) {
  return paneLeaves(root).find((l) => l.paneId === paneId) || null;
}

// Which leaf owns a tab id. Editor/git tabs can sit in any leaf; terminal
// ids resolve to the terminal leaf (or null while only the placeholder
// exists and no backend panels have loaded yet).
function paneForTab(root, tabId) {
  return paneLeaves(root).find((l) => l.tabs.includes(tabId)) || null;
}

function focusLeaf(root, leaf) {
  if (!leaf) return;
  root.activePaneId = leaf.paneId;
}

// Recursively repairs trees loaded from storage: missing paneIds, sizes
// that drifted from the children count, a stale activePaneId. Old blobs
// (flat leaves from Phase 1-3c) load as single-leaf trees untouched.
function normalizePaneTree(root) {
  if (!root || typeof root !== "object") return null;
  // A split that lost children down to one collapses to its survivor
  // before the isPaneSplit check: the check requires two children, and a
  // single-child split is indistinguishable from "not a split" to the
  // renderer. Same for empty splits: the tree never renders those.
  if (root && (root.kind === "row" || root.kind === "column") && Array.isArray(root.children)) {
    root.children = root.children.filter(Boolean).map(normalizePaneTree).filter(Boolean);
    if (root.children.length < 2) return root.children[0] || newLeaf();
  }
  if (isPaneSplit(root)) {
    if (!Array.isArray(root.sizes)) root.sizes = [];
    root.sizes = root.children.map((_, i) => (Number.isFinite(root.sizes[i]) && root.sizes[i] > 0 ? root.sizes[i] : 1));
    return root;
  }
  if (isPaneLeaf(root)) {
    if (!root.paneId) {
      do root.paneId = `p${++paneIdCounter}`;
      while (usedPaneIds.has(root.paneId));
      usedPaneIds.add(root.paneId);
    }
    return root;
  }
  return null;
}

function loadWorkspacePanesStates() {
  try {
    // A reload starts with a fresh single pane. The store is only a temporary
    // write-through while this page keeps workspaces open.
    localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

function saveWorkspacePanesStates() {
  try {
    const keep = new Set((state.workspaces || []).map((workspace) => workspaceShellKey(workspace)));
    if (state.ws) keep.add(workspaceShellKey(state.ws));
    const live = Object.fromEntries(
      Object.entries(state.workspacePanes || {}).filter(([key]) => keep.has(key)),
    );
    if (Object.keys(live).length) localStorage.setItem(WORKSPACE_PANES_STORAGE_KEY, JSON.stringify(live));
    else localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

function forgetWorkspacePanes(id) {
  delete state.workspacePanes[workspaceShellKey(id)];
  saveWorkspacePanesStates();
}

loadWorkspacePanesStates();

function paneRoot(id = state.ws) {
  return panesStateFor(id).root;
}

// A tree renders when it resolves to at least one leaf. Single-leaf trees
// keep the old flat contract (root is the leaf), so Phase 3b/3c callers
// and standalone harnesses are unaffected.
function paneTreeRenderable(root) {
  return paneLeaves(root).length > 0;
}

// Leaf-level accessors default to the active leaf. paneTabs/paneActiveTab
// keep their 3b/3c signatures: existing callers ask about the strip they
// are looking at.
function paneTabs(root = paneRoot()) {
  const leaf = isPaneLeaf(root) ? root : activeLeaf(root);
  return leaf ? leaf.tabs : [];
}

function paneActiveTab(root = paneRoot()) {
  const leaf = isPaneLeaf(root) ? root : activeLeaf(root);
  return leaf && leaf.active ? leaf.active : null;
}

// ---- rendering -----------------------------------------------------------
// Phase 1 renders one pane. The DOM contract: #workspacePanes is the center
// container, each pane is .workspace-pane, its strip is .pane-tab-strip,
// each tab is .pane-tab. Only the strip is ever rebuilt by innerHTML; the
// pane content slot is persistent and #terminalShell moves into it by
// reference, so the wterm surface and its ResizeObserver stay alive.
// The pane tree stores tab ids. Terminal tabs use backend tab ids; editor
// tabs use the editor:<path> identity. Persisted trees from older sessions
// may reference files that no longer exist: placeholder tabs stay inert
// until clicked, the real existence check happens on open.
function paneTabsForTree(leaf) {
  const tabs = isPaneLeaf(leaf) ? leaf.tabs : paneTabs(leaf);
  return tabs.filter((tabId) => {
    if (isEditorTab(tabId)) return true;
    if (isGitTab(tabId)) return true;
    return (state.tabs || []).some((tab) => tab.tab_id === tabId);
  });
}

function paneTerminalTabById(tabId) {
  return (state.tabs || []).find((tab) => tab.tab_id === tabId) || null;
}

// Terminal tabs mirror the backend 1:1 (tab_id identity): the tree stores
// the ids so ordering and the active pointer persist, while the backend
// stays the source of truth. Missing ids append (new panels), ids absent
// from a non-empty panel list drop (closed panels, from every leaf), and
// the seed placeholder is replaced by the first real ids. An empty panel
// list never prunes: it is usually a poll gap or a closed workspace, and
// the render filter already hides ids with no panel. Editor tabs are
// client-owned and never touched here.
//
// The active pointer also re-syncs from the route on real navigation
// (see lastSyncedRouteTab): boot restores state.tab from the session
// selection while the tree restores its own active pointer from storage,
// and go() moves the route without touching the tree, both left the
// strip highlighting a tab the view had already left.
//
// Phase 4: the sync runs per-leaf, and the terminal singleton decides
// which leaf receives terminal ids: the leaf that already holds one.
// With no terminal anywhere yet, the active leaf seeds (boot, first
// panel). Non-terminal leaves keep editor/git tabs only, so a split
// keeps exactly one wterm surface in the tree.
// Per-leaf render pass: only the single shell owner below may host
// #terminalShell. Resolved once per render so every leaf's mount call
// sees the same decision even when several leaves show terminal tabs.
// The cascade only considers leaves that actually render this pass: in
// maximize mode the hidden sibling must never own the shell, or the
// maximized pane parks it and shows a blank slot.
function terminalShellOwnerLeaf(root) {
  const maxLeaf = maximizedLeaf(root);
  const rendered = maxLeaf ? [maxLeaf] : paneLeaves(root);
  if (!rendered.length) return null;
  const routeTab = state.tab != null ? String(state.tab) : null;
  const routeLeaf = routeTab && !isEditorTab(routeTab) && !isGitTab(routeTab) ? paneForTab(root, routeTab) : null;
  if (routeLeaf && rendered.includes(routeLeaf)) return routeLeaf;
  const backendIds = (state.tabs || []).map((tab) => String(tab.tab_id));
  const firstTerminalActive = rendered.find((leaf) => {
    const active = leaf.active;
    return !!active && !isEditorTab(active) && !isGitTab(active) && active !== TERMINAL_TAB_PLACEHOLDER;
  }) || rendered.find((leaf) => {
    const active = leaf.active;
    return !!active && !isEditorTab(active) && !isGitTab(active);
  });
  if (firstTerminalActive) return firstTerminalActive;
  // No leaf shows a terminal tab: the singleton owner keeps the shell so
  // future panels land somewhere known. Owner prefers the leaf holding
  // the terminal placeholder or a real terminal id, else the active leaf.
  const seeded = rendered.find((leaf) => leaf.tabs.some((id) => id === TERMINAL_TAB_PLACEHOLDER || backendIds.includes(id)));
  return seeded || rendered[0];
}

function terminalLeafForSync(root, backendIds) {
  const leaves = paneLeaves(root);
  // A pending + placement from a specific pane wins, but only while it
  // has work to do: at least one backend id must be missing from every
  // leaf. Once every id has a home, a stale pending entry must not steal
  // the sync target (a poll tick between the + click and the panel list
  // landing would otherwise consume the placement and redirect the
  // sync to that pane on the next tick too).
  if (pendingTabPlacements && pendingTabPlacements.has("__next__")) {
    const missingIds = backendIds.filter((id) => !leaves.some((leaf) => leaf.tabs.includes(id)));
    if (missingIds.length) {
      const target = paneForPaneId(root, pendingTabPlacements.get("__next__"));
      if (target) {
        pendingTabPlacements.delete("__next__");
        return target;
      }
    }
    if (!missingIds.length || !paneForPaneId(root, pendingTabPlacements.get("__next__")))
      pendingTabPlacements.delete("__next__");
  }
  const withTerminal = leaves.find((leaf) => leaf.tabs.some((id) => id === TERMINAL_TAB_PLACEHOLDER || backendIds.includes(id)));
  return withTerminal || activeLeaf(root) || leaves[0] || null;
}

function syncTerminalTabsIntoTree(root) {
  const backendIds = (state.tabs || []).map((tab) => String(tab.tab_id));
  const routeTab = state.tab != null ? String(state.tab) : null;
  const target = terminalLeafForSync(root, backendIds);
  if (!target) return false;
  const placeholderIndex = target.tabs.indexOf(TERMINAL_TAB_PLACEHOLDER);
  const seedPlaceholder = placeholderIndex >= 0 && !backendIds.includes(TERMINAL_TAB_PLACEHOLDER);
  let changed = false;
  if (seedPlaceholder && backendIds.length) {
    target.tabs.splice(placeholderIndex, 1, ...backendIds);
    changed = true;
    if (target.active === TERMINAL_TAB_PLACEHOLDER) target.active = backendIds[0];
  } else {
    for (const id of backendIds) {
      // A tab id that already lives in another leaf keeps its home: the
      // placement rule (one home per terminal tab) beats the singleton
      // append. Otherwise the post-migration sync would duplicate ids
      // across strips.
      if (paneForTab(root, id) && paneForTab(root, id) !== target) continue;
      if (!target.tabs.includes(id)) {
        target.tabs.push(id);
        changed = true;
      }
    }
  }
  if (backendIds.length) {
    // Prune closed backend ids from every leaf, not just the target: the
    // target selection picks the leaf holding the first live terminal id,
    // so a sibling whose terminal closed keeps a dead id in its tabs and a
    // dangling active pointer (the strip filter hides the id, leaving an
    // orphan blank pane until something re-targets the sync).
    for (const leaf of paneLeaves(root)) {
      const kept = leaf.tabs.filter((id) => isEditorTab(id) || isGitTab(id) || backendIds.includes(id));
      if (kept.length !== leaf.tabs.length) {
        leaf.tabs = kept;
        changed = true;
      }
    }
  }
  // Route sync: a navigation that names a live panel takes the active
  // pointer of the leaf that OWNS the route tab, not the sync target
  // (they differ after a migration moved tabs across leaves). Writing
  // the target here and relying on the dangling-pointer heal below
  // would fight: the heal sees the pointer missing from target.tabs and
  // clobbers it one tick later. focusLeaf moves the pane focus so the
  // next open lands beside the route tab.
  const routeChanged = lastSyncedRouteTab !== routeTab;
  const routeIsLivePanel = !!(routeTab && backendIds.includes(routeTab));
  const bootSyncWithFreshActivation = lastSyncedRouteTab === undefined && sawExplicitActive;
  const routeOwner = routeTab ? paneForTab(root, routeTab) : null;
  if (routeChanged && routeIsLivePanel && !bootSyncWithFreshActivation && routeOwner && routeOwner.active !== routeTab) {
    routeOwner.active = routeTab;
    focusLeaf(root, routeOwner);
    changed = true;
  }
  lastSyncedRouteTab = routeTab;
  sawExplicitActive = false;
  // Stale-pointer heal for every leaf, not just the sync target: the
  // prune above may have dropped the active id from a non-target leaf,
  // and the owner-focused pointer must not outlive its tab. Same
  // fallback order as the target heal below the sync: a surviving
  // editor/git/terminal tab first, else the first remaining tab, else
  // null when the leaf emptied out entirely.
  for (const leaf of paneLeaves(root)) {
    if (leaf === target) continue;
    if (!leaf.tabs.includes(leaf.active)) {
      const nextActive = leaf.tabs.find((id) => isEditorTab(id) || isGitTab(id) || backendIds.includes(id)) || leaf.tabs[0] || null;
      if (leaf.active !== nextActive) {
        leaf.active = nextActive;
        changed = true;
      }
    }
  }
  if (!target.tabs.includes(target.active)) {
    const nextActive = target.tabs.find((id) => isEditorTab(id) || isGitTab(id) || backendIds.includes(id)) || target.tabs[0] || null;
    if (target.active !== nextActive) {
      target.active = nextActive;
      changed = true;
    }
  }
  if (changed) saveWorkspacePanesStates();
  return changed;
}

// ---- recursive render (Phase 4) ---------------------------------------
// The DOM mirrors the tree: split nodes are .pane-row/.pane-column flex
// containers with .pane-divider handles between children; leaves keep the
// Phase 3 contract (.workspace-pane > .pane-tab-strip + .pane-content).
// Reconciliation is by paneId/split identity, never innerHTML on containers
// holding live nodes: a container node that matches by identity is reused,
// mismatched children are removed, missing ones are created. The strips
// stay signature-gated (innerHTML only on the strip itself).

// Split node ids stay kind-free: an orientation flip rewrites the node's
// kind but keeps its identity, so the reconcile reuses the same DOM subtree
// (class swap only) instead of rebuilding it and orphaning live containers.
function splitNodeId(node, index) {
  return `split-${index}`;
}

function reconcileSplitNode(container, node, idPath) {
  // The caller pre-creates the wrapper for a nested split and passes it as
  // the container: use it directly instead of searching its children for
  // the same idPath (that would nest a duplicate wrapper inside it).
  let element = (container.dataset && container.dataset.splitId === idPath)
    ? container
    : [...container.children].find((child) =>
        child.dataset && child.dataset.splitId === idPath);
  if (!element) {
    element = document.createElement("div");
    element.className = node.kind === "row" ? "pane-row" : "pane-column";
    element.dataset.splitId = idPath;
    container.appendChild(element);
  }
  const wanted = node.kind === "row" ? "pane-row" : "pane-column";
  if (element.className.split(/\s+/).indexOf(wanted) < 0) element.className = wanted;
  // Sizes are flex-grow numbers written straight onto the children; the
  // divider drag updates them live and reads them back on pointerup.
  // Child split ids extend the parent path so two same-index splits in
  // different parents never collide.
  const childIds = node.children.map((child, i) =>
    isPaneSplit(child) ? `${idPath}/${splitNodeId(child, i)}` : (child.paneId || `p?${i}`));
  [...element.children].forEach((child) => {
    const isDivider = hasClass(child, "pane-divider");
    // Split wrappers carry data-split-id, leaves carry data-pane-id. Keying
    // both kinds by paneId made every nested split look stale (undefined
    // key), so the loop tore the subtree down and rebuilt it on each render,
    // orphaning live containers and churning the strip nodes.
    const key = isDivider
      ? child.dataset.dividerFor
      : (child.dataset.splitId != null ? child.dataset.splitId : child.dataset.paneId);
    if (isDivider) {
      // A divider pairs child i with childIds[i + 1], so a divider keyed
      // on anything outside childIds.slice(1) lost its pair (a leaf got
      // wrapped into a nested split, a subtree got removed). Stale ones
      // paint phantom drag handles forever, prune them.
      if (!childIds.slice(1).includes(key)) element.removeChild(child);
    } else if (childIds.indexOf(key) < 0) {
      // A genuinely removed subtree can still hold live surfaces: editor
      // and git containers, the terminal shell. Park them in the persistent
      // home first; a raw removeChild would orphan them.
      const home = el("workspacePanes");
      if (home) rescueLiveSurfaces(home, child);
      element.removeChild(child);
    }
  });
  node.children.forEach((child, i) => {
    const childId = childIds[i];
    let mount = [...element.children].find((candidate) =>
      !hasClass(candidate, "pane-divider")
      && (isPaneSplit(child) ? candidate.dataset.splitId === childId : candidate.dataset.paneId === childId));
    if (!mount) {
      if (isPaneSplit(child)) {
        mount = document.createElement("div");
        // The split class at creation avoids a classless intermediate: the
        // recursive reconcile below reuses this node instead of nesting a
        // second wrapper inside it.
        mount.className = child.kind === "row" ? "pane-row" : "pane-column";
        mount.dataset.splitId = childId;
      } else {
        mount = document.createElement("div");
        mount.className = "workspace-pane";
        mount.dataset.paneId = child.paneId;
        const strip = document.createElement("div");
        strip.className = "pane-tab-strip";
        strip.setAttribute("role", "tablist");
        strip.setAttribute("aria-label", "Pane tabs");
        mount.appendChild(strip);
        const content = document.createElement("div");
        content.className = "pane-content";
        mount.appendChild(content);
      }
      element.appendChild(mount);
    }
    mount.style.flexGrow = String(node.sizes && node.sizes[i] > 0 ? node.sizes[i] : 1);
    if (isPaneSplit(child)) {
      // Nested split: recurse so its panes materialize; the id path is
      // the unique key the divider drag walks back on resize.
      reconcileSplitNode(mount, child, childId);
    }
    if (i < node.children.length - 1) {
      const dividerFor = childIds[i + 1];
      const divider = ensureDivider(element, dividerFor, node.kind);
      // Keep the divider adjacent to this child (appendChild order below
      // may have drifted after reconcile removals). The node-test stubs
      // lack insertBefore: appendChild keeps a workable order there.
      if (divider.previousElementSibling !== mount) {
        if (element.insertBefore && mount.nextSibling) element.insertBefore(divider, mount.nextSibling);
        else if (element.appendChild) element.appendChild(divider);
      }
    }
  });
  return element;
}

function ensureDivider(element, dividerFor, kind) {
  // Walk children instead of an attribute-selector query: the node-test
  // DOM stubs only support #id and .class selectors. Spread first: a real
  // HTMLCollection has no .find of its own.
  let divider = [...(element.children || [])].find((child) =>
    hasClass(child, "pane-divider") && child.dataset && child.dataset.dividerFor === dividerFor);
  if (!divider) {
    divider = document.createElement("div");
    divider.className = "pane-divider";
    divider.dataset.dividerFor = dividerFor;
    divider.setAttribute("role", "separator");
    divider.title = "Drag to resize";
    element.appendChild(divider);
  }
  // A flip reuses the divider node: the aria orientation must follow the
  // split's current kind, not the kind the divider was created with.
  const orientation = kind === "row" ? "vertical" : "horizontal";
  if (divider.setAttribute && divider.getAttribute("aria-orientation") !== orientation)
    divider.setAttribute("aria-orientation", orientation);
  if (divider.__herdrWired !== element) {
    wireDividerDrag(divider);
    divider.__herdrWired = element;
  }
  return divider;
}

function renderWorkspacePanes() {
  const container = el("workspacePanes");
  if (!container) return;
  // The no-workspace dashboard owns the container: no pane skeleton
  // renders until a workspace opens, or the takeover would rebuild
  // dead chrome right after the dashboard mount pass detached it.
  if (dashboardOwnsPaneArea()) return;
  const treeRoot = paneRoot();
  if (!paneTreeRenderable(treeRoot)) return;
  syncTerminalTabsIntoTree(treeRoot);
  // A maximized leaf renders alone: the tree is untouched and the next
  // toggle restores the full layout. The flat single-pane path also keeps
  // every existing caller that assumes one .workspace-pane working.
  const maxLeaf = maximizedLeaf(treeRoot);
  const root = maxLeaf || treeRoot;
  // The rail only exists in maximize mode; a stale one from the last
  // toggle must go before the split rebuilds the container.
  if (!maxLeaf) {
    [...container.children].forEach((child) => {
      if (hasClass(child, "pane-strip-rail")) detachDomNode(child);
    });
  }
  // Never innerHTML this container: #terminalShell (and the #tabs /
  // #projectDashboard siblings app.html parks here) are live nodes the
  // whole app resolves by id. Build the layout with createElement so those
  // nodes stay attached, then move #terminalShell into its leaf below.
  if (!maxLeaf && isPaneSplit(treeRoot)) {
    reconcileSplitNode(container, treeRoot, splitNodeId(treeRoot, 0));
  } else {
    // Single leaf: keep the Phase 3 flat contract (no wrapper element),
    // so existing callers and probes that query .workspace-pane directly
    // stay valid.
    let pane = [...container.children].find((child) => hasClass(child, "workspace-pane"));
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "workspace-pane";
      pane.dataset.paneId = root.paneId || "root";
      const strip = document.createElement("div");
      strip.className = "pane-tab-strip";
      strip.setAttribute("role", "tablist");
      strip.setAttribute("aria-label", "Pane tabs");
      pane.appendChild(strip);
      const content = document.createElement("div");
      content.className = "pane-content";
      pane.appendChild(content);
      container.appendChild(pane);
    }
    renderLeafInto(pane, root);
  }
  // Splits removed from the tree (close promoting a sibling) leave stale
  // layout nodes behind; drop them once the reconcile owns the container.
  // Maximize uses the same sweep against the effective root: the parked
  // split DOM goes (live surfaces rescue out first) and the next toggle
  // rebuilds it from the tree, same as close-promote does.
  cleanupAbandonedLayout(container, root);
  // Maximize keeps the hidden siblings' strips reachable: one stub pane
  // per non-maximized leaf under a rail, strips only. No content mount:
  // the loop below runs on the effective root, so sibling surfaces keep
  // their dispose-on-hide lifecycle until a rail click restores.
  if (maxLeaf) renderPaneStripRail(container, treeRoot, maxLeaf);
  // Every leaf mounts its active tab: strips render everywhere, and the
  // terminal leaf mounts/parks the one #terminalShell surface. A leaf
  // whose active tab is editor/git keeps its own module container (the
  // owning module mounts it); mountPaneTabContent only decides where the
  // terminal shell lives and which stale containers hide.
  const auxTabs = [];
  paneLeaves(root).forEach((leaf) => {
    const pane = paneLeafElement(container, root, leaf);
    if (pane) {
      renderLeafInto(pane, leaf);
      mountPaneTabContent(pane, leaf, auxTabs);
    }
  });
  // Non-owner terminal leaves own aux surfaces; anything not still on
  // screen (closed or promoted leaf, tab moved to the owner) disposes.
  if (window.HerdrPaneTerminals) window.HerdrPaneTerminals.releaseStale(auxTabs);
}

function paneLeafElement(container, root, leaf) {
  if (isPaneSplit(root)) {
    return findPaneElementById(container, leaf.paneId) || null;
  }
  const first = [...container.children].find((child) => hasClass(child, "workspace-pane"));
  return first || null;
}

function renderLeafInto(pane, leaf) {
  const strip = pane.querySelector(".pane-tab-strip");
  if (!strip) return;
  wirePaneStripDrag(strip);
  const activeTab = paneActiveTab(leaf);
  const stripHtml = paneTabsForTree(leaf)
    .map((tabId) => {
      if (isEditorTab(tabId)) return paneEditorTabButtonHtml(tabId, tabId === activeTab);
      if (isGitTab(tabId)) return paneGitTabButtonHtml(tabId, tabId === activeTab);
      return paneTerminalTabButtonHtml(paneTerminalTabById(tabId), tabId === activeTab);
    })
    .join("") + paneStripControlsHtml(leaf);
  if (strip.__herdrPaneSignature !== stripHtml) {
    strip.__herdrPaneSignature = stripHtml;
    strip.innerHTML = stripHtml;
  }
}

// ---- maximize rail ----------------------------------------------
// Sibling strips stay reachable while a leaf is maximized: one stub
// .workspace-pane per hidden leaf, keyed by the real paneId so strip
// commands act on the owning leaf. cleanup sweeps direct children only,
// so the nested stubs survive; find-by-id callers hit the flat pane
// first (it precedes the rail). Stubs rebuild every render: nothing
// live ever parks inside the rail.
function renderPaneStripRail(container, treeRoot, maxLeaf) {
  const siblings = paneLeaves(treeRoot).filter((leaf) => leaf !== maxLeaf);
  let rail = [...container.children].find((child) => hasClass(child, "pane-strip-rail")) || null;
  if (!siblings.length) {
    if (rail) detachDomNode(rail);
    return;
  }
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "pane-strip-rail";
    container.appendChild(rail);
  }
  [...rail.children].forEach(detachDomNode);
  siblings.forEach((leaf) => {
    const stub = document.createElement("div");
    stub.className = "workspace-pane pane-rail-stub";
    stub.dataset.paneId = leaf.paneId;
    const strip = document.createElement("div");
    strip.className = "pane-tab-strip";
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", "Pane tabs");
    stub.appendChild(strip);
    rail.appendChild(stub);
    renderLeafInto(stub, leaf);
  });
}

// Node-test stubs have no .remove(): fall back to removeChild.
function detachDomNode(node) {
  if (node.remove) node.remove();
  else if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
}

// Layout nodes from a previous tree shape that nothing references anymore
// (a close promoted the sibling into the root slot). Anything that is not
// the current split node or the current leaf pane goes; #terminalShell's
// parking spot and the app.html siblings (#tabs, #projectDashboard) are not
// layout nodes and are skipped by the class checks.
function cleanupAbandonedLayout(container, root) {
  const drop = (child) => {
    // Live per-tab surfaces park in #workspacePanes before the subtree
    // goes. #terminalShell is resolved by id everywhere (el() is
    // getElementById), and a detached node is unreachable from there:
    // dropping it orphans the whole terminal. Editor/git containers
    // stay attached so their mounted state (CodeMirror scroll, cursor)
    // survives; their owning modules re-parent them on the next mount.
    rescueLiveSurfaces(container, child);
    detachDomNode(child);
  };
  const keepPaneIds = new Set(paneLeaves(root).map((leaf) => leaf.paneId));
  [...container.children].forEach((child) => {
    if (hasClass(child, "workspace-pane")) {
      // A split root keeps its leaves inside .pane-row/.pane-column
      // nodes: any pane sitting directly in the container is a leftover
      // from the flat single-leaf render and must go, even when its id
      // still names a live leaf (the split built its own element).
      if (isPaneSplit(root) || !keepPaneIds.has(child.dataset.paneId)) drop(child);
    } else if (hasClass(child, "pane-row") || hasClass(child, "pane-column")) {
      if (isPaneSplit(root) && child.dataset.splitId === splitNodeId(root, 0)) return;
      drop(child);
    }
  });
}

// Is node inside ancestor? Real DOM has .contains; the node-test stubs
// walk parentNode chains instead.
function nodeWithin(ancestor, node) {
  if (!node) return false;
  if (ancestor.contains) return ancestor.contains(node);
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode;
  }
  return false;
}

function rescueLiveSurfaces(container, element) {
  // Per-tab containers mount into .pane-content; lift them out before
  // the subtree goes. Parked means hidden: #workspacePanes paints its
  // direct children, so a rescued container left visible would float as
  // a phantom pane until the next mount claims it. The render pass and
  // the owning module's mount both re-parent and unhide the container
  // when its tab becomes active again.
  const rescue = (node) => {
    for (const child of [...(node.children || [])]) {
      if (hasClass(child, "pane-editor-container") || hasClass(child, "pane-git-container")) {
        if (child.style) child.style.display = "none";
        container.appendChild(child);
        continue;
      }
      if (hasClass(child, "pane-terminal-aux")) {
        // Aux surfaces own a live socket and renderer; park them so the
        // drop cannot orphan them. Parked means hidden like the other
        // rescued surfaces: the mount pass re-parents and un-hides, or
        // the registry disposes when no leaf renders the tab anymore.
        if (child.style) child.style.display = "none";
        container.appendChild(child);
        continue;
      }
      rescue(child);
    }
  };
  rescue(element);
  // The terminal shell is the singleton surface: it must never detach.
  // Its display stays untouched: the owner branch of the next render
  // decides visibility (shown in the owner slot, hidden at the home).
  // The dashboard is id-resolved the same way (syncProjectDashboard reads
  // el("projectDashboard")), so a dropped pane hosting it must park it
  // home too or it becomes unreachable from every id lookup.
  const shell = el("terminalShell");
  if (shell && nodeWithin(element, shell)) container.appendChild(shell);
  const dashboard = el("projectDashboard");
  if (dashboard && nodeWithin(element, dashboard)) container.appendChild(dashboard);
}

function paneTabButtonHtml(tab, isActive, index, tabs) {
  if (state.editingTab === tab.tab_id)
    return `<span class="pane-tab terminal ${isActive ? "active" : ""}" role="tab"><input class="tab-rename-input" value="${escapeAttr(state.editingTabValue)}"${inputAttrs("done")} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${escapeAttr(tab.tab_id)}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${escapeAttr(tab.tab_id)}')"></span>`;
  const label = panelVisibleLabel(tab, index, tabs);
  return `<button class="pane-tab terminal ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="terminal" data-tab-id="${escapeAttr(tab.tab_id)}" onclick="activatePaneTab('${escapeAttr(tab.tab_id)}')" ondblclick="event.preventDefault();startTabRename('${escapeAttr(tab.tab_id)}','${escapeAttr(panelRenameInitialLabel(tab))}')" title="${escapeAttr(tabHoverTitle(tab))}">${paneTabStatusHtml(tab)}<span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close panel" aria-label="Close panel" onclick="event.stopPropagation();closeTab('${escapeAttr(tab.tab_id)}')">✕</span></button>`;
}

function paneTerminalTabButtonHtml(tab, isActive) {
  if (!tab) return "";
  const tabs = state.tabs || [];
  return paneTabButtonHtml(tab, isActive, tabs.indexOf(tab), tabs);
}

function paneStripControlsHtml(leaf) {
  return `<span class="pane-strip-controls">${paneNewTabControlHtml(leaf)}${paneSplitControlsHtml(leaf)}${panePaneControlsHtml(leaf)}${paneFindControlHtml(leaf)}${paneMenuControlHtml()}</span>`;
}

// The editor tab's find/replace control lives in the strip next to the
// other pane controls (it used to float inside the editor body). Only an
// editor-active leaf shows it: terminal and git tabs have no find surface.
function paneFindControlHtml(leaf) {
  const activeTab = leaf && leaf.active;
  if (!activeTab || !isEditorTab(activeTab)) return "";
  const encoded = leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  return `<button class="pane-strip-button pane-find-button" title="Find / replace" aria-label="Find / replace" onclick="event.preventDefault();openPaneEditorFind('${escapeAttr(encoded)}')">⌕</button>`;
}

// Resolve the pane's mounted editor and hand it to HerdrEditor.openFind.
// The editor module mounts one .herdr-editor per open file inside the
// pane's .pane-editor-container; the visible one is the active tab's.
function openPaneEditorFind(encodedPaneId) {
  let paneId = encodedPaneId;
  try { paneId = decodeURIComponent(encodedPaneId); } catch (_) {}
  const container = el("workspacePanes");
  if (!container) return;
  const pane = paneId ? findPaneElementById(container, paneId) : null;
  const scope = pane || container;
  const editors = scope.querySelectorAll
    ? scope.querySelectorAll(".herdr-editor")
    : [];
  let target = null;
  for (const node of editors) {
    if (!node.closest) { target = node; break; }
    // The mount hides inactive editor containers; the visible one owns
    // find.
    const host = node.closest(".pane-editor-container");
    if (!host || host.style.display !== "none") { target = node; break; }
  }
  if (target && window.HerdrEditor && window.HerdrEditor.openFind)
    window.HerdrEditor.openFind(target);
}

function paneMenuControlHtml() {
  return `<button class="pane-strip-button pane-menu-button" title="${escapeAttr(titleWithWebuiShortcut("Pane actions", "togglePaneMenu"))}" aria-label="Pane actions" aria-haspopup="menu" aria-expanded="false" onclick="event.preventDefault();togglePaneMenu(this)">⋮</button>`;
}

function paneNewTabControlHtml(leaf) {
  // The + creates the backend panel and routes it into the pane whose
  // strip was clicked, not the active one. With no workspace open it
  // falls through to the workspace/worktree flow (the same family as
  // the dashboard's primary action), so the button is never dead.
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  return `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("New panel", "newPanel"))}" aria-label="New panel" onclick="event.preventDefault();newTabForPane('${escapeAttr(encoded)}')">+</button>`;
}

// The split pair is view-aware: the button matching the leaf's current
// split style hides (that style is already applied), the other one either
// creates the split or flips the existing orientation in place.
function paneSplitControlsHtml(leaf) {
  const root = paneRootFor();
  const parent = leaf ? parentSplitOf(root, leaf) : null;
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const isRow = parent ? parent.kind === "row" : paneRootFor().kind === "row";
  const rightButton = isRow
    ? ""
    : `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("Split right", "splitRight"))}" aria-label="Split right" onclick="event.preventDefault();splitPaneRightFor('${escapeAttr(encoded)}')">◫</button>`;
  const downButton = !isRow && parent
    ? ""
    : `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("Split down", "splitDown"))}" aria-label="Split down" onclick="event.preventDefault();splitPaneDownFor('${escapeAttr(encoded)}')">⊟</button>`;
  return rightButton + downButton;
}

// Maximize and close only exist for a pane that is part of a split:
// maximize hides this pane-content so the sibling takes the space, close
// hands the pane's tabs to the sibling.
function panePaneControlsHtml(leaf) {
  const root = paneRootFor();
  if (paneLeaves(root).length < 2) return "";
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const maximized = !!leaf && maximizedLeaf(root) === leaf;
  const maxButton = `<button class="pane-strip-button" title="${maximized ? "Restore pane" : "Maximize pane"}" aria-label="${maximized ? "Restore pane" : "Maximize pane"}" onclick="event.preventDefault();maximizePaneFor('${escapeAttr(encoded)}')">${maximized ? "↔" : "⛶"}</button>`;
  const closeButton = `<button class="pane-strip-button" title="Close pane" aria-label="Close pane and move tabs to the other pane" onclick="event.preventDefault();closePaneFor('${escapeAttr(encoded)}')">✕</button>`;
  return maxButton + closeButton;
}

// ---- pane menu (Phase 5) -----------------------------------------------
// One menu for the strip's [⋮]: actions depend on the pane's active tab
// kind (terminal, editor, git). Transient by design: it lives outside the
// re-rendered strip, so a strip reconcile never destroys it mid-click.
let paneMenu = null;

function paneMenuItemsFor(leaf, root) {
  const activeTab = leaf.active || (leaf.tabs || [])[0] || null;
  const isTerm = !!activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab);
  const items = [
    { id: "split-right", label: "Split right", action: () => { focusLeaf(root, leaf); splitPaneRight(); } },
    { id: "split-down", label: "Split down", action: () => { focusLeaf(root, leaf); splitPaneDown(); } },
  ];
  if (paneLeaves(root).length > 1) {
    const maximized = !!maximizedLeaf(root);
    items.push({
      id: "maximize",
      label: maximized ? "Restore pane" : "Maximize pane",
      action: () => { focusLeaf(root, leaf); maximizeActivePane(); },
    });
  }
  if (activeTab && isEditorTab(activeTab)) {
    items.push({
      id: "move-tab",
      label: "Move file to next pane",
      action: () => { focusLeaf(root, leaf); moveActiveTabToNextPane(); },
    });
  }
  if (isTerm) {
    const tab = paneTerminalTabById(activeTab);
    if (tab) {
      items.push({
        id: "rename-tab",
        label: "Rename panel",
        action: () => { focusLeaf(root, leaf); startTabRename(tab.tab_id, panelRenameInitialLabel(tab)); },
      });
    }
  }
  if (paneLeaves(root).length > 1) {
    items.push({
      id: "close-pane",
      label: "Close pane",
      action: () => { focusLeaf(root, leaf); void closeActivePane(); },
    });
  }
  return items;
}

function paneMenuHtml(items) {
  return items
    .map(
      (item, index) =>
        `<button type="button" class="pane-menu-item" role="menuitem" data-index="${index}">${escapeHtml(item.label)}</button>`
    )
    .join("");
}

function togglePaneMenu(button) {
  const existing = document.getElementById("paneMenu");
  if (existing) {
    closePaneMenu();
    // Re-clicking the same button just closes; a different button
    // re-opens for its pane below.
    if (existing.dataset.paneMenuButton === paneMenuButtonKey(button)) return;
  }
  const container = el("workspacePanes");
  const root = paneRoot();
  if (!container || !paneTreeRenderable(root)) return;
  const pane = button.closest ? button.closest(".workspace-pane") : null;
  const paneId = pane && pane.dataset ? pane.dataset.paneId : null;
  const leaf = paneId ? paneForPaneId(root, paneId) : activeLeaf(root);
  if (!leaf) return;
  const menu = document.createElement("div");
  menu.id = "paneMenu";
  menu.className = "pane-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Pane actions");
  menu.dataset.paneMenuButton = paneMenuButtonKey(button);
  const items = paneMenuItemsFor(leaf, root);
  paneMenu = { items, paneId: leaf.paneId, button };
  menu.innerHTML = paneMenuHtml(items);
  menu.addEventListener("click", (event) => {
    const target = event.target.closest ? event.target.closest(".pane-menu-item") : null;
    if (!target) return;
    event.preventDefault();
    const item = items[Number(target.dataset.index)];
    if (!item) return;
    closePaneMenu();
    item.action();
  });
  document.body.appendChild(menu);
  positionPaneMenu(menu, button);
  if (button.setAttribute) button.setAttribute("aria-expanded", "true");
  const firstItem = menu.querySelector ? menu.querySelector(".pane-menu-item") : null;
  if (firstItem && typeof firstItem.focus === "function") firstItem.focus();
}

// Buttons live in re-rendered strips: key them by paneId so a stale
// strip render (same pane, new node) still counts as the same toggle.
function paneMenuButtonKey(button) {
  const pane = button.closest ? button.closest(".workspace-pane") : null;
  return (pane && pane.dataset && pane.dataset.paneId) || "root";
}

function positionPaneMenu(menu, button) {
  const rect = button.getBoundingClientRect ? button.getBoundingClientRect() : null;
  if (!rect) return;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
}

function closePaneMenu() {
  const menu = document.getElementById("paneMenu");
  if (menu) detachDomNode(menu);
  if (paneMenu && paneMenu.button && paneMenu.button.setAttribute) {
    paneMenu.button.setAttribute("aria-expanded", "false");
  }
  paneMenu = null;
}

// ---- tab drag between panes (Phase 5) ----------------------------------
// Editor and git tabs drag between leaves; terminal tabs are the
// singleton surface and never leave their leaf. The caret is a marker
// element the dragover handler moves between tab slots, so the drop
// target is always a concrete index, not an approximate hover.
let paneDragTabId = null;

function paneTabDragStart(event) {
  if (!event || !event.target || !event.target.dataset) return;
  const tabId = event.target.dataset.tabId;
  if (!tabId) return;
  // Terminal tabs refuse the drag: the surface is singular and the
  // backend owns the tab list.
  if (!isEditorTab(tabId) && !isGitTab(tabId)) {
    if (event.preventDefault) event.preventDefault();
    return;
  }
  paneDragTabId = tabId;
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-tab", tabId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  if (event.target.classList && event.target.classList.add) event.target.classList.add("pane-tab-dragging");
}

function paneTabDragEnd() {
  paneDragTabId = null;
  clearPaneDropCaret();
  document.querySelectorAll(".pane-tab-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-tab-dragging");
  });
}

// Which slot does the pointer sit at? Compare the pointer x against each
// tab's midpoint: the caret sits where the dragged tab would land.
function paneDropIndexAt(strip, event, draggedId) {
  const tabs = [...strip.children].filter(
    (child) => child.classList && child.classList.contains && child.classList.contains("pane-tab")
      && !child.classList.contains("pane-tab-dragging")
      && child.dataset.tabId !== draggedId
  );
  const pointerX = event.clientX || 0;
  for (let index = 0; index < tabs.length; index++) {
    const rect = tabs[index].getBoundingClientRect ? tabs[index].getBoundingClientRect() : null;
    if (!rect) continue;
    if (pointerX < rect.left + rect.width / 2) return index;
  }
  return tabs.length;
}

function clearPaneDropCaret() {
  document.querySelectorAll(".pane-drop-caret").forEach(detachDomNode);
}

function paneDropCaretAt(strip, index) {
  clearPaneDropCaret();
  const tabs = [...strip.children].filter(
    (child) => child.classList && child.classList.contains && child.classList.contains("pane-tab")
      && !child.classList.contains("pane-tab-dragging")
  );
  const caret = document.createElement("div");
  caret.className = "pane-drop-caret";
  if (index >= tabs.length) {
    const last = tabs[tabs.length - 1];
    const lastRect = last && last.getBoundingClientRect ? last.getBoundingClientRect() : null;
    const stripRect = strip.getBoundingClientRect ? strip.getBoundingClientRect() : null;
    if (lastRect && stripRect) {
      caret.style.left = `${lastRect.right - stripRect.left}px`;
    }
  } else {
    const rect = tabs[index].getBoundingClientRect ? tabs[index].getBoundingClientRect() : null;
    const stripRect = strip.getBoundingClientRect ? strip.getBoundingClientRect() : null;
    if (rect && stripRect) {
      caret.style.left = `${rect.left - stripRect.left - 1}px`;
    }
  }
  strip.appendChild(caret);
}

function paneStripDragOver(event) {
  if (!paneDragTabId) return;
  // The strip under the pointer owns the caret; hovering pane content
  // targets the same strip's append slot.
  const target = event.target;
  const strip = (target && target.closest ? target.closest(".pane-tab-strip") : null)
    || (target && target.classList && target.classList.contains && target.classList.contains("pane-tab-strip") ? target : null);
  if (!strip) return;
  if (event.preventDefault) event.preventDefault();
  if (event.dataTransfer && "dropEffect" in event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const index = paneDropIndexAt(strip, event, paneDragTabId);
  paneDropCaretAt(strip, index);
  strip.dataset.dropIndex = String(index);
}

function paneStripDrop(event) {
  const tabId = paneDragTabId
    || (event.dataTransfer && event.dataTransfer.getData ? event.dataTransfer.getData("text/herdr-pane-tab") : null);
  const pane = event.target && event.target.closest ? event.target.closest(".workspace-pane") : null;
  const strip = pane && pane.querySelector ? pane.querySelector(".pane-tab-strip") : null;
  paneTabDragEnd();
  if (!tabId || !pane) return;
  if (event.preventDefault) event.preventDefault();
  const paneId = pane.dataset ? pane.dataset.paneId : null;
  const index = strip && strip.dataset ? Number(strip.dataset.dropIndex) : NaN;
  movePaneTabTo(tabId, paneId, Number.isFinite(index) ? index : null);
}

// The actual move: splice from the source leaf, insert into the target
// leaf at the caret index, activate, persist, re-render. Same-leaf moves
// are reorders and stay client-side; a cross-leaf move re-mounts the
// owning module's container into the new content slot.
function movePaneTabTo(tabId, targetPaneId, index) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  if (!isEditorTab(tabId) && !isGitTab(tabId)) return false;
  const source = paneForTab(root, tabId);
  if (!source) return false;
  const leaves = paneLeaves(root);
  let target = targetPaneId ? paneForPaneId(root, targetPaneId) : null;
  if (!target) target = source === leaves[0] && leaves[1] ? leaves[1] : (leaves.find((leaf) => leaf !== source) || source);
  const at = source.tabs.indexOf(tabId);
  if (at < 0) return false;
  if (target === source) {
    if (index == null || index === at || index === at + 1) return true;
    source.tabs.splice(at, 1);
    source.tabs.splice(Math.min(index, source.tabs.length), 0, tabId);
    focusLeaf(root, source);
    saveWorkspacePanesStates();
    renderWorkspacePanes();
    return true;
  }
  source.tabs.splice(at, 1);
  const insertAt = index == null ? target.tabs.length : Math.min(index, target.tabs.length);
  if (!target.tabs.includes(tabId)) target.tabs.splice(insertAt, 0, tabId);
  target.active = tabId;
  source.active = source.tabs[0] || null;
  // Keep the active pointer on the pane receiving the tab: the next
  // sidebar open lands there, matching a click on the moved tab.
  focusLeaf(root, target);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  if (isEditorTab(tabId)) void activateEditorTab(editorTabPath(tabId));
  else if (isGitTab(tabId)) void openGitTab(gitTabViewKey(tabId));
  return true;
}

// Strips re-render on state changes; wire the drag listeners once per
// strip node. The signature gate means a strip node survives renders,
// so a strip already wired never double-binds.
function wirePaneStripDrag(strip) {
  if (!strip || strip.__herdrDragWired) return;
  // Standalone harnesses run fake elements without addEventListener:
  // skip wiring there (the drag pipeline is browser-only anyway).
  if (typeof strip.addEventListener !== "function") return;
  strip.__herdrDragWired = true;
  strip.addEventListener("dragover", (event) => paneStripDragOver(event));
  strip.addEventListener("drop", (event) => paneStripDrop(event));
  strip.addEventListener("dragleave", (event) => {
    if (event.target === strip) clearPaneDropCaret();
  });
  strip.addEventListener("dragend", () => paneTabDragEnd());
}

// ---- split commands (Phase 4) ------------------------------------------
// Wraps the active leaf in a binary split node holding it and a fresh
// empty leaf. The new leaf starts empty: the strip's + stays
// terminal-only, and the terminal singleton means the route terminal
// never leaves its leaf. Focus moves to the new leaf so the next sidebar
// open (file click, git status row) lands there.

function splitActivePane(kind) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  // A split from a maximized pane restores the layout first: the new
  // sibling joins the visible tree instead of mutating a hidden one
  // behind a flat view that would show no change.
  if (maximizedLeaf(root)) {
    const entry = panesStateFor();
    entry.maximizedPaneId = null;
  }
  const leaf = activeLeaf(root);
  if (!leaf) return false;
  const fresh = newEmptyLeaf();
  const next = { kind, sizes: [1, 1], children: [leaf, fresh] };
  const slot = findLeafSlot(root, leaf);
  if (!slot) return false;
  if (slot.holder === "root") {
    const stateEntry = panesStateFor();
    stateEntry.root = next;
  } else {
    slot.holder[slot.index] = next;
  }
  // The swap above may have replaced the root object; re-read it before
  // focusing so activePaneId lands on the tree that actually renders.
  focusLeaf(paneRootFor(), fresh);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
}

// Where a leaf sits in the tree: {holder, index} where holder is "root"
// (the leaf is the root) or the children array containing it.
function findLeafSlot(root, leaf) {
  if (root === leaf) return { holder: "root", index: 0 };
  const walk = (node) => {
    if (!isPaneSplit(node)) return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i] === leaf) return { holder: node.children, index: i };
      const found = walk(node.children[i]);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function splitPaneRight() {
  return splitActivePane("row");
}

function splitPaneDown() {
  return splitActivePane("column");
}

// The immediate split node holding a leaf, or null when the leaf is the
// whole tree (no split yet). Nested leaves answer their innermost parent,
// which is the split the strip buttons act on.
function parentSplitOf(root, leaf) {
  if (!isPaneSplit(root) || !leaf) return null;
  const walk = (node) => {
    if (!isPaneSplit(node)) return null;
    for (const child of node.children) {
      if (child === leaf) return node;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function leafForPaneId(root, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  if (!paneId) return activeLeaf(root);
  return paneForPaneId(root, paneId) || activeLeaf(root);
}

// Strip split buttons: act on the pane whose strip was pressed. When the
// pane already sits inside that split style, flip the parent orientation
// in place instead of nesting a redundant split.
function splitPaneFor(encodedPaneId, kind) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaf = leafForPaneId(root, encodedPaneId);
  if (!leaf) return false;
  const parent = parentSplitOf(root, leaf);
  if (parent && parent.kind !== kind) {
    parent.kind = kind;
    if (maximizedLeaf(root)) panesStateFor().maximizedPaneId = null;
    focusLeaf(root, leaf);
    saveWorkspacePanesStates();
    renderWorkspacePanes();
    return true;
  }
  focusLeaf(root, leaf);
  return splitActivePane(kind);
}

function splitPaneRightFor(encodedPaneId) {
  return splitPaneFor(encodedPaneId, "row");
}

function splitPaneDownFor(encodedPaneId) {
  return splitPaneFor(encodedPaneId, "column");
}

// Strip close button: focus the target leaf and reuse closeActivePane, so
// editor dirty-confirms, terminal handoff, and the split collapse behave
// exactly like the menu close.
function closePaneFor(encodedPaneId) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaf = leafForPaneId(root, encodedPaneId);
  if (!leaf) return false;
  if (paneLeaves(root).length < 2) return false;
  focusLeaf(root, leaf);
  root.activePaneId = leaf.paneId;
  return closeActivePane();
}

// Strip maximize button: the same toggle as the menu entry, scoped to the
// pane whose strip was pressed.
function maximizePaneFor(encodedPaneId) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaf = leafForPaneId(root, encodedPaneId);
  if (!leaf) return false;
  if (paneLeaves(root).length < 2) return false;
  const entry = panesStateFor();
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  else entry.maximizedPaneId = leaf.paneId;
  root.activePaneId = leaf.paneId;
  entry.at = Date.now();
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  return true;
}

// Strip + button: create the backend panel, then place its tab in the pane
// whose strip was pressed. The sync appends unknown terminal ids to the
// terminal leaf, so park the id in the target leaf first and mark it as a
// known placement so the sync keeps it there. Without a workspace there is
// nothing to attach a panel to, so the press routes to the open flow
// instead of dying: the same seeded discovery the dashboard's primary
// action starts.
async function newTabForPane(encodedPaneId) {
  if (!state.ws) {
    // Same typeof guard as the go() references: standalone harnesses
    // load this file alone, without the worktree modal in scope.
    if (typeof openWorktreeOpenModal === "function")
      openWorktreeOpenModal(
        typeof selectedWorkspaceRepoPath === "function" ? selectedWorkspaceRepoPath() : "",
        true,
      );
    return;
  }
  const root = paneRootFor();
  const leaf = paneTreeRenderable(root) ? leafForPaneId(root, encodedPaneId) : null;
  if (typeof newTab === "function") {
    if (leaf) {
      // Terminal ids are the only backend kind; remember where this one
      // belongs before the backend list lands.
      pendingTabPlacements = pendingTabPlacements || new Map();
      pendingTabPlacements.set("__next__", leaf.paneId);
    }
    await newTab();
  }
}

// Where the + button wants the next created terminal tab to live. The
// sync consumes it once so a later plain newTab() is unaffected.
let pendingTabPlacements = null;

// Closes the active leaf. The closed leaf's tabs migrate to the
// survivor instead of dying: the migration target resolves on the
// pre-collapse tree (the sibling leaf for a 2-child parent, else the
// nearest surviving leaf), every tab id appends deduped, and the
// survivor's active pointer heals only when it is null or names a tab
// it no longer holds. The collapse itself is unchanged (sibling
// promoted into the parent slot, single-child splits collapse, wider
// parents splice the leaf out), and the healed active tab re-mounts
// through its owning module so the survivor's content slot shows it.
// Editor containers survive via rescueLiveSurfaces on the collapse
// sweep; no registry close, no container teardown.
async function closeActivePane() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaves = paneLeaves(root);
  if (leaves.length <= 1) return false;
  const leaf = activeLeaf(root);
  if (!leaf) return false;
  // Closing the maximized leaf un-maximizes first: the surviving sibling
  // takes the screen instead of a half-restored layout.
  const entry = panesStateFor();
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  const migration = migrationTargetForClosedLeaf(root, leaf);
  const slot = findLeafSlot(root, leaf);
  if (!slot) return false;
  if (slot.holder === "root") {
    // Leaf was the root: impossible with >1 leaf (a split root holds it).
    return false;
  }
  const holderArray = slot.holder;
  const sibling = holderArray.length === 2 ? holderArray[1 - slot.index] : null;
  // Migration runs before the collapse mutates the tree: the target
  // leaf object stays the same node before and after (promotion only
  // moves the holder slot), so pushing into it now and collapsing next
  // keeps every append on a live node.
  const liveRouteTab = state.tab != null ? String(state.tab) : null;
  if (migration) {
    for (const tabId of [...leaf.tabs])
      if (!migration.tabs.includes(tabId)) migration.tabs.push(tabId);
    // Heal only a null or dangling pointer: a survivor already showing a
    // live tab keeps it. When the pointer must heal, the route terminal
    // tab wins first (the terminal singleton keeps its home), else the
    // first migrated tab.
    if (!migration.active || !migration.tabs.includes(migration.active))
      migration.active = (liveRouteTab && migration.tabs.includes(liveRouteTab) ? liveRouteTab : migration.tabs[0]) || null;
  }
  if (sibling) {
    // Replace the whole parent: the grandparent slot or root takes the
    // sibling directly (single-child collapse).
    const parentSlot = findSplitSlot(root, holderArray);
    if (!parentSlot) return false;
    if (parentSlot.holder === "root") {
      const stateEntry = panesStateFor();
      stateEntry.root = sibling;
    } else {
      parentSlot.holder[parentSlot.index] = sibling;
    }
  } else {
    // More than two children: just remove this leaf; sizes re-normalize
    // on the next render (reconcile writes grows from sizes, normalize
    // repairs length drift).
    holderArray.splice(slot.index, 1);
    const stateEntry = panesStateFor();
    normalizeEntryRoot(stateEntry);
  }
  // Re-mount the healed active tab in the survivor: the collapse moved
  // the survivor's pane element, and the owning module re-parents its
  // container into the fresh content slot on mount. Terminal tabs need
  // no remount call: syncTerminalTabsIntoTree re-seeds them and the
  // render moves #terminalShell itself.
  const liveRoot = paneRootFor();
  focusLeaf(liveRoot, activeLeaf(liveRoot) || paneLeaves(liveRoot)[0]);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  if (migration && migration.active) {
    if (isEditorTab(migration.active)) void activateEditorTab(editorTabPath(migration.active));
    else if (isGitTab(migration.active)) void openGitTab(gitTabViewKey(migration.active));
    else if (typeof go === "function" && state.tab !== migration.active)
      go(state.ws, migration.active);
  }
  return true;
}

// The leaf that inherits the closing leaf's tabs, resolved on the
// pre-collapse tree. A 2-child parent hands them to the sibling; when
// that sibling is itself a split, its edge leaf nearest the closed pane
// takes them (last leaf of the subtree when the closed pane sat before
// it, first leaf when it sat after). Wider parents pick the nearest
// surviving neighbor's edge leaf.
function migrationTargetForClosedLeaf(root, leaf) {
  const slot = findLeafSlot(root, leaf);
  if (!slot || slot.holder === "root") return null;
  const holderArray = slot.holder;
  if (holderArray.length === 2) {
    const sibling = holderArray[1 - slot.index];
    if (isPaneLeaf(sibling)) return sibling;
    if (isPaneSplit(sibling)) {
      const siblingLeaves = paneLeaves(sibling);
      return slot.index === 0 ? siblingLeaves[siblingLeaves.length - 1] : siblingLeaves[0];
    }
    return null;
  }
  const after = holderArray.slice(slot.index + 1);
  const before = holderArray.slice(0, slot.index).reverse();
  const firstAfter = after.map(paneLeaves).find((list) => list.length);
  const firstBefore = before.map(paneLeaves).find((list) => list.length);
  return (firstAfter && firstAfter[0])
    || (firstBefore && firstBefore[firstBefore.length - 1])
    || paneLeaves(root).find((l) => l !== leaf) || null;
}

function normalizeEntryRoot(stateEntry) {
  const repaired = normalizePaneTree(stateEntry.root);
  if (repaired) stateEntry.root = repaired;
}

// The slot holding the split node whose children array is childrenArray:
// {holder: "root"} when the split is the root, else the children array
// and the index of the split inside it. closeActivePane swaps the whole
// split for the promoted sibling, so the slot must name the split node,
// not its children (an indexOf on the children array never finds it).
function findSplitSlot(root, childrenArray) {
  if (isPaneSplit(root) && root.children === childrenArray) return { holder: "root", index: 0 };
  const walk = (node) => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (isPaneSplit(child)) {
        if (child.children === childrenArray) return { holder: node.children, index: i };
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  return isPaneSplit(root) ? walk(root) : null;
}

// Moves the active tab to the next leaf in tree order (wraps). Terminal
// tabs refuse: exactly one #terminalShell surface exists and its tab
// stays in the terminal leaf. The moved-to leaf takes focus and the tab
// pointer.
function moveActiveTabToNextPane() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaves = paneLeaves(root);
  if (leaves.length <= 1) return false;
  const leaf = activeLeaf(root);
  if (!leaf || !leaf.active) return false;
  const tabId = leaf.active;
  if (!isEditorTab(tabId) && !isGitTab(tabId)) return false;
  const index = leaves.indexOf(leaf);
  const target = leaves[(index + 1) % leaves.length];
  if (!target) return false;
  if (target === leaf) return false;
  const at = leaf.tabs.indexOf(tabId);
  if (at >= 0) leaf.tabs.splice(at, 1);
  if (!target.tabs.includes(tabId)) target.tabs.push(tabId);
  target.active = tabId;
  leaf.active = leaf.tabs[0] || null;
  focusLeaf(root, target);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  // The moved tab's module mounts its container into the new leaf's
  // content slot: re-run the module's mount for the active tab.
  if (isEditorTab(tabId)) void activateEditorTab(editorTabPath(tabId));
  else if (isGitTab(tabId)) void openGitTab(gitTabViewKey(tabId));
  return true;
}

// ---- terminal tab labels (moved from panel_switcher.js, Phase 5) ----
// The old workspace-row panel field rendered these; the pane strip is
// the only surface now, so the label helpers live with the strip.
function isDefaultPanelTitle(label) {
  const value = String(label || "").trim().toLowerCase();
  return !value || value === "shell" || value === "terminal" || /^tab\s+\d+$/.test(value);
}

function panelNumberLabel(tab, index, tabs = state.tabs || []) {
  const number = Number(tab && tab.number);
  if (Number.isFinite(number) && number > 0) return String(number);
  const fallbackIndex = Number.isFinite(index)
    ? index
    : tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
  return String((fallbackIndex >= 0 ? fallbackIndex : 0) + 1);
}

function panelVisibleLabel(tab, index, tabs = state.tabs || []) {
  const label = String((tab && tab.label) || "").trim();
  return isDefaultPanelTitle(label) ? panelNumberLabel(tab, index, tabs) : label;
}

function panelRenameInitialLabel(tab) {
  const label = String((tab && tab.label) || "").trim();
  return isDefaultPanelTitle(label) ? "" : label;
}

function paneTabStatusHtml(tab) {
  const active = tab.tab_id === state.tab;
  return `<span class="pane-tab-dot ${active ? "on" : ""}" aria-hidden="true"></span>`;
}

function tabHoverTitle(tab) {
  try {
    return tabHoverInfo(tab, panesByTabIndex());
  } catch (_) {
    return tabTitle(tab);
  }
}

// ---- editor tab lifecycle ----------------------------------------------
// openEditorTab ensures the tab exists in the active pane and activates it.
// The pane tree only stores identity; the file browser module (ensured
// loaded before any real open) owns per-file state and mounts the editor
// container into the pane content slot.
function paneRootFor(id = state.ws) {
  return panesStateFor(id).root;
}

function paneEnsureEditorTab(path) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const tabId = editorTabId(path);
  // Same one-owner rule as git tabs: a strip click on a non-active pane
  // focuses the owning leaf instead of duplicating the id into the
  // active one.
  const owner = paneForTab(root, tabId);
  const leaf = owner || activeLeaf(root);
  if (!leaf) return null;
  if (owner) {
    owner.active = tabId;
    focusLeaf(root, owner);
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  } else if (!leaf.tabs.includes(tabId)) {
    leaf.tabs.push(tabId);
    // The strip must show the placeholder right away: the file browser's
    // render path is gated on its drawer being open, so a render here is
    // the only guarantee when the open comes from a menu or shortcut.
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  }
  return leaf;
}

async function ensureFileBrowserModule() {
  // Bare-function guard: the loader lives in the concatenated bundle scope;
  // standalone-VM tests boot without it and use the HerdrFileBrowser stub.
  if (typeof ensureFileBrowserLoaded === "function") await ensureFileBrowserLoaded();
  return window.HerdrFileBrowser;
}

async function openEditorTab(path, searchHighlight) {
  if (!path) return;
  const id = String(path);
  paneEnsureEditorTab(id);
  const registry = await ensureFileBrowserModule();
  if (!registry || !registry.openEditorTab) {
    // Module failed to load: drop the placeholder so the strip does not
    // keep a dead tab around.
    closeEditorTabImmediate(encodeURIComponent(id));
    return;
  }
  await registry.openEditorTab(id, searchHighlight || null);
}

function closeEditorTabImmediate(encodedPath) {
  let path = encodedPath;
  try { path = decodeURIComponent(encodedPath); }
  catch (_) {}
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return;
  const tabId = editorTabId(path);
  const leaf = paneForTab(root, tabId);
  if (!leaf) return;
  const index = leaf.tabs.indexOf(tabId);
  if (index >= 0) leaf.tabs.splice(index, 1);
  if (leaf.active === tabId) {
    leaf.active = leaf.tabs[index] || leaf.tabs[index - 1] || leaf.tabs[0] || null;
    if (isEditorTab(leaf.active)) void activateEditorTab(editorTabPath(leaf.active));
    else if (isGitTab(leaf.active)) void openGitTab(gitTabViewKey(leaf.active));
    else if (leaf.active && typeof go === "function") go(state.ws, leaf.active);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  teardownEditorTab(encodedPath);
}

// The registry's teardown callback: after this tree dropped a tab id, the
// per-file state (editor cache, CodeMirror instance, container node) is
// released too. Called by closeEditorTabImmediate only; the registry's
// own closeEditorTab runs its teardown itself after confirming.
function teardownEditorTab(encodedPath) {
  const registry = window.HerdrFileBrowser;
  if (registry && registry.closeEditorState)
    registry.closeEditorState(decodeURIComponentSafe(encodedPath));
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return String(value || ""); }
}

// Close from the strip's ✕: route through the registry when loaded so the
// dirty confirm (same wording as the legacy open-file tab) runs before the
// tab disappears. The registry confirms, then calls closeEditorTabImmediate
// back to drop the tab id, then runs its own state teardown. Without the
// module (placeholder tab) close immediately and teardown is a no-op.
async function closeEditorTab(encodedPath) {
  const registry = window.HerdrFileBrowser;
  if (registry && registry.closeEditorTab) {
    await registry.closeEditorTab(encodedPath);
    return;
  }
  closeEditorTabImmediate(encodedPath);
}

// ---- git tab lifecycle --------------------------------------------------
// openGitTab ensures the git:<view-key> tab exists in the active pane and
// hands the open to git_ui (loaded lazily like the file browser). The pane
// tree owns identity; git_ui owns per-view state and renders renderMain
// into the tab's container.
function paneEnsureGitTab(viewKey) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const tabId = gitTabId(viewKey);
  // A tab id belongs to one leaf. An open request while another leaf
  // owns the id (strip click on a non-active pane, drawer nav) must
  // focus that leaf, not mint a second tab: a duplicate id desyncs the
  // strip from the container mount and leaves one pane blank.
  const owner = paneForTab(root, tabId);
  const leaf = owner || activeLeaf(root);
  if (!leaf) return null;
  if (owner) {
    // Clicking a tab that lives in another pane focuses that pane and
    // activates the tab there: the module mount follows the owner, and
    // the pointer move holds even when the module open bails later
    // (closed drawer, load failure).
    owner.active = tabId;
    focusLeaf(root, owner);
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  } else if (!leaf.tabs.includes(tabId)) {
    leaf.tabs.push(tabId);
    // Same immediate-render contract as editor tabs: the git drawer's
    // render path is gated on the drawer being open.
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  }
  return leaf;
}

async function ensureGitUiModule() {
  // Same bare-function guard as the file browser: the loader lives in the
  // concatenated bundle scope; standalone-VM tests boot without it.
  if (typeof ensureGitUiLoaded === "function") await ensureGitUiLoaded();
  return window.HerdrGitUi;
}

async function openGitTab(viewKey) {
  if (!viewKey) return;
  paneEnsureGitTab(String(viewKey));
  const gitUi = await ensureGitUiModule();
  if (!gitUi || !gitUi.openViewTab) {
    // Module failed to load: drop the placeholder so the strip does not
    // keep a dead tab around.
    closeGitTabImmediate(String(viewKey));
    return;
  }
  await gitUi.openViewTab(String(viewKey));
}

// Mirror of closeEditorTabImmediate for git tabs. Teardown releases the
// tab's container node; per-view git state is cheap to refetch on reopen,
// so no registry round-trip is needed.
function closeGitTabImmediate(viewKey) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return;
  const tabId = gitTabId(viewKey);
  const leaf = paneForTab(root, tabId);
  if (!leaf) return;
  const index = leaf.tabs.indexOf(tabId);
  if (index >= 0) leaf.tabs.splice(index, 1);
  if (leaf.active === tabId) {
    leaf.active = leaf.tabs[index] || leaf.tabs[index - 1] || leaf.tabs[0] || null;
    if (isEditorTab(leaf.active)) void activateEditorTab(editorTabPath(leaf.active));
    else if (isGitTab(leaf.active)) void openGitTab(gitTabViewKey(leaf.active));
    else if (leaf.active && typeof go === "function") go(state.ws, leaf.active);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  const container = document.getElementById(paneGitMountId(viewKey));
  if (container && container.remove) container.remove();
  const gitUi = window.HerdrGitUi;
  if (gitUi && gitUi.releaseViewTab) gitUi.releaseViewTab(String(viewKey));
}

function closeGitTab(viewKey) {
  closeGitTabImmediate(decodeURIComponentSafe(viewKey));
}

async function activateEditorTab(path) {
  const registry = await ensureFileBrowserModule();
  if (registry && registry.openEditorTab) {
    await registry.openEditorTab(path);
    return;
  }
  closeEditorTabImmediate(encodeURIComponent(path));
}

// The file browser / git_ui call this after mounting the editor so the pane
// tree records which tab is active (strip highlight + content mount).
// Explicit beats the boot route sync: an editor opened this tick keeps the
// pointer even when the route still names a terminal panel. The tab's
// owning leaf takes the pane focus too, so the next open lands beside it.
function setActivePaneTab(tabId) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root) || !tabId) return;
  const leaf = paneForTab(root, tabId) || activeLeaf(root);
  if (!leaf) return;
  sawExplicitActive = true;
  leaf.active = tabId;
  focusLeaf(root, leaf);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
}

function activatePaneTab(tabId) {
  if (!tabId) return;
  // A tab click on the maximize rail's stub (hidden sibling) restores
  // the layout first: the open paths below must target the clicked
  // tab's own leaf, not the maximized one. The same-tab early return
  // below never re-renders, so the restore renders here.
  const root = paneRootFor();
  const maxLeaf = maximizedLeaf(root);
  if (maxLeaf) {
    const owner = paneForTab(root, tabId);
    if (owner && owner !== maxLeaf) {
      panesStateFor().maximizedPaneId = null;
      focusLeaf(root, owner);
      saveWorkspacePanesStates();
      renderWorkspacePanes();
    }
  }
  if (isEditorTab(tabId)) {
    void activateEditorTab(editorTabPath(tabId));
    return;
  }
  if (isGitTab(tabId)) {
    void openGitTab(gitTabViewKey(tabId));
    return;
  }
  // Same-route clicks are not a no-op: the tree pointer can sit on an
  // editor or git tab while the route stayed on this panel (opening a
  // file or git view does not navigate). Clicking the strip's terminal
  // tab must take the highlight and the content slot back from it.
  if (tabId === state.tab) {
    if (paneActiveTab() !== tabId) setActivePaneTab(tabId);
    return;
  }
  go(state.ws, tabId);
}

// Moves the existing #terminalShell node into the pane content slot by
// reference (no-op when already in place) for terminal tabs. Editor and
// git tabs park #terminalShell outside the content slot: their module
// mounts the active tab's container there instead. Only the active tab's
// surface is in the content slot; switching tabs swaps which node owns
// it. The pane tree owns the center surface while a non-terminal tab is
// active; other modules (git drawer legacy path, right sidebar host)
// check this before writing #terminalShell.style.display so they do not
// fight the active tab's ownership of the content slot.
function paneNonTerminalTabActive() {
  const active = paneActiveTab();
  return isEditorTab(active) || isGitTab(active);
}

// Stale editor and git containers must not keep painting behind whatever
// owns the content slot now. The owning module hides its siblings on
// mount, but nothing hid them on the terminal side of a switch. The keep
// node (the tab the pane just claimed) stays visible.
function hideStalePaneContainers(content, keepNode) {
  const containers = content.querySelectorAll
    ? [...content.querySelectorAll(".pane-editor-container"), ...content.querySelectorAll(".pane-git-container")]
    : [];
  for (const node of containers) {
    if (node === keepNode) continue;
    if (node.style) node.style.display = "none";
  }
}

// Zero-tab workspace body mount, same skeleton contract as the dashboard:
// shown moves #workspaceEmptyLeaf into the pane's content slot (strip
// hidden), hidden restores the app.html home and unhides strips so the
// next render pass works unchanged.
function mountEmptyLeafInPane(shown) {
  const container = el("workspacePanes");
  const emptyLeaf = el("workspaceEmptyLeaf");
  if (!container || !emptyLeaf) return;
  if (!shown) {
    if (emptyLeaf.parentElement && emptyLeaf.parentElement !== container)
      container.appendChild(emptyLeaf);
    // The dashboard may own the slot in the no-workspace state: its own
    // mount pass hides the strips, and restoring here would undo it in
    // the same render.
    if (!dashboardOwnsPaneArea()) unhidePaneStrips(container);
    return;
  }
  const root = paneRootFor();
  let pane = null;
  if (isPaneSplit(root)) {
    const leaf = activeLeaf(root) || paneLeaves(root)[0];
    pane = leaf ? paneLeafElement(container, root, leaf) : null;
  } else {
    pane = [...container.children].find((child) => hasClass(child, "workspace-pane"));
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "workspace-pane";
      pane.dataset.paneId = root.paneId || "root";
      const strip = document.createElement("div");
      strip.className = "pane-tab-strip";
      strip.setAttribute("role", "tablist");
      strip.setAttribute("aria-label", "Pane tabs");
      pane.appendChild(strip);
      const content = document.createElement("div");
      content.className = "pane-content";
      pane.appendChild(content);
      container.appendChild(pane);
    }
  }
  if (!pane) return;
  const strip = pane.querySelector(".pane-tab-strip");
  if (strip) strip.hidden = true;
  const content = pane.querySelector(".pane-content");
  if (content && emptyLeaf.parentElement !== content) content.appendChild(emptyLeaf);
}

function mountPaneTabContent(pane, leafArg, auxTabs) {
  const content = pane.querySelector(".pane-content");
  if (!content) return;
  // The no-workspace dashboard owns the pane area: every layout node
  // is gone by the time a pane render runs, and the seeded
  // default-folder leaf would otherwise re-create a skeleton and claim
  // the singleton shell under the takeover.
  if (dashboardOwnsPaneArea()) {
    parkTerminalShellHome();
    return;
  }
  const root = paneRootFor();
  const leaf = leafArg || activeLeaf(root);
  if (!leaf) return;
  const activeTab = leaf.active;
  const activeIsTerminal = !!activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab);
  const aux = window.HerdrPaneTerminals;
  const releaseAuxForThisLeaf = () => {
    if (aux && activeTab) aux.releaseForTab(activeTab);
  };
  const terminalShell = el("terminalShell");
  // Reshape commands (split, flip, maximize, close-promote) move pane
  // elements around without calling back into the owning module, so
  // the active editor/git container can sit parked in #workspacePanes
  // while its pane shows a blank slot. Claim it here on every render for
  // any editor/git-active leaf (owner or not): find the container by
  // its mount id, re-parent it into this leaf's content slot, show it,
  // and hide every stale container. The owning module's own mount
  // (openEditorTab / openViewTab) does the same thing on an explicit
  // tab open; this pass keeps the claim true across reshapes.
  if (!activeIsTerminal) {
    const claimContainer = activeTab && (isEditorTab(activeTab) || isGitTab(activeTab))
      ? document.getElementById(isEditorTab(activeTab)
        ? paneEditorMountId(editorTabPath(activeTab))
        : paneGitMountId(gitTabViewKey(activeTab)))
      : null;
    if (claimContainer) {
      if (claimContainer.parentElement !== content) content.appendChild(claimContainer);
      if (claimContainer.style) claimContainer.style.display = "";
      hideStalePaneContainers(content, claimContainer);
    }
  }
  // One owner per render hosts #terminalShell (terminalShellOwnerLeaf:
  // the route tab's leaf, else the first terminal-active leaf, else the
  // seeded/active leaf). Every other leaf leaves the shell alone, so two
  // terminal-active leaves cannot fight over the node across passes and
  // the shell never ping-pongs between sibling slots render to render.
  // Single-leaf trees resolve the owner to the only leaf, keeping the
  // Phase 3b/3c behavior exactly.
  const owner = terminalShellOwnerLeaf(root);
  if (leaf !== owner) {
    // Not the owner: never host the shell here. A stale render may have
    // left it inside this leaf's slot; move it back to the persistent
    // home so the owner's pass can re-parent it by reference. Display
    // stays untouched: the owner branch decides visibility.
    if (terminalShell && terminalShell.parentElement === content) {
      const panesContainer = el("workspacePanes");
      if (panesContainer) panesContainer.appendChild(terminalShell);
    }
    if (activeIsTerminal) {
      hideStalePaneContainers(content);
      // Split sibling with its own terminal panel: mount an auxiliary
      // surface so both panes render live terminals instead of leaving
      // this slot blank. ensureForLeaf re-parents an existing surface
      // (reshape) and only creates when this leaf has none yet.
      // Editor/git actives keep their container claim above and release
      // any aux from an earlier tab in the else branch.
      if (aux && activeTab && activeTab !== TERMINAL_TAB_PLACEHOLDER) {
        aux.ensureForLeaf(pane, leaf);
        if (auxTabs) auxTabs.push(activeTab);
      }
    } else {
      releaseAuxForThisLeaf();
    }
    return;
  }
  if (!activeIsTerminal) {
    // The owner shows an editor or git tab: the owning module's container
    // claims the slot. Keep the shell alive but out of the pane:
    // #workspacePanes is the persistent home (the same container the
    // Phase 1 layout parked it in before the pane skeleton existed). The
    // shell must move out of .pane-content too, not just stay wherever it
    // was: a terminal render left it inside the slot, and a hidden shell
    // parked in the content slot breaks the one-surface-per-slot
    // invariant splits rely on. The container claim above already
    // re-parented and showed the active tab's container.
    releaseAuxForThisLeaf();
    if (terminalShell) {
      const panesContainer = el("workspacePanes");
      if (panesContainer && terminalShell.parentElement !== panesContainer) {
        if (terminalShell.parentElement) terminalShell.parentElement.removeChild(terminalShell);
        panesContainer.appendChild(terminalShell);
      }
      if (terminalShell.style) terminalShell.style.display = "none";
    }
    return;
  }
  if (terminalShell && terminalShell.style) terminalShell.style.display = "";
  if (content && terminalShell && terminalShell.parentElement !== content)
    content.appendChild(terminalShell);
  hideStalePaneContainers(content);
  // The primary shell took this tab over: its aux surface, if any from an
  // earlier non-owner render, disposes.
  releaseAuxForThisLeaf();
}

// ---- no-workspace dashboard mount ---------------------------------
// With no workspace the pane skeleton itself is dead chrome: strips,
// dividers, and per-leaf slots reference nothing, so the mount still
// drops every layout node from #workspacePanes and parks the terminal
// shell home, hidden. But the dashboard card no longer paints in the
// center: it lives in the left sidebar, inside the Workspaces pane's
// scroll area under the (empty) workspace list, because that is exactly
// the state it describes. hide returns the node to the app.html home
// and lets the next render pass rebuild the pane layout.

function dashboardSidebarHome() {
  // The Workspaces pane core.js builds: its scroll area owns the
  // dashboard in the empty state, right after the workspace list, so
  // the card scrolls with the sidebar instead of filling the center.
  const pane = el("workspacePane");
  if (!pane) return null;
  return pane.querySelector(".sidebar-scroll") || pane;
}

function detachPaneLayoutNodes(container) {
  // The pane render owns these classes; anything else (the app.html
  // id siblings, rescued surfaces, the shell) stays.
  const isLayoutNode = (node) =>
    hasClass(node, "workspace-pane") ||
    hasClass(node, "pane-row") ||
    hasClass(node, "pane-column") ||
    hasClass(node, "pane-strip-rail") ||
    hasClass(node, "pane-divider");
  for (const child of [...(container.children || [])]) {
    if (isLayoutNode(child)) {
      rescueLiveSurfaces(container, child);
      detachDomNode(child);
    }
  }
}

function unhidePaneStrips(container) {
  const strips = container.querySelectorAll
    ? container.querySelectorAll(".pane-tab-strip")
    : [];
  for (const strip of strips) strip.hidden = false;
}

// The dashboard and the empty-leaf card both claim a pane content slot,
// and each mount's hide branch restores strips for the normal pane
// render. Two surfaces, one slot: when the other surface still holds a
// pane content slot (its own show pass just ran, or runs next in the
// same render), a strip restore here would clobber its strip-hide in the
// same tick. The owner is whoever is mounted in a .pane-content right
// now, so the restore only fires when the pane is truly free.
function surfaceMountedInPaneContent(surface) {
  if (!surface || surface.hidden) return false;
  let parent = surface.parentElement;
  while (parent) {
    if (hasClass(parent, "pane-content")) return true;
    parent = parent.parentElement;
  }
  return false;
}

// The dashboard decides its own strip hiding, not mount order: with no
// workspace, syncProjectDashboard clears the hidden attr BEFORE it moves
// the node into the pane, so a same-render surfaceMountedInPaneContent
// check in mountEmptyLeafInPane can miss the takeover and restore the
// strip over it. Ask the deciding function instead: strips hide exactly
// when the dashboard is shown.
function dashboardOwnsPaneArea() {
  const dashboard = el("projectDashboard");
  return !!(dashboard && !dashboard.hidden);
}

// The dashboard owns the whole pane area in the empty state, so the
// terminal shell must not share the column: park it at the
// #workspacePanes home, hidden, exactly like the non-owner branches of
// mountPaneTabContent do. Keeping it visible would stack dead chrome
// under the dashboard and shrink it to half the column.
function parkTerminalShellHome() {
  const shell = el("terminalShell");
  const container = el("workspacePanes");
  if (!shell || !container) return;
  if (shell.parentElement && shell.parentElement !== container)
    container.appendChild(shell);
  if (shell.style) shell.style.display = "none";
}

function mountDashboardInPane(shown) {
  const container = el("workspacePanes");
  const dashboard = el("projectDashboard");
  if (!container || !dashboard) return;
  const sidebarHome = dashboardSidebarHome();
  if (!shown) {
    if (dashboard.parentElement && dashboard.parentElement !== container)
      container.appendChild(dashboard);
    // The empty-leaf card may own the slot in the zero-tab workspace
    // state: its own mount pass hides the strips, and restoring here
    // would undo it in the same render.
    const emptyLeaf = el("workspaceEmptyLeaf");
    if (!surfaceMountedInPaneContent(emptyLeaf)) unhidePaneStrips(container);
    return;
  }
  // Empty state: the center pane skeleton is dead chrome, so drop every
  // layout node (strips, dividers, per-leaf slots, split wrappers) and
  // park the shell home, hidden, exactly as before. The dashboard card
  // itself moves to the sidebar Workspaces pane: the list is empty in
  // this state, and the card is the pane's content there.
  detachPaneLayoutNodes(container);
  parkTerminalShellHome();
  if (sidebarHome && dashboard.parentElement !== sidebarHome)
    sidebarHome.appendChild(dashboard);
}

// ---- divider drag (Phase 4) -------------------------------------------
// Pointer events on the .pane-divider update the split's flex-grow
// children live; pointerup writes the final numbers back into the tree
// node's sizes and persists. The divider remembers its parent split
// element and its preceding child, so one handler serves every divider.

function wireDividerDrag(divider) {
  if (!divider || !divider.addEventListener) return;
  let dragging = null;
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const parent = divider.parentElement;
    if (!parent) return;
    const growChildren = [...parent.children].filter((child) =>
      !hasClass(child, "pane-divider"));
    // The divider resizes the child before it; previousElementSibling is
    // unavailable on the node-test stubs, so resolve via children order.
    const previous = divider.previousElementSibling
      || (parent.children || []).filter((c) => !hasClass(c, "pane-divider"))
        .filter((c) => (parent.children || []).indexOf(c) < (parent.children || []).indexOf(divider)).pop();
    const index = growChildren.indexOf(previous);
    if (index !== 0 || growChildren.length !== 2) return;
    dragging = { parent, growChildren, startX: event.clientX, startY: event.clientY, starts: growChildren.map((child) => parseFloat(child.style.flexGrow) || 1) };
    divider.setPointerCapture && divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    // pane-column stacks children vertically: the divider lies flat and
    // the drag walks the parent's height.
    const verticalStack = String(dragging.parent.className || "").includes("pane-column");
    const total = dragging.starts[0] + dragging.starts[1];
    const rect = dragging.parent.getBoundingClientRect();
    const delta = verticalStack ? event.clientY - dragging.startY : event.clientX - dragging.startX;
    const axisSize = Math.max(1, verticalStack ? rect.height : rect.width);
    const fraction = Math.max(0.1, Math.min(0.9, (dragging.starts[0] / total) + delta / axisSize));
    dragging.growChildren[0].style.flexGrow = String(fraction * total);
    dragging.growChildren[1].style.flexGrow = String((1 - fraction) * total);
  });
  const finish = () => {
    if (!dragging) return;
    const sizes = dragging.growChildren.map((child) => parseFloat(child.style.flexGrow) || 1);
    writeDividerSizes(dragging.parent, sizes);
    dragging = null;
    // Aux terminal surfaces sized their grid to the pre-drag box; refit
    // them to the new slot size (the primary shell refits separately).
    if (window.HerdrPaneTerminals && typeof window.HerdrPaneTerminals.fitAll === "function")
      window.HerdrPaneTerminals.fitAll();
  };
  divider.addEventListener("pointerup", finish);
  divider.addEventListener("pointercancel", finish);
}

// Maps a split element back to its tree node via the splitId chain and
// stores the dragged sizes. The splitId path encodes the tree position,
// so the lookup walks the same path the renderer used.
function writeDividerSizes(splitElement, sizes) {
  const root = paneRootFor();
  const path = String(splitElement.dataset.splitId || "");
  const node = findSplitByPath(root, path);
  if (!node) return;
  node.sizes = sizes;
  saveWorkspacePanesStates();
}

function findSplitByPath(root, path) {
  if (!path) return null;
  // Walk building the same id paths the renderer wrote: children extend
  // their parent's path, so the lookup is a plain structural match.
  const walk = (node, id) => {
    if (!isPaneSplit(node)) return null;
    if (id === path) return node;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (!isPaneSplit(child)) continue;
      const found = walk(child, `${id}/${splitNodeId(child, i)}`);
      if (found) return found;
    }
    return null;
  };
  return walk(root, splitNodeId(root, 0));
}

// The active leaf's .workspace-pane element, the mount target for the
// module that owns the active tab (editor container, git view
// container). Null when the layout has not materialized yet.
function activePaneElement() {
  const container = el("workspacePanes");
  const root = paneRootFor();
  if (!container) return null;
  const leaf = activeLeaf(root);
  if (!leaf) return null;
  return paneLeafElement(container, root, leaf);
}

// The pane element that owns tabId: the mount target for editor and git
// containers. Resolves the owning leaf's element so a mount follows its
// tab (a strip click focuses the owner first); falls back to the active
// pane when the tree has not recorded the tab yet (fresh opens).
function paneElementForTab(tabId) {
  const container = el("workspacePanes");
  const root = paneRootFor();
  if (!container || !tabId) return null;
  const owner = paneForTab(root, tabId);
  if (owner) return paneLeafElement(container, root, owner);
  return activePaneElement();
}

window.HerdrWorkspacePanes = {
  panesStateFor,
  paneRoot,
  paneTabs,
  paneActiveTab,
  renderWorkspacePanes,
  activatePaneTab,
  openEditorTab,
  closeEditorTab,
  closeEditorTabImmediate,
  setActivePaneTab,
  editorTabId,
  editorTabPath,
  isEditorTab,
  gitTabId,
  gitTabViewKey,
  gitTabLabel,
  gitTabTitle,
  isGitTab,
  openGitTab,
  closeGitTab,
  closeGitTabImmediate,
  paneGitMountId,
  paneEditorMountId,
  paneElementForTab,
  editorTabActive: paneNonTerminalTabActive,
  nonTerminalTabActive: paneNonTerminalTabActive,
  openPaneEditorFind,
  saveWorkspacePanesStates,
  forgetWorkspacePanes,
  // Phase 4: split tree surface. paneLeaves/activePane expose the tree
  // walk; the commands are the strip buttons and shortcuts' entry points.
  paneLeaves,
  activePane: () => activeLeaf(paneRootFor()),
  activePaneElement,
  splitPaneRight,
  splitPaneDown,
  closeActivePane,
  moveActiveTabToNextPane,
  // Phase 5: maximize + the [⋮] kind-aware pane menu.
  maximizeActivePane,
  paneIsMaximized,
  togglePaneMenu,
  closePaneMenu,
  // Phase 5: tab drag between panes.
  movePaneTabTo,
  paneDropIndexAt,
  // p6: per-strip controls targeting the pressed pane.
  splitPaneRightFor,
  splitPaneDownFor,
  closePaneFor,
  maximizePaneFor,
  newTabForPane,
  paneMenuItemsFor,
  syncTerminalTabsIntoTree,
  terminalShellOwnerLeaf,
  mountDashboardInPane,
  mountEmptyLeafInPane,
};
