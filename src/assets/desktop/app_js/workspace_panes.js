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
// chars, and master sorts first when it is one of the two sides. A hash
// that is a branch tip resolves to branch[Head] when git_ui has the log
// loaded (the hook scans loaded log data); without data the 7-char form
// stays, so strip labels never depend on load state.
function branchHeadLabel(ref) {
  const hook = typeof window !== "undefined" && window.HerdrGitUi && window.HerdrGitUi.branchHeadLabel;
  return hook ? String(hook(ref) || "") : "";
}

function shortGitRef(refs) {
  const value = String(refs || "").trim();
  if (!value) return "current";
  const parts = value.split("..");
  const label = (part) => {
    if (part === "." || part === "") return "current";
    const head = branchHeadLabel(part);
    if (head) return head;
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
  // The master-first rule tests the branch name, so a master tip shown as
  // master[Head] still sorts first without losing its head marker.
  const sortKey = (label) => label.replace(/\[Head\]$/, "");
  if (sortKey(target) === "master") return `gitcmp ${target} vs ${base}`;
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
  return `<button class="pane-tab git ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="git" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(gitTabTitle(viewKey))}" onclick="activatePaneTab('${escapeAttr(tabId)}')" onauxclick="paneTabAuxClick(event,'git','${escapeAttr(viewKey)}')"><span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close Git view" aria-label="Close Git view" onclick="event.stopPropagation();closeGitTab('${escapeAttr(viewKey)}')">✕</span></button>`;
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
  return `<button class="pane-tab editor ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="editor" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(path)}" onclick="activatePaneTab('${escapeAttr(tabId)}')" onauxclick="paneTabAuxClick(event,'editor','${escapeAttr(encoded)}')">${dirty ? '<span class="pane-tab-dirty" title="Modified" aria-hidden="true">●</span>' : ""}<span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close file" aria-label="Close file" onclick="event.stopPropagation();closeEditorTab('${escapeAttr(encoded)}')">✕</span></button>`;
}

// Session-global tree store (D1): ONE tree per session whose leaves host
// tabs from any workspace. The per-workspace keying died with the mixed
// tree: a workspace switch no longer swaps the layout under the user,
// and a foreign workspace's panel is just another tab in a leaf. The
// store key is fixed; workspace membership lives in the tab rows, and
// the workspace-close sweep (pruneWorkspaceTabsFromPanes) drops closed
// ids from THIS tree.
const SESSION_PANES_KEY = "__session__";

// Per-render-pass lookup memo. renderWorkspacePanes installs it once the
// sweep and the terminal sync settle the tree, and the finally clears it,
// so per-strip reads during the paint (row resolution, known-id prune,
// mixed-tree flag, hover pane map) hit maps built once per pass instead of
// re-scanning state.tabs/allTabs/panes per tab. Guards inside the four
// readers keep out-of-pass callers (render.js top bar, VM harnesses, the
// sync internals before install) computing fresh, exactly as before.
// Never carried across renders: rows mutate between ticks, so a stale
// memo would answer the previous snapshot.
// Declaration must precede loadWorkspacePanesStates(): the load path's
// wsId healing reaches paneTerminalTabById's guard while a later let
// would sit in its temporal dead zone and the swallowed ReferenceError
// would skip the stored-tree import.
let panePassLookups = null;

// rows: the first state.tabs row per id, then tabsById rows fill the
// misses (the precedence paneTerminalTabById applies). known: every id
// any of the four sources carries (tabs, tabsById, panesById, allTabs).
// treeMixed: precomputed here against the settled root so badge and
// prefix reads never re-walk the tree. panesByTab: built lazily on the
// first hover-title read of the pass, mirroring panesByTabIndex.
function buildPanePassLookups(root) {
  const rows = new Map();
  for (const tab of state.tabs || []) {
    if (tab && !rows.has(tab.tab_id)) rows.set(tab.tab_id, tab);
  }
  if (state.tabsById) {
    for (const [id, row] of Object.entries(state.tabsById)) {
      if (row && typeof row === "object" && !rows.has(id)) rows.set(id, row);
    }
  }
  const known = new Set();
  for (const tab of state.tabs || []) if (tab) known.add(tab.tab_id);
  if (state.tabsById) for (const id of Object.keys(state.tabsById)) known.add(id);
  if (state.panesById) for (const id of Object.keys(state.panesById)) known.add(id);
  for (const tab of state.allTabs || []) if (tab) known.add(tab.tab_id);
  return { rows, known, panesByTab: null, treeMixed: treeIsMixedFor(root) };
}

function panesStateFor() {
  if (!state.workspacePanes[SESSION_PANES_KEY]) {
    state.workspacePanes[SESSION_PANES_KEY] = {
      root: newLeaf("p1"),
      at: Date.now(),
    };
  }
  return state.workspacePanes[SESSION_PANES_KEY];
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

// Split ids share the counter pattern: one session tree, one namespace,
// persistence keeps the minted ids stable across reloads.
let splitIdCounter = 0;
const usedSplitIds = new Set();

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

// The fan-out's empty space: a marked slot leaf waiting for a label
// drop. The mark rides saveWorkspacePanesStates and isGroupSlot keys on
// BOTH the flag and emptiness, so a populated slot self-unmarks even
// if a stale flag survived a blob.
function newGroupSlotLeaf(wsId) {
  const leaf = newEmptyLeaf();
  leaf.groupSlot = true;
  if (wsId) leaf.wsId = wsId;
  return leaf;
}

// Panel leaves bind one workspace (collector model): wsId rides the
// leaf so tabs, focus, and the location bar all resolve through the
// panel instead of the global selection. Old blobs without wsId heal in
// normalizePaneTree. null wsId means unbound (fresh session leaf, no
// workspace opened yet).
function newPanelLeaf(wsId) {
  const leaf = newEmptyLeaf();
  leaf.wsId = wsId || null;
  return leaf;
}

function leafWsId(leaf) {
  return (leaf && leaf.wsId) || null;
}

// Which workspace a leaf's content belongs to. Bound leaves answer
// their wsId; a blob healed without rows (offline boot, stub tests)
// falls back to the first terminal tab row, else the selected ws. This
// is the routing truth for focus, close, and sidebar resolution.
function leafWorkspaceId(leaf) {
  const bound = leafWsId(leaf);
  if (bound) return bound;
  for (const tabId of (leaf && leaf.tabs) || []) {
    if (isEditorTab(tabId) || isGitTab(tabId)) continue;
    const row = paneTerminalTabById(tabId);
    const ws = row && row.workspace_id;
    if (ws) return ws;
  }
  return null;
}

function leavesBoundTo(root, wsId) {
  if (!wsId) return [];
  return paneLeaves(root).filter((leaf) => leafWorkspaceId(leaf) === wsId);
}

// The leaf the location bar describes and commands act on. Pane focus
// writes this pointer; a missing pointer heals to the first leaf.
function focusedLeaf(root = paneRootFor()) {
  if (!paneTreeRenderable(root)) return null;
  return activeLeaf(root);
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
    // Loaded splits keep their minted id: re-register it so newSplitId
    // never mints a duplicate across reloads.
    if (root.splitId) usedSplitIds.add(root.splitId);
    root.sizes = root.children.map((_, i) => (Number.isFinite(root.sizes[i]) && root.sizes[i] > 0 ? root.sizes[i] : 1));
    return root;
  }
  if (isPaneLeaf(root)) {
    if (!root.paneId) {
      do root.paneId = `p${++paneIdCounter}`;
      while (usedPaneIds.has(root.paneId));
    }
    // Restored ids must REGISTER like minted ones: the counter starts at
    // 0 in a fresh bundle, so an unregistered p1 from storage lets the
    // next split mint a SECOND p1. paneForPaneId/activeLeaf then resolve
    // whichever duplicate comes first in tree order, and focus, Enter
    // minting, and the DOM reconcile (panes keyed by id) all act on the
    // wrong leaf. Duplicates in a corrupt blob keep the first: the
    // second registration is idempotent on a Set.
    usedPaneIds.add(root.paneId);
    // wsId healing (collector migration): legacy blobs carry no wsId.
    // Bind from the first terminal row that resolves, so the sync's
    // home ladder and the ws sweep see a real binding. Leaves with only
    // editor/git ids or empty leaves stay null (adoption binds them
    // later). state.tabs may be empty at load (offline boot, stub
    // tests): leafWorkspaceId re-derives from rows each call, so a
    // later snapshot still heals via the sync's adoption pass.
    if (!root.wsId) {
      for (const tabId of root.tabs || []) {
        if (isEditorTab(tabId) || isGitTab(tabId)) continue;
        const row = paneTerminalTabById(tabId);
        const ws = row && row.workspace_id;
        if (ws) {
          root.wsId = ws;
          break;
        }
      }
    }
    return root;
  }
  return null;
}

function loadWorkspacePanesStates() {
  try {
    // The store holds ONE session tree now (previously one entry per
    // workspace). Old multi-entry blobs load the FIRST entry as the
    // session tree (the boot workspace's layout, D1 migration: pane
    // layouts are cheap to rebuild, other stored trees drop) and the
    // sync's terminalTabKnown prune sweeps stale ids on the first
    // snapshot.
    const raw = localStorage.getItem(WORKSPACE_PANES_STORAGE_KEY);
    if (!raw) {
      localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
      return;
    }
    const parsed = JSON.parse(raw);
    const entry = parsed && typeof parsed === "object" ? parsed[SESSION_PANES_KEY] || Object.values(parsed)[0] : null;
    if (entry && entry.root) {
      const root = normalizePaneTree(entry.root);
      if (root) {
        // D13 reset, collector refinement: an all-empty tree whose
        // leaves carry NO workspace binding is a ghost (every id closed
        // in a previous session, nothing adopted since) and resets to
        // the single default pane. Empty panels with a live binding are
        // real panels the user left and restore as-is.
        const leaves = paneLeaves(root);
        const restorable = leaves.some((leaf) => (leaf.tabs && leaf.tabs.length) || leafWsId(leaf));
        state.workspacePanes[SESSION_PANES_KEY] = {
          root: restorable ? root : newLeaf("p1"),
          at: entry.at || Date.now(),
          maximizedPaneId: null,
        };
      }
    }
    localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

function saveWorkspacePanesStates() {
  try {
    // The session tree is the only entry now. It persists whenever it
    // exists, no open-workspace gate: the tree survives the last
    // workspace closing (an empty tree resets itself on load) and a
    // dashboard boot (tree simply not created yet).
    // v3.2: the auto-close arming is gesture-scoped runtime state, not
    // layout. A persisted marker would auto-close a panel at the NEXT
    // boot's first render (no gesture behind it). It drops out of the
    // BLOB only (replacer below), never off the live tree: every arm
    // path saves before rendering, and the render-top sweep still needs
    // the marker to find its victim.
    const stripArmed = (key, value) => (key === "autoCloseArmed" ? undefined : value);
    const live = {};
    if (state.workspacePanes[SESSION_PANES_KEY])
      live[SESSION_PANES_KEY] = state.workspacePanes[SESSION_PANES_KEY];
    if (Object.keys(live).length) localStorage.setItem(WORKSPACE_PANES_STORAGE_KEY, JSON.stringify(live, stripArmed));
    else localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

// A closed workspace no longer deletes a tree (there is only the one
// session tree): its ids leave through pruneWorkspaceTabsFromPanes, and
// the tree itself survives to host the remaining workspaces' panels.
// Legacy per-workspace entries from older sessions are dropped here.
function forgetWorkspacePanes(id) {
  for (const key of Object.keys(state.workspacePanes || {})) {
    if (key !== SESSION_PANES_KEY) delete state.workspacePanes[key];
  }
  saveWorkspacePanesStates();
}

// Eager teardown for a closing workspace (D10): its bound panels leave
// the tree NOW, not on the next refresh tick. Between close and tick
// the strips would render dead ids with close buttons that POST against
// vanished panels. Editor/git ids ride the dropped leaf (client-owned,
// no re-home target once the ws is gone). Single-leaf-tree guard: the
// collector keeps one panel to render; the sync's adoption pass rebinds
// it to the next workspace that opens.
function pruneWorkspaceTabsFromPanes(workspaceId) {
  if (!workspaceId) return false;
  let changed = false;
  for (const key of Object.keys(state.workspacePanes || {})) {
    const entry = state.workspacePanes[key];
    const root = entry && entry.root;
    if (!root) continue;
    const doomed = paneLeaves(root).filter((leaf) => leafWorkspaceId(leaf) === workspaceId);
    if (!doomed.length) continue;
    if (paneLeaves(root).length === doomed.length) {
      // Every panel belonged to the closing ws: keep the tree but empty
      // it, so the collector renders one panel ready for adoption. The
      // sweep collapses the armed empties down to that one survivor.
      for (const leaf of doomed) {
        leaf.tabs = [];
        leaf.active = null;
        leaf.wsId = null;
        // Wipe any decay stamp with the tabs: a pre from before the close
        // must not fire on whatever the adoption pass lands next.
        leaf.autoClosePre = null;
        armLeafAutoClose(leaf);
      }
      changed = true;
      continue;
    }
    for (const leaf of doomed) {
      if (dropLeafFromTree(leaf)) changed = true;
    }
  }
  if (changed) saveWorkspacePanesStates();
  return changed;
}

loadWorkspacePanesStates();

function paneRoot() {
  return panesStateFor().root;
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
    return terminalTabKnown(tabId);
  });
}

function paneTerminalTabById(tabId) {
  // Pass memo: rows already merge the tabs list and the unfiltered map in
  // the same first-wins precedence, so one Map hit replaces the list scan
  // plus the tabsById probe for every strip tab of a paint.
  if (panePassLookups) {
    const row = panePassLookups.rows.get(tabId);
    return row && typeof row === "object" ? row : null;
  }
  const local = (state.tabs || []).find((tab) => tab.tab_id === tabId);
  if (local) return local;
  // The unfiltered map covers rows the workspace filter dropped: the
  // tree is workspace-scoped today, but a stored id of another workspace
  // must still resolve (its strip renders, its prune rule holds). Older
  // servers ship no map; the local miss then reads as unknown, same as
  // before.
  const unfiltered = state.tabsById && state.tabsById[tabId];
  return unfiltered && typeof unfiltered === "object" ? unfiltered : null;
}

// The workspace a terminal tab belongs to. The mixed tree (D1) hosts
// ids from any workspace, so routing/indicators must resolve the row's
// own workspace_id, never assume state.ws. Missing row (snapshot race,
// editor/git id): keep the selected workspace.
function workspaceIdForTab(tabId) {
  if (!tabId) return state.ws;
  const row = paneTerminalTabById(tabId);
  return (row && row.workspace_id) || state.ws;
}

// Prune rule (D10): a stored terminal id is dead only when it is absent
// from BOTH the workspace-filtered list (state.tabs) and the unfiltered
// maps (tabsById/panesById, plus allTabs as the pre-map fallback). A
// snapshot race (filtered list refreshed, maps still stale) must not
// drop a live id, and a genuinely closed id must drop from every leaf.
function terminalTabKnown(tabId) {
  if (!tabId) return false;
  // Pass memo: the known set folds all four sources (tabs, tabsById,
  // panesById, allTabs) with the same key coverage hasOwnProperty gives,
  // so the per-tab prune drops to one Set hit during a paint.
  if (panePassLookups) return panePassLookups.known.has(tabId);
  if ((state.tabs || []).some((tab) => tab.tab_id === tabId)) return true;
  if (state.tabsById && Object.prototype.hasOwnProperty.call(state.tabsById, tabId)) return true;
  if (state.panesById && Object.prototype.hasOwnProperty.call(state.panesById, tabId)) return true;
  if ((state.allTabs || []).some((tab) => tab.tab_id === tabId)) return true;
  return false;
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
  const seeded = rendered.find((leaf) => leaf.tabs.some((id) => id === TERMINAL_TAB_PLACEHOLDER || terminalTabKnown(id)));
  return seeded || rendered[0];
}

// Every live terminal id across every workspace (D1 sync universe):
// filtered rows first (order = backend truth), then ids only the
// unfiltered maps know (rows the workspace filter dropped). The
// pre-map fallback keeps old servers working.
function allKnownTerminalIds() {
  const ids = (state.tabs || []).map((tab) => String(tab.tab_id));
  const seen = new Set(ids);
  const extra = (state.tabsById && Object.keys(state.tabsById)) || [];
  for (const id of extra) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  for (const tab of state.allTabs || []) {
    const id = String(tab.tab_id);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// Per-id home resolution (collector model): a terminal id lives in a
// panel bound to its workspace. The ladder for a homeless id of ws W:
// the pending placement pane (a + or Enter pressed on a panel), the
// focused leaf bound to W, the first leaf bound to W, an available
// unbound leaf (boot seed or legacy blob, adoption binds it), else a
// fresh panel minted beside the focused one. Minting keeps the
// invariant: a ws with live terminals always has a panel.
function terminalHomeLeafFor(wsId) {
  const root = paneRootFor();
  const leaves = paneLeaves(root);
  if (pendingTabPlacements && pendingTabPlacements.has("__next__")) {
    const pending = paneForPaneId(root, pendingTabPlacements.get("__next__"));
    if (pending && (leafWorkspaceId(pending) === wsId || leafWorkspaceId(pending) === null)) {
      // The + contract: a placement wins even on an unbound panel. A
      // fresh split leaf is unbound by construction, and rejecting its
      // placement (the strict same-ws check) would route the new
      // terminal into the first bound sibling instead, stranding the
      // fresh panel empty forever. Unbound = adoptable for any ws,
      // same as the ladder's adoption step below.
      if (leafWorkspaceId(pending) === null) pending.wsId = wsId;
      // Consuming the placement is the acceptance: shed any marker a
      // gesture minted on this pane since the + press, the incoming id
      // refills it either way.
      disarmLeafAutoClose(pending);
      pendingTabPlacements.delete("__next__");
      return pending;
    }
    pendingTabPlacements.delete("__next__");
  }
  const focused = activeLeaf(root);
  if (focused && leafWorkspaceId(focused) === wsId) return focused;
  const bound = leaves.find((leaf) => leafWorkspaceId(leaf) === wsId);
  if (bound) return bound;
  const available = leaves.find((leaf) => leafWorkspaceId(leaf) === null);
  if (available) {
    available.wsId = wsId;
    // v3.2: adoption is a role change, not an abandonment. A stale arm
    // from an earlier gesture (the leaf sat empty before this ws picked
    // it up) must not fold the workspace's new anchor panel the moment
    // focus moves on; the ws binding IS the refill.
    disarmLeafAutoClose(available);
    return available;
  }
  return mintPanelForWorkspace(wsId, focused || leaves[0]);
}

// Structural mint: the fresh panel wraps beside the anchor leaf (nest
// semantics, row by default) so the reshape is one node deep, same as
// the explicit split commands. Returns the minted leaf; caller lands
// the ids and the route sync moves focus when the route points here.
// A mint can REPLACE the root object (anchor was the root leaf), so the
// sync loop re-reads paneRootFor() every iteration after this runs.
function mintPanelForWorkspace(wsId, anchor) {
  const fresh = newPanelLeaf(wsId);
  const entry = panesStateFor();
  if (!anchor) {
    entry.root = fresh;
    return fresh;
  }
  const slot = findLeafSlot(entry.root, anchor);
  if (!slot) return fresh;
  const nested = { kind: "row", sizes: [1, 1], children: [anchor, fresh] };
  if (slot.holder === "root") entry.root = nested;
  else slot.holder[slot.index] = nested;
  return fresh;
}

function syncTerminalTabsIntoTree(root) {
  // Collector sync: every workspace's live ids (state.tabs filtered rows,
  // tabsById/allTabs unfiltered) resolve their home per workspace. The
  // one-home rule stays global (an id already in a leaf keeps it), a
  // homeless id walks terminalHomeLeafFor's ladder, and dead ids prune
  // from every leaf. Empty panels never collapse: a leaf emptied by the
  // prune stands as an empty panel until its workspace closes or the
  // user closes it.
  const allBackendIds = allKnownTerminalIds();
  const routeTab = state.tab != null ? String(state.tab) : null;
  let changed = false;
  for (const id of allBackendIds) {
    // paneRootFor() per iteration: a mint can replace the root object
    // mid-pass, and the next id must resolve against the live tree.
    const root = paneRootFor();
    const owner = paneForTab(root, id);
    if (owner) continue;
    const row = paneTerminalTabById(id);
    const wsId = (row && row.workspace_id) || null;
    // No workspace row resolvable (snapshot race, foreign server state):
    // leave the id homeless for this pass rather than binding it to a
    // wrong panel; the next snapshot decides.
    if (!wsId) continue;
    const home = terminalHomeLeafFor(wsId);
    if (!home) continue;
    if (!home.tabs.includes(id)) {
      home.tabs.push(id);
      // v3.2: an adopted id refills the panel; an armed auto-close from
      // an earlier emptying gesture must not fire on the refill.
      disarmLeafAutoClose(home);
      // Refill clears the slot mark: a spawned/adopted panel is a view.
      delete home.groupSlot;
      changed = true;
    }
    if (!home.active) home.active = id;
  }
  // Workspace sweep: a closed workspace's bound leaves are dead
  // weight. Drop them (editor/git ids are client-owned, nothing can
  // re-home them; the whole workspace went). Gated on backendOnline:
  // the offline path in refresh() wipes state.workspaces BEFORE render,
  // and an offline tick must not erase stored panels. First successful
  // refreshOnline flips the flag true; the offline catch resets it.
  // leafWorkspaceId (not the raw wsId) decides, so a legacy unhealed
  // blob holding only rows of the dead ws drops too.
  if (state.backendOnline) {
    const liveWsIds = new Set((state.workspaces || []).map((w) => String(w.workspace_id)));
    let sweepGuard = paneLeaves(paneRootFor()).length + 1;
    while (sweepGuard-- > 0) {
      const deadLeaf = paneLeaves(paneRootFor()).find((leaf) => {
        const wsId = leafWorkspaceId(leaf);
        return !!wsId && !liveWsIds.has(wsId);
      });
      if (!deadLeaf) break;
      if (dropLeafFromTree(deadLeaf)) changed = true;
    }
  }
  // Tail passes re-read the root: the placement loop above may have
  // minted a panel and REPLACED the root object mid-pass, and the ws
  // sweep may have collapsed wrappers. Every read below names the live
  // tree.
  const liveRoot = paneRootFor();
  if (allBackendIds.length) {
    // D7.1 repair rule: exactly one owner leaf per terminal id. A mid-drag
    // crash, a stale stored tree, or a legacy blob can leave an id in two
    // leaves. The FIRST leaf in tree order wins the id, every later copy
    // drops. Editor/git ids are client-owned with no uniqueness
    // constraint and never enter this pass.
    const ownerLeafById = new Map();
    for (const leaf of paneLeaves(liveRoot)) {
      const kept = [];
      for (const id of leaf.tabs) {
        if (isEditorTab(id) || isGitTab(id)) {
          kept.push(id);
          continue;
        }
        if (!terminalTabKnown(id)) {
          kept.push(id);
          continue;
        }
        if (ownerLeafById.has(id)) {
          changed = true;
          continue;
        }
        ownerLeafById.set(id, leaf);
        kept.push(id);
      }
      leaf.tabs = kept;
    }
    // Prune closed backend ids from every leaf. The prune rule is
    // terminalTabKnown (D10): an id missing from the filtered list but
    // present in the unfiltered maps is live (snapshot race), and only an
    // id missing from BOTH drops.
    // v3.2: the prune emptied a leaf, so the panel armed for
    // auto-close on the next render; the collector's last-panel and
    // focused-leaf sweep guards still protect the tree's anchor.
    for (const leaf of paneLeaves(liveRoot)) {
      const was = leaf.tabs;
      const kept = was.filter((id) => isEditorTab(id) || isGitTab(id) || terminalTabKnown(id));
      if (kept.length !== was.length) {
        // Decay fold stamp before the prune rewrites the leaf's labels.
        leaf.autoClosePre = autoClosePreStateFor(liveRoot, leaf);
        leaf.tabs = kept;
        // v3.2: arm only when a REAL id dropped. The terminal
        // placeholder is the strip binding every minted leaf carries and
        // the first sync resolves; pruning it is bookkeeping, not an
        // abandonment, and arming on it would sweep away seed leaves and
        // fresh splits the moment their placeholder resolves. A real
        // backend id leaving the leaf empty is a genuine close. The
        // emptiness half of the rule lives in armLeafAutoClose's guard
        // (one owner); only the real-id predicate is local to the prune.
        if (was.some((id) => id !== TERMINAL_TAB_PLACEHOLDER))
          armLeafAutoClose(leaf);
        changed = true;
      }
    }
  }
  // Route sync: a navigation that names a live panel takes the active
  // pointer of the leaf that OWNS the route tab. Writing elsewhere and
  // relying on the heal below would fight: the heal sees the pointer
  // missing from that leaf's tabs and clobbers it one tick later.
  // focusLeaf moves the pane focus so the next open lands in the route
  // tab's panel.
  const routeChanged = lastSyncedRouteTab !== routeTab;
  const routeIsLivePanel = !!(routeTab && terminalTabKnown(routeTab));
  const bootSyncWithFreshActivation = lastSyncedRouteTab === undefined && sawExplicitActive;
  const routeOwner = routeTab ? paneForTab(liveRoot, routeTab) : null;
  if (routeChanged && routeIsLivePanel && !bootSyncWithFreshActivation && routeOwner && routeOwner.active !== routeTab) {
    routeOwner.active = routeTab;
    focusLeaf(liveRoot, routeOwner);
    changed = true;
  }
  lastSyncedRouteTab = routeTab;
  sawExplicitActive = false;
  // Route focus-or-mint (collector): a ws-only route (sidebar click,
  // workspace switch with no tab named) must land on a panel of that
  // workspace. Focus its focused-or-first bound panel; when the ws has
  // no panel at all, ADOPT an unbound panel before minting: fresh
  // splits and boot leaves are unbound by construction, and minting
  // beside them would grow the tree on every workspace open (the same
  // adoption ladder terminalHomeLeafFor runs for tabs). Only a tree
  // whose every panel belongs to another workspace mints. Skips when a
  // tab route exists (the owner-leaf pass above owns that case) and
  // when no tree is renderable yet (dashboard boot).
  if (routeChanged && !routeTab && state.ws) {
    const target = paneRootFor();
    if (paneTreeRenderable(target)) {
      const bound = leavesBoundTo(target, state.ws);
      if (bound.length) {
        if (!bound.some((leaf) => leaf === activeLeaf(target))) {
          focusLeaf(target, bound[0]);
          changed = true;
        }
      } else {
        const focused = activeLeaf(target);
        const unbound =
          focused && !leafWorkspaceId(focused)
            ? focused
            : paneLeaves(target).find((leaf) => !leafWorkspaceId(leaf)) || null;
        if (unbound) {
          unbound.wsId = state.ws;
          // v3.2: same disarm as the tab-adoption ladder. The unbound
          // leaf may carry a stale arm from a pre-adoption gesture;
          // the ws binding refills its role, so the sweep must not fold
          // the newly anchored panel on a later focus move.
          disarmLeafAutoClose(unbound);
          focusLeaf(target, unbound);
          changed = true;
        } else {
          const fresh = mintPanelForWorkspace(state.ws, focused || paneLeaves(target)[0]);
          if (fresh) {
            focusLeaf(paneRootFor(), fresh);
            changed = true;
          }
        }
      }
    }
  }
  // Stale-pointer heal for every leaf: the prune above may have dropped
  // the active id, and the owner-focused pointer must not outlive its
  // tab. Fallback order: a surviving editor/git/terminal tab first,
  // else the first remaining tab, else null when the leaf emptied out
  // (an empty panel keeps active null by design). Re-reads the root:
  // the focus-or-mint above may have replaced it.
  for (const leaf of paneLeaves(paneRootFor())) {
    if (!leaf.tabs.includes(leaf.active)) {
      const nextActive = leaf.tabs.find((id) => isEditorTab(id) || isGitTab(id) || terminalTabKnown(id)) || leaf.tabs[0] || null;
      if (leaf.active !== nextActive) {
        leaf.active = nextActive;
        changed = true;
      }
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

// Split wrappers reconcile by a persistent splitId, never by tree
// index: an extend splice (tmux model) shifts sibling indices, and an
// index-keyed wrapper would tear down and rebuild nested subtrees,
// orphaning live containers. The id mints once and persists in storage.
function newSplitId() {
  do splitIdCounter++;
  while (usedSplitIds.has(`s${splitIdCounter}`));
  const id = `s${splitIdCounter}`;
  usedSplitIds.add(id);
  return id;
}

function splitNodeId(node) {
  if (!node.splitId) node.splitId = newSplitId();
  return node.splitId;
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
    isPaneSplit(child) ? `${idPath}/${splitNodeId(child)}` : (child.paneId || `p?${i}`));
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
      ensureDivider(element, dividerFor, node.kind);
    }
  });
  // Extend splices fresh panes mid-array while reuse keeps existing
  // mounts where they sat, so DOM order can drift from tree order (the
  // pressed pane's old neighbor ends up before the newcomer, and
  // dividers straddle the wrong pair). Enforce the interleaved
  // sequence (pane, divider, pane, ...) once, by identity: on a stable
  // tree the walk matches and nothing moves.
  const expected = [];
  node.children.forEach((child, i) => {
    const mount = [...element.children].find((c) => c.dataset && c.dataset.paneId === childIds[i]);
    if (mount) expected.push(mount);
    if (i < node.children.length - 1) {
      const divider = [...element.children].find((c) => c.dataset && c.dataset.dividerFor === childIds[i + 1]);
      if (divider) expected.push(divider);
    }
  });
  expected.forEach((want, i) => {
    if (element.children[i] !== want) element.insertBefore(want, element.children[i] || null);
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
  // A kind never changes after creation now (tmux model: same-kind
  // presses extend, other-kind presses nest, nothing flips), but the
  // check stays: the aria orientation must match the split's current
  // kind even if a future edit path reuses a divider node.
  const orientation = kind === "row" ? "vertical" : "horizontal";
  if (divider.setAttribute && divider.getAttribute("aria-orientation") !== orientation)
    divider.setAttribute("aria-orientation", orientation);
  if (divider.__herdrWired !== element) {
    wireDividerDrag(divider);
    divider.__herdrWired = element;
  }
  return divider;
}

// One-time drag wiring on the collector container for the label drag
// (v4: the chip drag is gone; the tab drag owns the whole payload).
// Signature-gated so every render pass costs one boolean check. The vm
// harnesses run fake elements without addEventListener: skip wiring
// there, same contract as wirePaneStripDrag.
function wirePanelChipDrag(container) {
  if (!container || container.__herdrPanelDragWired) return;
  if (typeof container.addEventListener !== "function") return;
  container.__herdrPanelDragWired = true;
  container.addEventListener("dragenter", (event) => {
    // Chrome only fires drop when the current target's last dragenter or
    // dragover was canceled. A fast release right after crossing an element
    // boundary can arrive with no dragover yet; cancel dragenter too or
    // those releases drop into the void.
    paneContainerTabDragOver(event);
  });
  container.addEventListener("dragover", paneContainerTabDragOver);
  container.addEventListener("drop", paneContainerTabDrop);
  // dragleave fires on every child boundary crossing; the preview only
  // clears when the pointer truly leaves the collector (relatedTarget
  // outside it), so a pane-edge hover does not flicker the square.
  container.addEventListener("dragleave", (event) => {
    const related = event.relatedTarget;
    if (!related || (typeof related.closest === "function" && !related.closest("#workspacePanes"))) {
      clearPanelDropPreview();
      armPaneDragDwell(null);
      syncPaneDwellOutline(container, null);
    }
  });
}

// The collapsed group split inside a tree: the render walk checks the
// root's flat children and every nested split, one stamp at most (the
// collapse writes it on a single split).
function findCollapsedGroupSplit(node) {
  if (!node || !isPaneSplit(node)) return null;
  if (isCollapsedGroup(node)) return node;
  for (const child of node.children || []) {
    const found = findCollapsedGroupSplit(child);
    if (found) return found;
  }
  return null;
}

// Collapsed paint: one flat pane for the dock, strip carrying ONLY the
// group chip (the member labels stay hidden until the chip's press
// re-expands them), content mounting the dock's active view like any
// focused pane. The pane keeps the dock's real paneId so strip
// commands and focus resolve to the live leaf.
function renderCollapsedGroupInto(container, split) {
  const root = paneRoot();
  const dock = collapsedGroupDock(root, split);
  if (!dock) return;
  // Stale split chrome from the expanded paint must go: the rescue pass
  // parks live surfaces (#terminalShell, editor/git containers) before
  // the drop, the same cleanup close-promote relies on.
  [...container.children].forEach((child) => {
    if (hasClass(child, "pane-row") || hasClass(child, "pane-column") || hasClass(child, "pane-strip-rail")) {
      rescueLiveSurfaces(container, child);
      detachDomNode(child);
    }
  });
  let pane = findPaneElementById(container, dock.paneId);
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "workspace-pane";
    pane.dataset.paneId = dock.paneId;
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
  pane.dataset.paneId = dock.paneId;
  const stripHtml = collapsedGroupChipHtml(split, dock);
  const strip = pane.querySelector(".pane-tab-strip");
  if (strip && strip.__herdrPaneSignature !== stripHtml) {
    strip.__herdrPaneSignature = stripHtml;
    strip.innerHTML = stripHtml;
  }
  markCurrentWorkspacePane(pane, dock);
  if (typeof wirePaneStripDrag === "function") wirePaneStripDrag(strip);
}

// The collapsed group chip: the group's name (renameable), counting the
// dock's folded panels. Click expands; double-click renames, same trio
// contract as the live group chip.
function collapsedGroupChipHtml(split, dock) {
  // The chip keeps the group's EXPANDED name: it counts the member
  // views (the foldedHome records, one entry per view), never the
  // dock's label stack (the dock's own labels rode the collector and
  // never counted as members before the collapse either). A view whose
  // labels all closed while collapsed drops out of the count. Legacy
  // stamps without the records fall back to the dock's label count.
  const foldedHome = (split.groupCollapsed && split.groupCollapsed.foldedHome) || null;
  const viewCount = foldedHome
    ? Object.values(foldedHome).filter((ids) => (ids || []).some((id) => terminalTabKnown(id))).length
    : leafTerminalLabelCount(dock);
  const name = split.groupName || `Group ${viewCount} panels`;
  const title = `${name} (double-click to rename, click to expand)`;
  const encodedSplit = encodeURIComponent(splitNodeId(split));
  if (state.editingPaneGroup === splitNodeId(split)) {
    return `<input class="pane-group-rename-input" aria-label="Rename panel group" value="${escapeAttr(state.editingPaneGroupValue || "")}"${typeof inputAttrs === "function" ? inputAttrs("done") : ""} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitCollapsedGroupRename('${escapeAttr(encodedSplit)}')" oninput="state.editingPaneGroupValue=this.value" onkeydown="collapsedGroupRenameKey(event,'${escapeAttr(encodedSplit)}')">`;
  }
  return `<button class="pane-panel-chip pane-panel-group-chip pane-panel-group-collapsed" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" data-split-id="${escapeAttr(splitNodeId(split))}" onclick="event.preventDefault();expandCollapsedGroup('${escapeAttr(encodedSplit)}')" ondblclick="startCollapsedGroupRename('${escapeAttr(encodedSplit)}')">${escapeHtml(name)}</button>`;
}

// Rename trio for the collapsed chip, mirroring startPaneGroupRename
// but keying the split directly: the dock paneId routes strip
// commands, the splitId routes the collapsed rename.
function startCollapsedGroupRename(encodedSplit) {
  const splitId = decodeURIComponent(String(encodedSplit || ""));
  const split = findSplitById(paneRootFor(), splitId);
  if (!split || !isCollapsedGroup(split)) return;
  state.editingPaneGroup = splitId;
  state.editingPaneGroupValue = split.groupName || "";
  renderWorkspacePanes();
  setTimeout(() => {
    if (state.editingPaneGroup !== splitId) return;
    const input = document.querySelector(".pane-group-rename-input");
    if (input && input.select) input.select();
  }, 0);
}

function commitCollapsedGroupRename(encodedSplit) {
  const splitId = decodeURIComponent(String(encodedSplit || ""));
  const split = findSplitById(paneRootFor(), splitId);
  const value = (state.editingPaneGroupValue || "").trim();
  if (split) {
    if (value) split.groupName = value;
    else delete split.groupName;
    saveWorkspacePanesStates();
  }
  state.editingPaneGroup = null;
  state.editingPaneGroupValue = "";
  renderWorkspacePanes();
}

function collapsedGroupRenameKey(event, encodedSplit) {
  if (!event) return;
  if (event.key === "Enter") commitCollapsedGroupRename(encodedSplit);
  else if (event.key === "Escape") {
    state.editingPaneGroup = null;
    state.editingPaneGroupValue = "";
    renderWorkspacePanes();
  }
}

function renderWorkspacePanes() {
  const container = el("workspacePanes");
  if (!container) return;
  wirePanelChipDrag(container);
  // The no-workspace dashboard owns the container: no pane skeleton
  // renders until a workspace opens, or the takeover would rebuild
  // dead chrome right after the dashboard mount pass detached it.
  if (dashboardOwnsPaneArea()) return;
  const treeRoot = paneRoot();
  if (!paneTreeRenderable(treeRoot)) return;
  // v3.2 auto-close runs BEFORE the tree read: the sweep collapses
  // panels EMPTIED by a gesture (armed at the emptying site: moves,
  // drops, closes, backend prunes), and the render below must paint the
  // settled tree, never a tree mid-collapse. Every emptying path
  // renders (poll ticks, focus gestures, moves, closes), so this one
  // hook covers them all; the focused leaf and the tree's last panel
  // survive by the sweep's own guards, and fresh splits (never armed)
  // stay standing.
  if (sweepAbandonedEmptyLeaves()) {
    if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
    if (window.HerdrPaneFocus && typeof window.HerdrPaneFocus.applyFocusClasses === "function")
      window.HerdrPaneFocus.applyFocusClasses();
  }
  // Re-read after the sweep: a collapse can replace the root object
  // (sibling promoted, wrappers flattened), and the paint below must
  // target the live tree, not the pre-sweep snapshot.
  const settledRoot = paneRoot();
  syncTerminalTabsIntoTree(settledRoot);
  // Per-pass lookups (see panePassLookups above) exist only for the paint
  // below: installed after the sweep and the sync settled the tree, and
  // restored in the finally even when a mount call throws, so no caller
  // outside this pass can read a stale memo.
  const savedPassLookups = panePassLookups;
  panePassLookups = buildPanePassLookups(settledRoot);
  try {
    // A maximized leaf renders alone: the tree is untouched and the next
    // toggle restores the full layout. The flat single-pane path also keeps
    // every existing caller that assumes one .workspace-pane working.
    const maxLeaf = maximizedLeaf(settledRoot);
    const root = maxLeaf || settledRoot;
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
    // A collapsed group paints its dock pane ALONE: the member views and
    // slots stand in the tree (one press on the group chip restores
    // them), but the base rule is one visualised panel, so the split
    // chrome stays hidden while collapsed. The dock keeps its strip
    // labels folded away: only the group chip renders, pressing it
    // re-expands the group (renderCollapsedGroupInto).
    const collapsedSplit = !maxLeaf && isPaneSplit(settledRoot) ? findCollapsedGroupSplit(settledRoot) : null;
    if (collapsedSplit) {
      renderCollapsedGroupInto(container, collapsedSplit);
    } else if (!maxLeaf && isPaneSplit(settledRoot)) {
      reconcileSplitNode(container, settledRoot, splitNodeId(settledRoot));
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
    cleanupAbandonedLayout(container, root, collapsedSplit ? [collapsedGroupDock(root, collapsedSplit)].filter(Boolean) : null);
    // Maximize keeps the hidden siblings' strips reachable: one stub pane
    // per non-maximized leaf under a rail, strips only. No content mount:
    // the loop below runs on the effective root, so sibling surfaces keep
    // their dispose-on-hide lifecycle until a rail click restores.
    if (maxLeaf) renderPaneStripRail(container, settledRoot, maxLeaf);
    // Every leaf mounts its active tab: strips render everywhere, and the
    // terminal leaf mounts/parks the one #terminalShell surface. A leaf
    // whose active tab is editor/git keeps its own module container (the
    // owning module mounts it); mountPaneTabContent only decides where the
    // terminal shell lives and which stale containers hide.
    const auxTabs = [];
    // A collapsed group mounts its dock only: the member views hold no
    // surface while collapsed (their ids sit in the dock's strip), so
    // the walk covers the painted panes, never the hidden tree.
    const mountLeaves = collapsedSplit ? [collapsedGroupDock(settledRoot, collapsedSplit)].filter(Boolean) : paneLeaves(root);
    mountLeaves.forEach((leaf) => {
      const pane = paneLeafElement(container, root, leaf);
      if (pane) {
        // renderCollapsedGroupInto already painted this strip (group
        // chip only); renderLeafInto would overwrite it with the folded
        // member labels and break the hidden-while-collapsed contract.
        if (!collapsedSplit) renderLeafInto(pane, leaf);
        mountPaneTabContent(pane, leaf, auxTabs);
      }
    });
    // Non-owner terminal leaves own aux surfaces; a tab not still on
    // screen (closed or promoted leaf, tab moved to the owner) parks its
    // surface in the D8 cache (releaseStale also runs the cap eviction).
    if (window.HerdrPaneTerminals) window.HerdrPaneTerminals.releaseStale(auxTabs);
    // A reshape can drop the leaf hosting the empty-leaf card (split
    // collapse, close-promote, maximize): rescue parks it home hidden, and
    // only this sync decides whether the zero-tab state still warrants it.
    // Without the call here a quiet zero-tab workspace has no event-driven
    // refresh coming, so the card stayed parked and gone until some other
    // action rendered. Same bare-function guard style as the callers in
    // this file: standalone VM harnesses load this module without render.js.
    if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
    // Mirror the tree's active pointer onto the pane elements (focus ring).
    if (window.HerdrPaneFocus && typeof window.HerdrPaneFocus.applyFocusClasses === "function")
      window.HerdrPaneFocus.applyFocusClasses();
    // The bar's pane controls act on the focused leaf, so every reshape
    // (split, close, maximize, focus follow) must repaint them. The bar
    // sync is signature-gated: a no-change reshape costs one string compare.
    if (window.HerdrLocationBar && typeof window.HerdrLocationBar.sync === "function")
      window.HerdrLocationBar.sync();
  } finally {
    panePassLookups = savedPassLookups;
  }
}

function paneLeafElement(container, root, leaf) {
  if (isPaneSplit(root)) {
    return findPaneElementById(container, leaf.paneId) || null;
  }
  const first = [...container.children].find((child) => hasClass(child, "workspace-pane"));
  return first || null;
}

// Which workspaces a leaf's terminal tabs belong to (D4): resolved from
// the tab rows (never the hosting leaf, D7.3). Used to decide whether the
// mixed-tree badge shows at all and what it labels.
function leafWorkspaceIds(leaf) {
  const ids = [];
  for (const tabId of paneTabsForTree(leaf) || []) {
    if (isEditorTab(tabId) || isGitTab(tabId)) continue;
    const row = paneTerminalTabById(tabId);
    const workspaceId = row && row.workspace_id;
    if (workspaceId && !ids.includes(workspaceId)) ids.push(workspaceId);
  }
  return ids;
}

// The tree hosts multiple workspaces when ANY leaf resolves a foreign
// workspace id (D4: the badge hides entirely on single-workspace trees,
// including empty ones).
function treeIsMixed() {
  // Pass memo: precomputed at install time against the settled root (the
  // paint never mutates the tree between settle and finish), so badge and
  // prefix reads skip the leaf walk per strip tab.
  if (panePassLookups) return panePassLookups.treeMixed;
  return treeIsMixedFor(paneRootFor());
}

function treeIsMixedFor(root) {
  const seen = new Set();
  for (const leaf of paneLeaves(root)) {
    for (const id of leafWorkspaceIds(leaf)) {
      seen.add(id);
      if (seen.size > 1) return true;
    }
  }
  return false;
}

// D4 badge: label plus a thin accent, never hue alone. The label carries
// worktree name + branch when the workspace is a worktree, else the
// workspace label. Clickable (D6): opens the workspace picker scoped to
// this pane. Empty leaves and single-workspace trees show no badge.
function paneWorkspaceBadgeHtml(leaf) {
  if (!treeIsMixed()) return "";
  const ids = leafWorkspaceIds(leaf);
  if (ids.length !== 1) return "";
  const workspace = (state.workspaces || []).find((w) => w.workspace_id === ids[0]);
  if (!workspace) return "";
  const label =
    (typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) ||
    workspace.label ||
    ids[0];
  const encodedPane = leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const title = `Workspace: ${label}`;
  return `<button class="pane-ws-badge" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" onclick="event.stopPropagation();HerdrPaneWorkspacePicker.openPicker(this,'${escapeAttr(encodedPane)}','switch')">${escapeHtml(label)}</button>`;
}

// Leaves hosting the selected workspace's terminal panels carry the
// pane-owns-current class: on mixed trees it paints a distinct border
// so the home pane reads at a glance (the D4 badge names it, the border
// locates it). Single-workspace trees skip the class: every pane would
// wear it, no information.
function markCurrentWorkspacePane(pane, leaf) {
  // Marked slot: the pane element carries the mark so the
  // slot's dashed affordance styles off a data attribute. Stamped
  // before the classList guard: stub DOMs without classList still get
  // the attribute (the real DOM has both).
  if (pane && leaf) {
    if (leaf.groupSlot === true && pane.getAttribute && pane.getAttribute("data-group-slot") !== "true") {
      pane.setAttribute("data-group-slot", "true");
    }
    if (leaf.groupSlot !== true && pane.hasAttribute && pane.hasAttribute("data-group-slot")) {
      pane.removeAttribute("data-group-slot");
    }
  }
  if (!pane || !pane.classList) return;
  const ids = leafWorkspaceIds(leaf);
  const owns = treeIsMixed() && ids.length === 1 && ids[0] === state.ws;
  if (owns && !pane.classList.contains("pane-owns-current")) pane.classList.add("pane-owns-current");
  if (!owns && pane.classList.contains("pane-owns-current")) pane.classList.remove("pane-owns-current");
}

// Panel chip (collector model): one chip per strip's leading edge, only
// when the tree holds more than one panel. Standalone panels name their
// workspace (worktree display name when it has one). Panels inside a
// GROUP share ONE group chip instead: the icon marks the group, the
// number is the visible member count, click focuses the group's
// last-focused leaf. A group is the split whose view area holds the
// panel: a top-level subtree (v3), or the flat root itself when every
// root child is a leaf (the first split builds exactly this shape, so
// the number appears the moment it happens). A split stays a group
// only while the fan-out is real: at most one member stacks labels
// (the collector the views split out of), so two label stacks render
// every panel ungrouped. Single-panel trees hide
// the chip: one panel names itself through the location bar and
// sidebar already.

// Group members actually in the view area. Maximize mode parks every
// sibling behind rail stubs, so the visible set collapses to the
// maximized member (v3.2): hidden panels stay outside the group.
function paneGroupVisibleMembers(group) {
  const members = group ? paneLeaves(group) : [];
  const entry = panesStateFor();
  if (!entry || !entry.maximizedPaneId) return members;
  return members.filter((leaf) => leaf.paneId === entry.maximizedPaneId);
}

// Group slots and docks (redo model): the fan-out half-drop mints the
// dragged view PLUS one marked empty leaf (groupSlot), the drop target
// other labels fill; the source leaf keeps a groupCollector mark so a
// 1-label dock never miscounts as a view (the "delta with 1 labels has
// 2" bug class). Both marks persist through saveWorkspacePanesStates
// (the replacer only strips autoCloseArmed).
function isGroupSlot(leaf) {
  return !!(leaf && leaf.groupSlot === true && !(leaf.tabs || []).length);
}

function isGroupView(leaf) {
  return !!(leaf && leafTerminalLabelCount(leaf) === 1 && !leaf.groupCollector && !isGroupSlot(leaf));
}

// The group's dock: the marked collector when it still lives in the
// split, else the single label stack there. null for dock-less groups
// (the bar drop mints one rather than fold into a foreign stack).
function resolveGroupDock(split) {
  if (!split) return null;
  const leaves = paneLeaves(split);
  const marked = leaves.find((leaf) => leaf.groupCollector === true) || null;
  if (marked) return marked;
  return leaves.find((leaf) => leafTerminalLabelCount(leaf) > 1) || null;
}

// Split-out views inside a split: leaves holding exactly ONE terminal
// label and no dock/slot mark. The collector itself (multiple labels
// or marked) is not a view; empty slots hold zero labels and never
// count.
function paneGroupVisibleViews(group) {
  return paneLeaves(group).filter(isGroupView);
}

// Marked empty slots waiting for a label drop.
function paneGroupSlots(group) {
  return paneLeaves(group).filter(isGroupSlot);
}

// A split is a group only while the fan-out is real: at least one real
// view, at least two fan-out members (views + marked slots), and at
// most ONE label stack (the collector the views came from). Two stacks
// are collectors side by side and never group.
function paneSplitIsGroup(split) {
  const views = paneGroupVisibleViews(split);
  if (!views.length) return false;
  if (views.length + paneGroupSlots(split).length < 2) return false;
  const stacks = paneLeaves(split).filter(
    (leaf) => leafTerminalLabelCount(leaf) > 1 || leaf.groupCollector === true
  );
  return stacks.length <= 1;
}

function paneGroupChipHtml(root, group) {
  const members = paneGroupVisibleMembers(group);
  const views = paneGroupVisibleViews(group);
  // The chip counts REAL views only: a slot never inflates the number
  // (a 1-view fan-out with its slot shows no chip, not "Group 2").
  if (views.length < 2) return "";
  const focusedMember = (group && group.kind !== "pane" && group.activePaneId
    && paneForPaneId(root, group.activePaneId)) || (members.find((leaf) => leaf === activeLeaf(root)) || members[0]);
  if (!focusedMember) return "";
  const splitId = splitNodeId(group);
  const name = group.groupName || `Group ${views.length} panels`;
  const title = `${name} (double-click to rename)`;
  const encodedFocus = focusedMember.paneId ? encodeURIComponent(focusedMember.paneId) : "";
  if (state.editingPaneGroup === splitId) {
    // inputAttrs is a bundle-scope helper (core.js destructures it from
    // HerdrAppHelpers); standalone-VM realms boot without it, same
    // guard pattern as mountEmptyPanelCard's titleWithWebuiShortcut.
    // The interpolation stays INLINE: the keyboard-guard scan keys on
    // ${inputAttrs(} inside the tag open itself.
    return `<input class="pane-group-rename-input" aria-label="Rename panel group" value="${escapeAttr(state.editingPaneGroupValue || "")}"${typeof inputAttrs === "function" ? inputAttrs("done") : ""} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitPaneGroupRename('${escapeAttr(encodedFocus)}')" oninput="state.editingPaneGroupValue=this.value" onkeydown="paneGroupRenameKey(event,'${escapeAttr(encodedFocus)}')">`;
  }
  return `<button class="pane-panel-chip pane-panel-group-chip" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" data-pane-id="${escapeAttr(focusedMember.paneId || "")}" onclick="event.preventDefault();focusPanelFor('${escapeAttr(encodedFocus)}')" ondblclick="startPaneGroupRename('${escapeAttr(encodedFocus)}')">${escapeHtml(name)}</button>`;
}

// Group rename mirrors the tab rename trio (worktrees.js) but stays
// client-only: the name rides the split node (split.groupName) and
// persists through saveWorkspacePanesStates. The focused member's
// paneId keys the session; commitPaneGroupRename resolves the split
// through it, so a reshape mid-edit ends the session naturally.
function startPaneGroupRename(encodedFocus) {
  const root = paneRootFor();
  const leaf = encodedFocus ? paneForPaneId(root, decodeURIComponent(encodedFocus)) : null;
  const group = leaf ? paneGroupForLeaf(root, leaf) : null;
  if (!group) return;
  const splitId = splitNodeId(group);
  state.editingPaneGroup = splitId;
  state.editingPaneGroupValue = group.groupName || "";
  renderWorkspacePanes();
  setTimeout(() => {
    if (state.editingPaneGroup !== splitId) return;
    const input = document.querySelector(".pane-group-rename-input");
    if (input && input.select) input.select();
  }, 0);
}

function paneGroupRenameKey(e, encodedFocus) {
  if (e.key === "Enter") {
    if (e.preventDefault) e.preventDefault();
    commitPaneGroupRename(encodedFocus);
  } else if (e.key === "Escape") {
    state.editingPaneGroup = null;
    state.editingPaneGroupValue = "";
    renderWorkspacePanes();
  }
}

function commitPaneGroupRename(encodedFocus) {
  const root = paneRootFor();
  const leaf = encodedFocus ? paneForPaneId(root, decodeURIComponent(encodedFocus)) : null;
  const group = leaf ? paneGroupForLeaf(root, leaf) : null;
  const splitId = state.editingPaneGroup;
  // Capture the draft BEFORE the editing state resets: the reads below
  // would see "" and every commit would land as an empty rename.
  const draft = String(state.editingPaneGroupValue || "").trim();
  state.editingPaneGroup = null;
  state.editingPaneGroupValue = "";
  if (!group) {
    renderWorkspacePanes();
    return;
  }
  if (splitId && splitNodeId(group) !== splitId) {
    renderWorkspacePanes();
    return;
  }
  // Empty reverts to the default "Group N panels" (a stale custom name
  // must not outlive the views it counted).
  if (draft) group.groupName = draft;
  else delete group.groupName;
  saveWorkspacePanesStates();
  renderWorkspacePanes();
}

// The STRUCTURAL split whose view area holds a leaf, with no group
// validity check: the flat root when every root child is a leaf (and
// the leaf is one of them), else the top-level split child containing
// the leaf, else null. The decay fold reasons about this split after a
// move emptied the fan-out (the group checks would reject it by
// then); paneGroupForLeaf layers the validity on top for renders.
function paneGroupSplitForLeaf(root, leaf) {
  if (!root || !leaf || !isPaneSplit(root)) return null;
  if (root.children.every((child) => child && child.kind === "pane")) {
    return root.children.includes(leaf) ? root : null;
  }
  return root.children.find((child) => isPaneSplit(child) && paneLeaves(child).includes(leaf)) || null;
}

// The split whose view area groups a leaf: the structural split from
// paneGroupSplitForLeaf, kept only while it is a real group
// (paneSplitIsGroup above). Mixed roots keep the doc model: direct
// leaves stay standalone, subtree members group as before. Derived,
// never stored: the tree already expresses membership and a stored
// flag would drift on every reshape.
function paneGroupForLeaf(root, leaf) {
  const split = paneGroupSplitForLeaf(root, leaf);
  return split && paneSplitIsGroup(split) ? split : null;
}

// Terminal labels stacked in one strip. Editor and git tabs ride on
// the view they opened from, the boot placeholder is not a label yet:
// neither counts toward the stack.
function leafTerminalLabelCount(leaf) {
  return (leaf.tabs || []).filter((id) => !isEditorTab(id) && !isGitTab(id) && id !== TERMINAL_TAB_PLACEHOLDER).length;
}

// The group shape a view leaves behind, stamped BEFORE the gesture
// empties or drops it: the collector's id plus the view's workspace,
// or null when the leaf is not a single-label view inside a valid
// group (collector sources and standalone panels never fold). The
// decay fold reads this after the mutation: the source is empty or
// gone by then, and re-resolving its split post-reshape could name a
// region the leaf already left. Ids, not leaf refs: the stamp rides
// the leaf through saveWorkspacePanesStates, and a persisted ref
// would come back a stale JSON twin.
function autoClosePreStateFor(root, leaf) {
  if (!leaf) return null;
  const split = paneGroupSplitForLeaf(root, leaf);
  if (!split || !paneSplitIsGroup(split) || !paneGroupVisibleViews(split).includes(leaf)) return null;
  // v2: the dock resolves through the marks first (a 1-label dock is
  // still a dock), falling back to the label stack. Dock-less groups
  // stamp null: their strip/close removals dissolve through the v3.2
  // armed collapse alone, only the bar drop mints a dock.
  const collector = resolveGroupDock(split);
  return collector ? { collectorId: collector.paneId || null, wsId: leafWorkspaceId(leaf) || null } : null;
}

function panePanelChipHtml(leaf) {
  const root = paneRootFor();
  if (!leaf || paneLeaves(root).length < 2) return "";
  // Group chips render on the group's FOCUSED member strip only; the
  // other members keep standalone chips (v4: the chip is identity and
  // focus, never a drag handle; labels drag, chips click). Below
  // 2+ visible members (maximize mode) the focused member falls back
  // to its standalone chip (v3.2).
  const group = paneGroupForLeaf(root, leaf);
  const active = activeLeaf(root);
  // The group chip needs 2+ REAL views (the fan-out's 1 view + slot
  // state falls through to the standalone chip: the number appears
  // only once the second view lands) and 2+ visible members (the
  // v3.2 maximize guard). paneGroupChipHtml returning "" would strip
  // the chip entirely, so the fallback must live HERE.
  if (group && leaf === active && paneGroupVisibleMembers(group).length >= 2
    && paneGroupVisibleViews(group).length >= 2) {
    return paneGroupChipHtml(root, group);
  }
  // Non-focused members and single-visible-member groups fall through
  // to the workspace-name chip: click focuses this panel.
  const wsId = leafWorkspaceId(leaf);
  const workspace = wsId ? (state.workspaces || []).find((w) => w.workspace_id === wsId) : null;
  const label = workspace
    ? ((typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) || workspace.label || wsId)
    : (wsId || "panel");
  const encodedPane = leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  return `<button class="pane-panel-chip" title="${escapeAttr(label)}" aria-label="Focus panel: ${escapeAttr(label)}" data-pane-id="${escapeAttr(leaf.paneId || "")}" onclick="event.preventDefault();focusPanelFor('${escapeAttr(encodedPane)}')">${escapeHtml(label)}</button>`;
}

// Route write from a panel (design: the location bar always mirrors the
// focused panel). Shared by the chip click and pane_focus's
// activatePane. Its active terminal tab navigates (ws+tab); an empty
// or editor/git panel writes its wsId with tab null. Standalone-VM
// stubs without go() stay no-ops.
function writeRouteFromLeaf(leaf) {
  if (!leaf) return false;
  const activeTab = (leaf.tabs || []).includes(leaf.active) ? leaf.active : null;
  if (activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab) && typeof go === "function") {
    if (state.tab !== activeTab) {
      go(workspaceIdForTab(activeTab), activeTab);
      return true;
    }
    return false;
  }
  const wsId = leafWorkspaceId(leaf);
  if (wsId && typeof go === "function" && state.ws !== wsId) {
    go(wsId, null);
    return true;
  }
  return false;
}

// Chip click: focus the panel and write the route from it.
function focusPanelFor(encodedPaneId) {
  const root = paneRootFor();
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const leaf = paneId ? paneForPaneId(root, paneId) : activeLeaf(root);
  if (!leaf) return false;
  focusLeaf(root, leaf);
  saveWorkspacePanesStates();
  const hadRoute = writeRouteFromLeaf(leaf);
  // go() owns the refresh; when no route write fired (same route, or a
  // stub harness without go()) the render pass still applies the focus.
  if (!hadRoute) renderWorkspacePanes();
  return true;
}

// A collapsed group rides its split node: dockId + wsId identify the
// dock leaf (ids, not leaf refs, so the stamp survives persistence and
// tree reshapes). The split keeps its children untouched through the
// collapse; the renderer paints the dock pane alone while the stamp
// lives, and expandCollapsedGroup clears it.
function isCollapsedGroup(split) {
  return !!(split && split.groupCollapsed && split.groupCollapsed.dockId);
}

// The dock leaf of a collapsed group: resolved through the stamp ids
// against the live tree, so a reshape that re-keyed the split still
// finds the dock by id.
function collapsedGroupDock(root, split) {
  const stamp = split && split.groupCollapsed;
  if (!stamp || !stamp.dockId) return null;
  return paneLeaves(root).find((leaf) => leaf.paneId === stamp.dockId) || null;
}

// Collapse: the pressed label's dock collects every group view's
// terminal labels (the v3.2 fold-home protocol: ids move, disarmed on
// arrival, active follows the pressed id), marked slots drop, and the
// split carries the collapsed stamp. The stamp also records WHERE each
// label came from (foldedHome: paneId -> [tabIds]) so the expand can
// route every label back to its view instead of stranding them in the
// dock's strip (strips only paint backend-known ids per leaf, so a
// label parked in the wrong leaf disappears). Only a press on a
// terminal label whose leaf sits inside a live group (a real split, a
// resolvable dock) collapses; every other press falls through to the
// plain navigation. Returns true when the collapse fired (the caller
// skips go()).
function collapseGroupForTabPress(tabId) {
  if (!tabId || isEditorTab(tabId) || isGitTab(tabId)) return false;
  const root = paneRootFor();
  const source = paneForTab(root, tabId);
  if (!source) return false;
  const split = paneGroupSplitForLeaf(root, source);
  if (!split || !paneSplitIsGroup(split) || isCollapsedGroup(split)) return false;
  const dock = source.groupCollector === true ? source : resolveGroupDock(split);
  if (!dock || !dock.tabs.includes(tabId)) return false;
  // Fold every view's terminal labels home; editor/git ids ride the
  // leaf (client-owned), and emptied views arm for the sweep so a
  // plain-collapse never leaves dead panes standing.
  const views = paneGroupVisibleViews(split);
  const foldedHome = {};
  for (const view of views) {
    const ids = (view.tabs || []).filter((id) => !isEditorTab(id) && !isGitTab(id) && id !== TERMINAL_TAB_PLACEHOLDER);
    const viewIds = foldedHome[view.paneId] = [];
    view.autoClosePre = autoClosePreStateFor(root, view);
    for (const id of ids) {
      const at = view.tabs.indexOf(id);
      if (at >= 0) view.tabs.splice(at, 1);
      if (!dock.tabs.includes(id)) dock.tabs.push(id);
      viewIds.push(id);
      disarmLeafAutoClose(dock);
    }
    if (!view.tabs.length) armLeafAutoClose(view);
  }
  // Marked slots leave with the views: the collapsed dock shows no
  // empty-space affordance.
  for (const slot of paneGroupSlots(split)) dropLeafFromTree(slot);
  dock.active = tabId;
  dock.groupCollector = true;
  split.groupCollapsed = { dockId: dock.paneId || null, wsId: leafWorkspaceId(dock) || null, foldedHome };
  focusLeaf(root, dock);
  saveWorkspacePanesStates();
  // Route write goes through writeRouteFromLeaf so the mounted view is
  // the pressed panel; the refresh renders the collapsed dock alone.
  if (!writeRouteFromLeaf(dock) || typeof go !== "function") renderWorkspacePanes();
  return true;
}

// Expand: the collapsed-group chip press restores the group. The views
// and slots sit in the tree untouched; clearing the stamp and painting
// rebuild the split. The dock keeps every label; pressing one again
// re-collapses.
function expandCollapsedGroup(encodedSplitId) {
  const root = paneRootFor();
  const splitId = decodeURIComponent(String(encodedSplitId || ""));
  const split = paneLeaves(root).length && root ? findSplitById(root, splitId) : null;
  if (!split || !isCollapsedGroup(split)) return false;
  // Route every folded label back to its view leaf: the stamp's
  // foldedHome map (paneId -> [tabIds]) carries the pre-collapse
  // homes. Without this pass the ids stay in the dock while the views
  // stand empty, and the group model paints nothing (a view is one
  // backend-known label per leaf). The collapse armed the emptied
  // views for the sweep; the expansion restores their role, so the
  // arms must go or the first render's sweep eats the whole group the
  // moment the stamp clears.
  const stamp = split.groupCollapsed;
  const homeEntries = Object.entries((stamp && stamp.foldedHome) || {});
  const root2 = paneRootFor();
  for (const [viewPaneId, ids] of homeEntries) {
    const view = paneLeaves(root2).find((leaf) => leaf.paneId === viewPaneId);
    if (!view) continue;
    for (const id of ids) {
      const owner = paneForTab(root2, id) || dockLeaf;
      const at = owner.tabs.indexOf(id);
      if (at >= 0) owner.tabs.splice(at, 1);
      if (!view.tabs.includes(id)) view.tabs.push(id);
    }
    if (view.tabs.length && !view.active) view.active = view.tabs[0];
    disarmLeafAutoClose(view);
  }
  for (const leaf of paneLeaves(split)) disarmLeafAutoClose(leaf);
  const dockLeaf = collapsedGroupDock(root2, split);
  if (dockLeaf && dockLeaf.active && !dockLeaf.tabs.includes(dockLeaf.active)) dockLeaf.active = dockLeaf.tabs[0] || null;
  delete split.groupCollapsed;
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
}

function findSplitById(node, splitId) {
  if (!node || !splitId) return null;
  if (isPaneSplit(node) && splitNodeId(node) === splitId) return node;
  if (!isPaneSplit(node)) return null;
  for (const child of node.children || []) {
    const found = findSplitById(child, splitId);
    if (found) return found;
  }
  return null;
}

// Spring-loaded dwell state (v4): the pane id a label drag hovered for
// the dwell window, so the drop switches its placement into that pane.
let paneDragDwellPaneId = null;
let paneDragDwellTimer = null;

// v4 dwell window in ms: how long a label drag must hover one pane
// before the placement switches into it. 2s, the Finder spring-open
// window the spec named.
const PANE_DRAG_DWELL_MS = 2000;

// Arm the dwell for the hovered pane. Hovering a different pane
// restarts the clock; re-entering the armed pane is a no-op.
function armPaneDragDwell(paneId) {
  if (paneDragDwellPaneId === paneId) return;
  clearPaneDragDwell();
  if (!paneId || typeof setTimeout !== "function") return;
  paneDragDwellPaneId = paneId;
  paneDragDwellTimer = setTimeout(() => {
    paneDragDwellTimer = null;
  }, PANE_DRAG_DWELL_MS);
}

function clearPaneDragDwell() {
  if (typeof clearTimeout === "function" && paneDragDwellTimer) clearTimeout(paneDragDwellTimer);
  paneDragDwellTimer = null;
  paneDragDwellPaneId = null;
}

// The dwell passed when the armed pane still matches the hover. The
// timer firing alone is not enough: the pointer may have left while a
// stale pane id sat armed.
function paneDragDwellLocked(paneId) {
  return !!(paneDragDwellTimer === null && paneDragDwellPaneId === paneId && paneId);
}

// Full-pane outline for the locked pane: the visual "the placement
// switched into this panel" signal. One node, cleaned on every state
// change so a re-render never resurrects it over the wrong pane.
function syncPaneDwellOutline(container, lockedPaneId) {
  const previous = document.getElementById("paneDwellOutline");
  if (!lockedPaneId) {
    if (previous) detachDomNode(previous);
    return;
  }
  const pane = lockedPaneId ? findPaneElementById(container, lockedPaneId) : null;
  if (!pane) return;
  let outline = previous;
  if (!outline) {
    outline = document.createElement("div");
    outline.id = "paneDwellOutline";
    outline.className = "pane-dwell-outline";
    outline.setAttribute("aria-hidden", "true");
  }
  if (outline.parentElement !== pane && pane.appendChild) pane.appendChild(outline);
}

function clearPaneDwellOutline() {
  const outline = document.getElementById("paneDwellOutline");
  if (outline) detachDomNode(outline);
}

// Corner-zone hit test for the chip/tab drag (v3.1): the trigger area is
// the four CORNER regions of the hovered pane, one third of each axis
// (both offsets within 1/3 of their sides). The middle cross is dead:
// nothing accepts there, no preview paints, no drop lands. Inside a
// corner, proximity to the two adjacent borders picks the split: nearer
// the top/bottom border stacks (kind column, up/down by corner), nearer
// the left/right border sides (kind row, left/right by corner).
// Falls back to the container rect when no pane sits under the pointer
// (gaps, stub documents): the collector corners then.
function panelDropTargetAt(container, event) {
  if (!container || !container.getBoundingClientRect) return null;
  const pane = paneElementUnderPointer(container, event);
  const rect = (pane && pane.getBoundingClientRect ? pane : container).getBoundingClientRect();
  const paneId = pane && pane.dataset ? pane.dataset.paneId : null;
  const x = (event.clientX || 0) - rect.left;
  const y = (event.clientY || 0) - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const fx = x / rect.width;
  const fy = y / rect.height;
  const nearX = fx < 1 / 3 || fx > 2 / 3;
  const nearY = fy < 1 / 3 || fy > 2 / 3;
  if (!nearX || !nearY) return null;
  const dx = Math.min(fx, 1 - fx);
  const dy = Math.min(fy, 1 - fy);
  if (dy <= dx) return { paneId, axis: "column", first: fy < 1 / 2 };
  return { paneId, axis: "row", first: fx < 1 / 2 };
}

// Deepest .workspace-pane under the drag pointer. paneFromPoint climbs
// from the event target instead of elementFromPoint: the drag ghost
// intercepts hit testing, but the event target chain stays real.
function paneElementUnderPointer(container, event) {
  let node = event && event.target;
  while (node && node !== container) {
    if (hasClass(node, "workspace-pane") && node.dataset && node.dataset.paneId) return node;
    node = node.parentElement;
  }
  return null;
}

// The preview square: one singleton overlay, repositioned per
// dragover. Never per-pane nodes: the render loop re-parents pane
// content on every pass and must not own drag chrome. Cleared on
// dragleave/drop/dragend; a missing rect (stub documents) hides it.
function positionPanelDropPreview(container, event, target) {
  let preview = document.getElementById("panelDropPreview");
  if (!preview) {
    preview = document.createElement("div");
    preview.id = "panelDropPreview";
    preview.className = "panel-drop-preview";
    preview.setAttribute("aria-hidden", "true");
  }
  if (preview.parentElement !== container && container.appendChild)
    container.appendChild(preview);
  const pane = target.paneId ? findPaneElementById(container, target.paneId) : null;
  const host = pane && pane.getBoundingClientRect ? pane : container;
  const rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
  if (!rect || !preview.style) {
    if (preview.hidden !== undefined) preview.hidden = true;
    return;
  }
  if (preview.hidden) preview.hidden = false;
  const half = target.axis === "row"
    ? { left: target.first ? rect.left : rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height }
    : { left: rect.left, top: target.first ? rect.top : rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 };
  const hostRect = container.getBoundingClientRect ? container.getBoundingClientRect() : { left: 0, top: 0 };
  preview.style.left = (half.left - hostRect.left) + "px";
  preview.style.top = (half.top - hostRect.top) + "px";
  preview.style.width = half.width + "px";
  preview.style.height = half.height + "px";
  preview.style.display = "block";
}

// Preview teardown on dragleave/drop/dragend: the overlay is chrome
// owned by the drag, never by a render pass.
function clearPanelDropPreview() {
  const preview = document.getElementById("panelDropPreview");
  if (preview && preview.style) preview.style.display = "none";
}

function renderLeafInto(pane, leaf) {
  const strip = pane.querySelector(".pane-tab-strip");
  if (!strip) return;
  wirePaneStripDrag(strip);
  markCurrentWorkspacePane(pane, leaf);
  const activeTab = paneActiveTab(leaf);
  // Chip on the leading edge, badge retired: the collector names each
  // panel through its chip when more than one panel exists, and the
  // D4 mixed-tree badge duplicated that job worse (per-tab rows, no
  // focus affordance).
  const stripHtml = panePanelChipHtml(leaf) + paneTabsForTree(leaf)
    .map((tabId) => {
      if (isEditorTab(tabId)) return paneEditorTabButtonHtml(tabId, tabId === activeTab);
      if (isGitTab(tabId)) return paneGitTabButtonHtml(tabId, tabId === activeTab);
      return paneTerminalTabButtonHtml(paneTerminalTabById(tabId), tabId === activeTab);
    })
    .join("");
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
function cleanupAbandonedLayout(container, root, extraKeepLeaves) {
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
  // A collapsed group's dock pane sits flat in the container while the
  // root stays a split; the dock-only paint is not a leftover.
  for (const leaf of extraKeepLeaves || []) keepPaneIds.add(leaf.paneId);
  const flatAllowed = new Set((extraKeepLeaves || []).map((leaf) => leaf.paneId));
  [...container.children].forEach((child) => {
    if (hasClass(child, "workspace-pane")) {
      // A split root keeps its leaves inside .pane-row/.pane-column
      // nodes: any pane sitting directly in the container is a leftover
      // from the flat single-leaf render and must go, even when its id
      // still names a live leaf (the split built its own element),
      // except the collapsed dock's own flat pane.
      if ((isPaneSplit(root) && !flatAllowed.has(child.dataset.paneId)) || !keepPaneIds.has(child.dataset.paneId)) drop(child);
    } else if (hasClass(child, "pane-row") || hasClass(child, "pane-column")) {
      if (isPaneSplit(root) && child.dataset.splitId === splitNodeId(root)) return;
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
        // Aux surfaces own a wterm instance and scrollback; park them
        // so the drop cannot orphan them. Parked means hidden like the
        // other rescued surfaces: the mount pass re-parents and un-hides,
        // and the registry keeps the entry cached for the tab's return
        // (real disposal is closeTab and cap eviction).
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
  // The dashboard and the empty-leaf card are id-resolved the same way
  // (syncProjectDashboard / syncWorkspaceEmptyLeaf read them by el()), so a
  // dropped pane hosting one must park it home too or it becomes
  // unreachable from every id lookup and the syncs silently no-op.
  const shell = el("terminalShell");
  if (shell && nodeWithin(element, shell)) container.appendChild(shell);
  const dashboard = el("projectDashboard");
  if (dashboard && nodeWithin(element, dashboard)) container.appendChild(dashboard);
  const emptyLeaf = el("workspaceEmptyLeaf");
  if (emptyLeaf && nodeWithin(element, emptyLeaf)) {
    // Parked means hidden for the card too: #workspacePanes paints its
    // direct children, so a shown card would float as a phantom pane for
    // the tick until syncWorkspaceEmptyLeaf re-hides and re-mounts it.
    // The sync owns this attribute every tick, so it lifts the hide on
    // its own next pass when the zero-tab state still warrants the card.
    emptyLeaf.hidden = true;
    container.appendChild(emptyLeaf);
  }
}

function paneTabButtonHtml(tab, isActive, index, tabs) {
  if (state.editingTab === tab.tab_id)
    return `<span class="pane-tab terminal ${isActive ? "active" : ""}" role="tab"><input class="tab-rename-input" aria-label="Rename panel" value="${escapeAttr(state.editingTabValue)}"${inputAttrs("done")} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${escapeAttr(tab.tab_id)}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${escapeAttr(tab.tab_id)}')"></span>`;
  // The strip prefix (D15) is the foreign panel's origin, and only a
  // default-numbered label gets one (a custom name is the identity).
  // Computed HERE, once, and panelVisibleLabel receives it so the two
  // never drift: the visible span text, the data-ws-prefix attribute,
  // and the accessible name all derive from this one result. It renders
  // as a muted ::before (data-ws-prefix) so the number stays the
  // readable head; the full string rides aria-label (beats title for
  // screen readers, and the visible text may truncate).
  const isDefault = isDefaultPanelTitle(String((tab && tab.label) || "").trim());
  const prefix = isDefault ? foreignWorkspacePrefix(tab && tab.tab_id) : "";
  const shown = prefix ? panelNumberLabel(tab, index, tabs) : panelVisibleLabel(tab, index, tabs);
  const label = prefix ? `${prefix}${shown}` : shown;
  const labelSpan = prefix
    ? `<span class="pane-tab-label" data-ws-prefix="${escapeAttr(prefix.trim())}">${escapeHtml(shown)}</span>`
    : `<span class="pane-tab-label">${escapeHtml(label)}</span>`;
  const ariaLabel = `Panel ${label}`;
  return `<button class="pane-tab terminal ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="terminal" data-tab-id="${escapeAttr(tab.tab_id)}" draggable="true" aria-label="${escapeAttr(ariaLabel)}" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" onclick="activatePaneTab('${escapeAttr(tab.tab_id)}')" onauxclick="paneTabAuxClick(event,'terminal','${escapeAttr(tab.tab_id)}')" ondblclick="event.preventDefault();startTabRename('${escapeAttr(tab.tab_id)}','${escapeAttr(panelRenameInitialLabel(tab))}')" title="${escapeAttr(tabHoverTitle(tab))}">${paneTabStatusHtml(tab)}${labelSpan}<span class="pane-tab-close" role="button" tabindex="0" title="Close panel" aria-label="Close panel" onclick="event.stopPropagation();closeTab('${escapeAttr(tab.tab_id)}')">✕</span></button>`;
}

function paneTerminalTabButtonHtml(tab, isActive) {
  if (!tab) return "";
  const tabs = state.tabs || [];
  return paneTabButtonHtml(tab, isActive, tabs.indexOf(tab), tabs);
}

// Middle-click close for pane tabs, all three kinds. It routes to the
// same close paths as the strip ✕ (confirmations included), so the
// middle button can never bypass a dirty-file or terminal confirm.
function paneTabAuxClick(event, kind, rawId) {
  if (!event || event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
  if (kind === "editor") { void closeEditorTab(rawId); return; }
  if (kind === "git") { closeGitTab(rawId); return; }
  if (kind === "terminal") { void closeTab(decodeURIComponentSafe(rawId)); return; }
}

// The location bar owns the pane controls now: one control group above
// the panes acting on the focused leaf. Strips carry only tabs and the
// workspace badge. Same builders, same handlers, one subject: the active
// leaf resolves here instead of coming from the pressed pane's strip.
// Split placement anchor: the leaf holding the ACTIVE TERMINAL (route
// tab) decides where a split lands, not the focused leaf. Focus follows
// clicks on empty space and chips, so the bar's Split could otherwise
// grow a panel the user is not looking at. Editor/git route tabs and
// no-route states keep the focused leaf: those tabs own their own
// surfaces, and minting beside the surface in view matches the drag
// contract.
function splitAnchorLeaf(root) {
  const routeTab = state.tab != null ? String(state.tab) : null;
  if (routeTab && !isEditorTab(routeTab) && !isGitTab(routeTab) && terminalTabKnown(routeTab)) {
    const owner = paneForTab(root, routeTab);
    if (owner) return owner;
  }
  return activeLeaf(root);
}

function paneBarControlsHtml() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return "";
  // The bar's Split pair anchors on the active terminal's leaf; the
  // rest of the bar (maximize, close, find, menu) keeps the focused
  // leaf: those act on the panel in view, the split anchors on the
  // terminal the route names.
  const leaf = activeLeaf(root);
  const anchor = splitAnchorLeaf(root);
  if (!leaf || !anchor) return "";
  // The dashboard owns the pane area in the empty state: pane controls
  // would target dead chrome, the bar renders none.
  if (dashboardOwnsPaneArea()) return "";
  return `<span class="pane-strip-controls pane-bar-controls">${paneNewTabControlHtml(leaf)}${paneSplitControlsHtml(anchor)}${panePaneControlsHtml(leaf)}${paneFindControlHtml(leaf)}${paneMarkdownControlHtml(leaf)}${paneMenuControlHtml()}</span>`;
}

// Signature for the bar's render loop: every input that changes the
// controls' markup or state, so the bar repaints only on real change.
// The split anchor rides along: a route move between panels must repaint
// the Split pair's target even when the focused leaf did not change.
function paneBarControlsSignature() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root) || dashboardOwnsPaneArea()) return "none";
  const leaf = activeLeaf(root);
  if (!leaf) return "none";
  const parent = parentSplitOf(root, leaf);
  const maximized = maximizedLeaf(root) === leaf;
  const activeTab = leaf.active || (leaf.tabs || [])[0] || null;
  const tabKind = isEditorTab(activeTab) ? "editor" : isGitTab(activeTab) ? "git" : activeTab ? "term" : "none";
  const anchor = splitAnchorLeaf(root);
  return [
    leaf.paneId,
    anchor ? anchor.paneId : "",
    parent ? parent.kind : "",
    paneLeaves(root).length,
    maximized ? "max" : "",
    tabKind,
    paneMarkdownControlHtml(leaf) ? "md" : "",
  ].join(":");
}

// The editor tab's find/replace control lives next to the other pane
// controls in the location bar (it used to float inside the editor
// body). Only an editor-active leaf shows it: terminal and git tabs
// have no find surface.
function paneFindControlHtml(leaf) {
  const activeTab = leaf && leaf.active;
  if (!activeTab || !isEditorTab(activeTab)) return "";
  const encoded = leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  return `<button class="pane-strip-button pane-find-button" title="Find / replace" aria-label="Find / replace" onclick="event.preventDefault();openPaneEditorFind('${escapeAttr(encoded)}')">⌕</button>`;
}

// Markdown editor tabs get one eye control beside the find button: it
// cycles rendered preview, raw source, and edit. Non-markdown files and
// read-only mounts (partial previews) keep the strip without it.
function paneMarkdownControlHtml(leaf) {
  const activeTab = leaf && leaf.active;
  if (!activeTab || !isEditorTab(activeTab)) return "";
  const path = editorTabPath(activeTab);
  const registry = window.HerdrFileBrowser;
  const file = registry && registry.editorFor ? registry.editorFor(path) : null;
  // Binary and truncated mounts (placeholder or partial preview) are
  // view-only: no eye control for them.
  if (!file || file.binary || file.truncated) return "";
  const markdown = !!(window.HerdrEditor && window.HerdrEditor.isMarkdownPath && window.HerdrEditor.isMarkdownPath(path));
  if (!markdown) return "";
  const encoded = encodeURIComponent(path);
  if (file.editing) {
    // Edit mode: the eye returns to the rendered preview. Dirty drafts
    // stay in the draft buffer; going back is the same unsaved state the
    // tab close would confirm about.
    return `<button class="pane-strip-button pane-md-button" title="Show rendered preview" aria-label="Show rendered preview" onclick="event.preventDefault();paneMarkdownPreview('${escapeAttr(encoded)}')">◔</button>`;
  }
  const viewingSource = !!file.previewSource;
  return viewingSource
    ? `<button class="pane-strip-button pane-md-button" title="Edit markdown source" aria-label="Edit markdown source" onclick="event.preventDefault();paneMarkdownEdit('${escapeAttr(encoded)}')">✎</button>`
    : `<button class="pane-strip-button pane-md-button" title="Show markdown source" aria-label="Show markdown source" onclick="event.preventDefault();paneMarkdownSource('${escapeAttr(encoded)}')">◑</button>`;
}

// Preview: leave edit/source and mount the rendered view. Dirty drafts
// are preserved in the entry so a later Edit returns to them.
function paneMarkdownPreview(encodedPath) {
  const registry = window.HerdrFileBrowser;
  if (registry && registry.setMarkdownPreview) registry.setMarkdownPreview(decodeURIComponentSafe(encodedPath));
}

// Source view: the raw text, still read-only.
function paneMarkdownSource(encodedPath) {
  const registry = window.HerdrFileBrowser;
  if (registry && registry.setMarkdownSource) registry.setMarkdownSource(decodeURIComponentSafe(encodedPath));
}

// Edit the raw markdown text.
function paneMarkdownEdit(encodedPath) {
  const registry = window.HerdrFileBrowser;
  if (registry && registry.setMarkdownEdit) registry.setMarkdownEdit(decodeURIComponentSafe(encodedPath));
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
  // Collector model (locked decision): the + mints an EMPTY panel for
  // the focused panel's workspace (auto-split beside it, focused, path
  // + Enter hint inside). It does NOT create a backend terminal; Enter
  // inside the fresh panel does. With no workspace open it falls
  // through to the workspace/worktree flow (the same family as the
  // dashboard's primary action), so the button is never dead.
  // With more than one workspace open the + opens the workspace picker
  // (D3): the new panel can bind to ANY workspace. One workspace keeps
  // the direct mint (no picker for a one-row list).
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const multi = (state.workspaces || []).length > 1;
  if (multi) {
    return `<button class="pane-strip-button pane-new-picker" title="New panel in a workspace" aria-label="New panel in a workspace" aria-haspopup="dialog" onclick="event.preventDefault();HerdrPaneWorkspacePicker.openPicker(this,'${escapeAttr(encoded)}','new-tab')">+</button>`;
  }
  return `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("New panel", "newPanel"))}" aria-label="New panel" onclick="event.preventDefault();newPanelForFocused()">+</button>`;
}

// The split pair is always fully offered (tmux model): any pane can grow
// in BOTH directions at any depth. Same-kind parent extends, different
// kind nests; both mechanics add a pane, so no button ever hides.
function paneSplitControlsHtml(leaf) {
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const rightButton = `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("Split right", "splitRight"))}" aria-label="Split right" onclick="event.preventDefault();splitPaneRightFor('${escapeAttr(encoded)}')">◫</button>`;
  const downButton = `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("Split down", "splitDown"))}" aria-label="Split down" onclick="event.preventDefault();splitPaneDownFor('${escapeAttr(encoded)}')">⊟</button>`;
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

// Menu-list key handling: ArrowUp/Down/Home/End move focus between
// items, Escape closes. Escape focus restore lives in closePaneMenu, not
// here: the document-level capture Escape cascade (bindings.js) closes the
// menu before this bubble-phase listener can run, and its stopPropagation
// prevents this handler entirely. Enter is left to the native button
// behavior.
function paneMenuKeydown(event) {
  const menu = document.getElementById("paneMenu");
  if (!menu) return;
  const items = [...menu.querySelectorAll(".pane-menu-item")];
  if (!items.length) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePaneMenu();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  let next = 0;
  if (event.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
  else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else next = items.length - 1;
  if (items[next] && typeof items[next].focus === "function") items[next].focus();
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
  menu.addEventListener("keydown", paneMenuKeydown);
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
  // A strip near the viewport bottom would push the menu off-screen.
  // Measure after the first paint position lands, then flip it up when
  // the drop exceeds the viewport, keeping an 8px margin.
  if (typeof document.documentElement === "undefined" || !document.documentElement) return;
  const viewportBottom = (typeof window !== "undefined" && typeof window.innerHeight === "number")
    ? window.innerHeight
    : document.documentElement.clientHeight;
  const height = menu.offsetHeight || 0;
  if (height && rect.bottom + 4 + height > viewportBottom - 8) {
    const flippedTop = rect.top - height - 4;
    menu.style.top = `${Math.max(8, flippedTop)}px`;
  }
}

function closePaneMenu() {
  const menu = document.getElementById("paneMenu");
  // pane strips re-render on layout changes; the captured button ref can be
  // detached by then, so resolve the live node by paneId. aria-expanded and
  // focus go to that node, never to the stale one.
  const paneId = paneMenu && paneMenu.paneId;
  const captured = paneMenu && paneMenu.button;
  let button = (paneId && paneButtonByPaneId(paneId)) || captured;
  if (menu) detachDomNode(menu);
  if (button && button.setAttribute) button.setAttribute("aria-expanded", "false");
  paneMenu = null;
  // Focus restore belongs here, not in paneMenuKeydown: every close path
  // (Escape cascade, outside click, re-toggle) must return focus to the
  // [⋮] button. Removing the menu drops focus on the closed item first,
  // so the live button is resolved before paneMenu is cleared above.
  // A pane closed while its menu was open leaves both the re-query and
  // the captured ref detached. Focusing a dead node is a silent no-op that
  // strands the user on body, so hand focus to the surviving pane's
  // button instead.
  if (button && button.isConnected === false) button = paneButtonByPaneId("*") || null;
  if (button && typeof button.focus === "function") button.focus();
}

// The pane menu button lives in the location bar, which repaints on
// focus moves; this resolves the live [⋮] for a pane so menu close
// restores focus to a real node even after the bar re-rendered. Returns
// null where the host document cannot query (unit-test fake DOMs), so
// closePaneMenu falls back to the captured button ref.
function paneButtonByPaneId(paneId) {
  if (typeof document.querySelector !== "function" || typeof CSS === "undefined" || !CSS.escape) return null;
  // The bar renders one controls group for the focused pane, so the
  // pane selector must agree with it: when the requested pane is the
  // active one its button is live, otherwise the bar is showing
  // another pane's controls and no node can serve the request.
  const root = paneRootFor();
  const leaf = paneId === "*" ? activeLeaf(root) : paneForPaneId(root, paneId);
  const active = activeLeaf(root);
  if (!leaf || !active || leaf.paneId !== active.paneId) return null;
  const bar = document.querySelector(".location-bar .pane-bar-controls");
  const button = bar && bar.querySelector(".pane-menu-button");
  return button || null;
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
  // Terminal tabs drag under the D7 invariants: the move is atomic on
  // drop (one splice out, one splice in, one sync pass), the surface
  // keeps its identity (the singleton follows the route tab, an aux
  // re-parents by tab key), and the workspace stays on the tab row
  // (never re-assigned by the hosting leaf). Refusing the drag was the
  // pre-mixed-tree behavior.
  paneDragTabId = tabId;
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-tab", tabId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  if (event.target.classList && event.target.classList.add) event.target.classList.add("pane-tab-dragging");
}

function paneTabDragEnd() {
  paneDragTabId = null;
  // The tab drag owns the container-level preview square (v3) and the
  // spring-loaded dwell chrome (v4): abandoning a tab drag mid-flight
  // must clear both, or the dotted square sticks on the last hovered
  // half and the dwell outline keeps painting over a pane nobody
  // hovers anymore. The location bar's remove indicator clears here
  // too: the drag may end on the bar's drop, in which case the bar's
  // own drop handler already ran; anywhere else the class would stick.
  clearPanelDropPreview();
  clearPaneDragDwell();
  clearPaneDwellOutline();
  clearPaneDropCaret();
  clearPaneWorkspaceDropHint();
  clearLocationBarPaneRemove();
  document.querySelectorAll(".pane-tab-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-tab-dragging");
  });
}

// The location bar's unsplit affordance: a herdr-pane-tab drag hovering
// the bar with a single-label view inside a valid group qualifies (the
// remove indicator paints); the drop converts that view back to a
// collector label. Dock-less groups mint a marked dock at the head of
// the group area first, so the label always has a strip to land in
// (the 2-view special case dissolves into the minted dock through the
// unified collapse on the very same render).
function clearLocationBarPaneRemove() {
  const bar = el("locationBar");
  if (bar && bar.classList && bar.classList.remove) bar.classList.remove("location-bar-pane-remove");
}

function paneTabUnsplitTarget(tabId) {
  if (!tabId) return null;
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const leaf = paneForTab(root, tabId);
  if (!leaf || !isGroupView(leaf)) return null;
  const group = paneGroupForLeaf(root, leaf);
  if (!group) return null;
  return { leaf, group };
}

function paneTabUnsplitHover(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  if (!drag || drag.kind !== "tab") return false;
  if (!paneTabUnsplitTarget(drag.tabId)) return false;
  return true;
}

function paneTabUnsplitDrop(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  if (!drag || drag.kind !== "tab") return false;
  const target = paneTabUnsplitTarget(drag.tabId);
  if (!target) return false;
  const { leaf, group } = target;
  const tabId = drag.tabId;
  // Resolve or mint the landing dock BEFORE the move empties the view:
  // the stamp needs a live dock id, and a minted dock must land inside
  // the group area so the collapse finds it structurally. The mint
  // anchors on the view leaf (same splice the bar's split pair uses):
  // the dock becomes the view's first neighbor INSIDE the group
  // split, never a sibling of the group area itself.
  let dock = resolveGroupDock(group);
  if (!dock) {
    dock = newEmptyLeaf();
    dock.wsId = leafWorkspaceId(leaf) || undefined;
    dock.groupCollector = true;
    if (!splitLeafWith(leaf, dock, { axis: group.kind === "column" ? "column" : "row", first: true })) return false;
  }
  paneTabDragEnd();
  leaf.autoClosePre = { collectorId: dock.paneId || null, wsId: leafWorkspaceId(leaf) || null };
  if (movePaneTabTo(tabId, dock.paneId, null, { skipRender: true })) {
    armLeafAutoClose(leaf);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
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

// Hover preview for a workspace card held over a pane strip (D3 speed
// path): "Open terminal: <label> here". A real node (not a bare outline)
// so the drop target reads as concrete; one node at a time.
function paneWorkspaceDropHint(strip, workspaceId) {
  clearPaneWorkspaceDropHint();
  const workspace = (state.workspaces || []).find((w) => w.workspace_id === workspaceId);
  if (!workspace) return;
  const label =
    (typeof workspaceDisplayTitle === "function" && workspaceDisplayTitle(workspace)) ||
    workspace.label ||
    workspaceId;
  const hint = document.createElement("div");
  hint.className = "pane-ws-drop-hint";
  hint.textContent = `Open terminal: ${label} here`;
  strip.appendChild(hint);
}

function clearPaneWorkspaceDropHint() {
  document.querySelectorAll(".pane-ws-drop-hint").forEach(detachDomNode);
}

// Which drag payload is in flight: a pane tab (text/herdr-pane-tab) or a
// sidebar workspace card (state.dragWorkspace, set by workspaceDragStart).
// Tab drags win when both signals somehow exist.
function activeDragKind() {
  if (paneDragTabId) return { kind: "tab", tabId: paneDragTabId };
  if (state.dragWorkspace) return { kind: "workspace", workspaceId: state.dragWorkspace };
  return null;
}

// Container-level TAB drag (v3): dropping a tab on a pane HALF creates
// a new panel there holding the tab. The strip's own dragover keeps the
// caret reorder flow; this handler owns pane-content hovers while a tab
// drag is in flight. v4 spring-load: every dragover arms the dwell clock
// on the hovered pane; once it passes, the outline paints over the pane
// and the drop switches its placement INTO it.
function paneContainerTabDragOver(event) {
  const drag = activeDragKind();
  if (!drag || drag.kind !== "tab") return;
  // The strip owns its own hover: skip when the pointer rides a strip
  // so the caret keeps precedence and the square never overlaps it.
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (onStrip) return;
  const container = el("workspacePanes");
  const target = panelDropTargetAt(container, event);
  // Dead zones (v3.1 cross) must not keep the square painted from an
  // earlier corner pass on the same drag path: a null target clears it.
  // The dwell keeps its clock for the pane under the pointer: crossing
  // the dead cross mid-pane does not leave the pane.
  if (!target) {
    clearPanelDropPreview();
    const hoveredPane = paneElementUnderPointer(container, event);
    const hoveredId = hoveredPane && hoveredPane.dataset ? hoveredPane.dataset.paneId : null;
    armPaneDragDwell(hoveredId);
    syncPaneDwellOutline(container, paneDragDwellLocked(hoveredId) ? hoveredId : null);
    return;
  }
  const targetLeaf = target.paneId ? paneForPaneId(paneRootFor(), target.paneId) : null;
  // The preview square paints whenever the drop would act: a fresh tree
  // splits its only pane (v3), and an own-pane half split is a real move.
  // The strip keeps its caret hover; this guard only refuses drops that
  // cannot change the tree.
  if (!targetLeaf) {
    clearPanelDropPreview();
    armPaneDragDwell(null);
    syncPaneDwellOutline(container, null);
    return;
  }
  if (event.preventDefault) event.preventDefault();
  if (event.dataTransfer && "dropEffect" in event.dataTransfer)
    event.dataTransfer.dropEffect = "move";
  armPaneDragDwell(target.paneId);
  const locked = paneDragDwellLocked(target.paneId);
  syncPaneDwellOutline(container, locked ? target.paneId : null);
  if (locked) {
    // Locked: the half preview yields to the full-pane outline so the
    // two indicators never stack.
    clearPanelDropPreview();
    return;
  }
  positionPanelDropPreview(container, event, target);
}

// Tab drop on a pane half: split the target at the hovered half, park a
// fresh empty leaf there, then move the dragged tab into it (the same
// movePaneTabTo mechanics, no surface re-create). v4 spring-load: when
// the dwell locked the pane under the pointer, the split happens INSIDE
// that pane no matter what the tree would extend into (forced nest),
// which is the Finder-style drill the user asked for. Own-pane drops
// fall through to the strip reorder path (the tab never left the pane,
// the caret owns that drop).
function paneContainerTabDrop(event) {
  const drag = activeDragKind()
    || (event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  if (!drag || drag.kind !== "tab") return;
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (onStrip) return;
  const container = el("workspacePanes");
  const target = panelDropTargetAt(container, event);
  const tabId = drag.tabId;
  // The dwell verdict reads BEFORE the state clears: the lock follows
  // the pane under the pointer at drop time.
  const lockedPaneId = paneDragDwellLocked(target ? target.paneId : null) ? target.paneId : null;
  paneTabDragEnd();
  clearPanelDropPreview();
  if (!target || !target.paneId) return;
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return;
  const source = paneForTab(root, tabId);
  const targetLeaf = paneForPaneId(root, target.paneId);
  if (!source || !targetLeaf) return;
  if (event.preventDefault) event.preventDefault();
  // The empty slot POPULATES instead of splitting: dropping a label on
  // the group's marked empty space fills it (the spec's "drag any other
  // panel label indicator to the empty space"), whatever the dwell
  // lock says. The stamp/arm protocol below is the standard cross-pane
  // move, minus the split.
  if (isGroupSlot(targetLeaf)) {
    source.autoClosePre = autoClosePreStateFor(paneRootFor(), source);
    if (movePaneTabTo(tabId, targetLeaf.paneId, null, { skipRender: true })) {
      disarmLeafAutoClose(targetLeaf);
      focusLeaf(paneRootFor(), targetLeaf);
      armLeafAutoClose(source);
    }
    saveWorkspacePanesStates();
    renderWorkspacePanes();
    return;
  }
  // A tab dropped on a half of its OWN pane splits that pane and moves
  // into the new half: single-panel trees are the most common first
  // gesture, so they split too instead of refusing. Cross-pane and
  // same-pane share one path; only the source lookup differs.
  const fresh = newEmptyLeaf();
  fresh.wsId = leafWorkspaceId(targetLeaf) || leafWorkspaceId(source);
  const landed = splitLeafWith(targetLeaf, fresh, target, { forceNest: !!lockedPaneId });
  if (!landed) return;
  // Redo fan-out mint: when the target area holds NO valid group yet,
  // the drop that creates the group mints the dragged view PLUS one
  // marked empty slot beside it ("the new dragged one forms a view
  // group with one empty space"), and the SOURCE leaf takes the
  // groupCollector mark so a 1-label dock never miscounts as a view.
  // Inside an existing group the drop is plain growth ("the 3 and so
  // forth"): no slot, no mark. The slot lands through the same
  // splitLeafWith extend mechanics on the fresh view (same axis, after
  // it), so every drop geometry keeps the group area flat and the
  // dock inside it.
  if (paneGroupForLeaf(paneRootFor(), targetLeaf) === null) {
    const slot = newGroupSlotLeaf(leafWorkspaceId(targetLeaf) || leafWorkspaceId(source));
    splitLeafWith(fresh, slot, { axis: target.axis, first: false });
    source.groupCollector = true;
  }
  // The fresh leaf owns the moved tab: same placement contract as a
  // + mint, so the sync never re-homes the id on the next snapshot.
  // v3.2 marker ownership: the drop gesture decides. An own-pane half
  // drop is a SPLIT gesture (both halves are the product, like a Split
  // press), so the emptied remainder stays disarmed and standing; a
  // cross-pane move arms its emptied source and the sweep below folds
  // it. The move itself is pure tree surgery (movePaneTabTo touches no
  // marker), and skipRender hands this handler the single paint.
  const splitGesture = source === targetLeaf;
  // Decay fold stamp, cross-pane moves only: an own-pane drop disarms
  // below and never folds.
  if (!splitGesture) source.autoClosePre = autoClosePreStateFor(paneRootFor(), source);
  if (movePaneTabTo(tabId, fresh.paneId, null, { skipRender: true })) {
    focusLeaf(paneRootFor(), fresh);
    if (splitGesture) disarmLeafAutoClose(source);
    else armLeafAutoClose(source);
  }
  // The emptied source (armed cross-pane) folds through the render
  // below; the focused fresh leaf survives by the sweep's own guard.
  saveWorkspacePanesStates();
  renderWorkspacePanes();
}

// Split the TARGET leaf at the drop half with a GIVEN fresh leaf (the
// tab drop owns its leaf so it can move the tab in after). Same
// extend/nest mechanics as splitActivePane, anchored on the target.
// opts.forceNest (v4 dwell): skip the extend path, the target itself
// splits even when its parent runs the drop axis.
function splitLeafWith(targetLeaf, fresh, target, opts) {
  const entry = panesStateFor();
  const root = entry.root;
  if (!paneTreeRenderable(root) || !targetLeaf) return false;
  const axis = target.axis === "row" ? "row" : "column";
  const slot = findLeafSlot(root, targetLeaf);
  if (!slot) return false;
  if (slot.holder === "root") {
    entry.root = { kind: axis, sizes: [1, 1], children: target.first ? [fresh, entry.root] : [entry.root, fresh] };
    return true;
  }
  if (!opts || !opts.forceNest) {
    if (slot.parent.kind === axis) {
      if (!Array.isArray(slot.parent.sizes)) slot.parent.sizes = slot.holder.map(() => 1);
      const share = Math.max(1, slot.parent.sizes[slot.index] || 1) / 2;
      slot.holder.splice(target.first ? slot.index : slot.index + 1, 0, fresh);
      slot.parent.sizes.splice(target.first ? slot.index : slot.index + 1, 0, share);
      slot.parent.sizes[slot.index + (target.first ? 1 : 0)] = share;
      return true;
    }
  }
  slot.holder[slot.index] = { kind: axis, sizes: [1, 1], children: target.first ? [fresh, targetLeaf] : [targetLeaf, fresh] };
  return true;
}

function paneStripDragOver(event) {
  const drag = activeDragKind();
  if (!drag) return;
  // The strip under the pointer owns the caret or the workspace hint;
  // hovering pane content targets the same strip's append slot.
  const target = event.target;
  const strip = (target && target.closest ? target.closest(".pane-tab-strip") : null)
    || (target && target.classList && target.classList.contains && target.classList.contains("pane-tab-strip") ? target : null);
  if (!strip) return;
  if (event.preventDefault) event.preventDefault();
  if (event.dataTransfer && "dropEffect" in event.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (drag.kind === "workspace") {
    paneWorkspaceDropHint(strip, drag.workspaceId);
    return;
  }
  const index = paneDropIndexAt(strip, event, drag.tabId);
  paneDropCaretAt(strip, index);
  strip.dataset.dropIndex = String(index);
}

function paneStripDrop(event) {
  const drag = activeDragKind()
    || (event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  const pane = event.target && event.target.closest ? event.target.closest(".workspace-pane") : null;
  if (drag && drag.kind === "workspace") {
    clearPaneWorkspaceDropHint();
    if (event.preventDefault) event.preventDefault();
    const paneId = pane && pane.dataset ? pane.dataset.paneId : null;
    // D3 speed path: the card drop creates a terminal in the dragged
    // workspace inside this pane. No blind drops: the hover hint named
    // the workspace and pane all the way in.
    if (window.HerdrWorkspacePanes && typeof window.HerdrWorkspacePanes.openPanelInWorkspace === "function")
      void window.HerdrWorkspacePanes.openPanelInWorkspace(drag.workspaceId, paneId);
    // Same cleanup the sidebar's own dragend runs, so a drop on a strip
    // never leaves the card dimmed (.workspace-drag) or the drag state
    // armed for the next dragover.
    state.dragWorkspace = null;
    document.querySelectorAll(".workspace-drag").forEach((node) => {
      if (node.classList && node.classList.remove) node.classList.remove("workspace-drag");
    });
    return;
  }
  const tabId = drag && drag.kind === "tab" ? drag.tabId : null;
  const strip = pane && pane.querySelector ? pane.querySelector(".pane-tab-strip") : null;
  paneTabDragEnd();
  clearPaneWorkspaceDropHint();
  if (!tabId || !pane) return;
  if (event.preventDefault) event.preventDefault();
  const paneId = pane.dataset ? pane.dataset.paneId : null;
  const index = strip && strip.dataset ? Number(strip.dataset.dropIndex) : NaN;
  // v3.2 marker ownership: the emptying gesture decides, the move is
  // pure tree surgery. A same-pane drop is a reorder (renders itself);
  // a cross-pane strip drop arms its emptied source BEFORE the single
  // render so the sweep folds it in this same paint, not the next one.
  const rootBeforeMove = paneRootFor();
  const source = tabId ? paneForTab(rootBeforeMove, tabId) : null;
  const dropIndex = Number.isFinite(index) ? index : null;
  if (!source || source.paneId === paneId) {
    movePaneTabTo(tabId, paneId, dropIndex);
    return;
  }
  // Decay fold stamp: the group shape before the move empties the
  // view; the sweep's fold reads it in the render below.
  source.autoClosePre = autoClosePreStateFor(rootBeforeMove, source);
  if (movePaneTabTo(tabId, paneId, dropIndex, { skipRender: true })) {
    armLeafAutoClose(source);
    renderWorkspacePanes();
  }
}

// The actual move: splice from the source leaf, insert into the target
// leaf at the caret index, activate, persist, re-render. Same-leaf moves
// are reorders and stay client-side; a cross-leaf move re-mounts the
// owning module's container into the new content slot. Terminal tabs
// follow the D7 invariants: atomic splice on drop, the surface keeps
// its identity (the singleton follows the route tab, an aux re-parents
// by its per-tab key on the next render), and the route moves with the
// tab when the dragged id was the route tab (workspaceIdForTab keeps
// the route's workspace row-true, D7.3).
// v3.2 contract: the move never decides the SOURCE's fate; whether an
// emptied source auto-closes belongs to the GESTURE that moved the tab
// (the emptying site owns the marker), so composite callers keep full
// control. The TARGET always disarms: receiving a tab is a refill, and
// a refill cancels any stale gesture marker on the target. opts.skipRender
// lets a caller that renders immediately after (the half-drop path)
// avoid the double paint; the marker writes still persist before it.
function movePaneTabTo(tabId, targetPaneId, index, opts) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const isTerm = !isEditorTab(tabId) && !isGitTab(tabId) && tabId !== TERMINAL_TAB_PLACEHOLDER;
  if (!isTerm && !isEditorTab(tabId) && !isGitTab(tabId)) return false;
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
  // Slot arrival clears the mark: a populated slot is a plain view now
  // (isGroupSlot also keys on emptiness, but a stale flag must never
  // survive in the persisted blob either).
  delete target.groupSlot;
  source.active = source.tabs[0] || null;
  // Refill protocol: the pane receiving the tab sheds any stale arm.
  disarmLeafAutoClose(target);
  // Keep the active pointer on the pane receiving the tab: the next
  // sidebar open lands there, matching a click on the moved tab.
  focusLeaf(root, target);
  saveWorkspacePanesStates();
  if (!(opts && opts.skipRender)) renderWorkspacePanes();
  if (isEditorTab(tabId)) void activateEditorTab(editorTabPath(tabId));
  else if (isGitTab(tabId)) void openGitTab(gitTabViewKey(tabId));
  else if (isTerm) {
    // D7.2: dragging the route tab moves the singleton surface with
    // it. The route is the ownership signal for #terminalShell
    // (terminalShellOwnerLeaf resolves through paneForTab(root, route));
    // re-routing here re-claims the shell for the target leaf, and the
    // render pass disposes the dragged tab's aux from its old
    // non-owner stint (mountPaneTabContent releases the aux of a tab
    // the primary shell now hosts). No re-create anywhere: identity
    // survives (aux keyed per tab, shell per app).
    if (String(state.tab) === tabId && typeof go === "function")
      go(workspaceIdForTab(tabId), tabId);
    // A non-route terminal drop just re-renders: the tab keeps its
    // aux identity, and the target leaf's mount pass re-parents the
    // existing per-tab container into its slot (D7.4).
  }
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
    if (event.target === strip) {
      clearPaneDropCaret();
      clearPaneWorkspaceDropHint();
    }
  });
  strip.addEventListener("dragend", () => paneTabDragEnd());
}

// ---- split commands (Phase 4) ------------------------------------------
// Wraps the active leaf in a binary split node holding it and a fresh
// empty leaf. The new leaf starts empty: the strip's + stays
// terminal-only, and the terminal singleton means the route terminal
// never leaves its leaf. Focus moves to the new leaf so the next sidebar
// open (file click, git status row) lands there.

// tmux model: every split adds a pane. Same-kind parent splices the
// fresh sibling into the leaf's own axis (extend), different-kind parent
// wraps the leaf in a nested split (nest). Orientation never rewrites
// an existing split node: dividers and reconciled subtree identities
// stay stable across reshapes.
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
  const slot = findLeafSlot(root, leaf);
  if (!slot) return false;
  if (slot.holder === "root") {
    const stateEntry = panesStateFor();
    stateEntry.root = { kind, sizes: [1, 1], children: [leaf, fresh] };
  } else if (slot.parent.kind === kind) {
    // Extend: the sibling joins the leaf's own axis, halving the
    // pressed pane's share so the split keeps its total size.
    if (!Array.isArray(slot.parent.sizes)) slot.parent.sizes = slot.holder.map(() => 1);
    const share = Math.max(1, slot.parent.sizes[slot.index] || 1) / 2;
    slot.holder.splice(slot.index + 1, 0, fresh);
    slot.parent.sizes.splice(slot.index + 1, 0, share);
    slot.parent.sizes[slot.index] = share;
  } else {
    // Nest: the leaf keeps its slot, an inner split of the new kind
    // pairs it with the fresh sibling.
    slot.holder[slot.index] = { kind, sizes: [1, 1], children: [leaf, fresh] };
  }
  // The swap above may have replaced the root object; re-read it before
  // focusing so activePaneId lands on the tree that actually renders.
  focusLeaf(paneRootFor(), fresh);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
}

// Where a leaf sits in the tree: {holder, index, parent} where holder
// is "root" (the leaf is the root) or the children array containing it,
// parent the split node owning that array (null in the root case).
function findLeafSlot(root, leaf) {
  if (root === leaf) return { holder: "root", index: 0, parent: null };
  const walk = (node) => {
    if (!isPaneSplit(node)) return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i] === leaf) return { holder: node.children, index: i, parent: node };
      const found = walk(node.children[i]);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

// Chord splits (Ctrl+B then D / Shift+D) anchor on the active
// terminal's leaf too, same rule as the bar's Split pair: the route
// names the terminal the user is working in, and a split that grows a
// different panel loses them. Editor/git and no-route states keep the
// focused leaf.
function splitPaneRight() {
  const root = paneRootFor();
  if (paneTreeRenderable(root)) {
    const anchor = splitAnchorLeaf(root);
    if (anchor) {
      focusLeaf(root, anchor);
      return splitActivePane("row");
    }
  }
  return splitActivePane("row");
}

function splitPaneDown() {
  const root = paneRootFor();
  if (paneTreeRenderable(root)) {
    const anchor = splitAnchorLeaf(root);
    if (anchor) {
      focusLeaf(root, anchor);
      return splitActivePane("column");
    }
  }
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

// Strip split buttons: act on the pane whose strip was pressed. One
// rule: focus the target leaf, then the same extend/nest mechanic the
// chords use. Both buttons stay available at any depth (tmux model).
function splitPaneFor(encodedPaneId, kind) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaf = leafForPaneId(root, encodedPaneId);
  if (!leaf) return false;
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
    // Routed through the exported namespace so standalone harnesses
    // and the real bundle resolve the same discovery entry.
    if (window.HerdrLocationBar && window.HerdrLocationBar.openDiscoveryForFolder)
      window.HerdrLocationBar.openDiscoveryForFolder(
        typeof selectedWorkspaceRepoPath === "function"
          ? selectedWorkspaceRepoPath() || explorationDefaultDirectoryOption()
          : explorationDefaultDirectoryOption(),
      );
    return;
  }
  const root = paneRootFor();
  const leaf = paneTreeRenderable(root) ? leafForPaneId(root, encodedPaneId) : null;
  if (typeof newTab === "function") {
    if (leaf) {
      // Terminal ids are the only backend kind; remember where this one
      // belongs before the backend list lands.
      requestTabPlacement(leaf.paneId);
    }
    await newTab();
  }
}

// Where the + button (and the workspace picker) wants the next created
// terminal tab to live. The sync consumes it once so a later plain
// newTab() is unaffected.
let pendingTabPlacements = null;

function requestTabPlacement(paneId) {
  if (!paneId) return;
  pendingTabPlacements = pendingTabPlacements || new Map();
  pendingTabPlacements.set("__next__", paneId);
  // The user picked this pane as the new terminal's home: that intent
  // outlives any stale gesture marker on the pane. Disarm now, while
  // the POST is in flight, so a poll render's sweep cannot fold the
  // placement's target leaf out from under the incoming id (the
  // folded paneId would strand the placement and the terminal would
  // land in whatever leaf holds focus instead).
  disarmLeafAutoClose(paneForPaneId(paneRootFor(), paneId));
}

// Create a panel in ANY workspace and land it in a specific pane (D3):
// the picker's new-tab scope and the sidebar card drag-drop share this
// path. The pending placement tells the sync which leaf owns the fresh
// id, the POST creates it in the picked workspace, and the route moves
// to it (workspace first, tab second, so the snapshot filter keeps the
// new row visible on arrival).
async function openPanelInWorkspace(workspaceId, paneId) {
  if (!workspaceId) return;
  if (paneId) requestTabPlacement(paneId);
  if (typeof showBlocking === "function") showBlocking("Creating panel...");
  try {
    const r = await api("/api/tabs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    const tabId = r && r.result && r.result.tab ? r.result.tab.tab_id : null;
    if (tabId && typeof go === "function") go(workspaceId, tabId);
  } finally {
    if (typeof hideBlocking === "function") hideBlocking();
  }
}

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
  const leaf = activeLeaf(root);
  if (!leaf) return false;
  // Closing the maximized leaf un-maximizes first: the surviving sibling
  // takes the screen instead of a half-restored layout.
  const entry = panesStateFor();
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  const wsId = leafWorkspaceId(leaf);
  // Single-panel tree: closing it would leave the collector nothing to
  // render. The last panel of its workspace is the cascade case below
  // (workspace close), which never leaves an empty tree because other
  // workspaces' panels stay. A one-leaf tree with no other workspace
  // panel to show stays; the strip close stays hidden there.
  if (leaves.length <= 1) return false;
  // Migration only inside the same workspace: a panel's tabs must not
  // leak into another workspace's panel. The nearest same-ws leaf in
  // tree order takes them; cross-ws neighbors are skipped.
  // Decay fold stamp: the group shape this panel leaves behind. The
  // leaf drops out of the tree below, so its split cannot be resolved
  // after the drop; the fold reads the stamp instead.
  const pre = autoClosePreStateFor(root, leaf);
  let migration = paneLeaves(root).find((candidate) => candidate !== leaf && leafWorkspaceId(candidate) === wsId) || null;
  // A view closing out of a group hands its labels to the collector,
  // not to whatever same-ws leaf tree order found first; the fold below
  // then merges the last view the same way.
  if (pre && pre.collectorId
    && leafWorkspaceId(paneForPaneId(root, pre.collectorId)) === wsId)
    migration = paneForPaneId(root, pre.collectorId);
  const liveRouteTab = state.tab != null ? String(state.tab) : null;
  if (migration) {
    for (const tabId of [...leaf.tabs])
      if (!migration.tabs.includes(tabId)) migration.tabs.push(tabId);
    disarmLeafAutoClose(migration);
    // Heal only a null or dangling pointer: a survivor already showing a
    // live tab keeps it. When the pointer must heal, the route terminal
    // tab wins first (the terminal singleton keeps its home), else the
    // first migrated tab.
    if (!migration.active || !migration.tabs.includes(migration.active))
      migration.active = (liveRouteTab && migration.tabs.includes(liveRouteTab) ? liveRouteTab : migration.tabs[0]) || null;
  }
  // Cascade rule: the last panel of a workspace closing takes the
  // workspace with it (its tabs and sidebar entry). Any remaining
  // same-ws panel would have taken the tabs above; reaching here with a
  // bound leaf means this panel was the last. dropLeafFromTree keeps a
  // survivor focused and renders.
  const lastOfWs = !!wsId && !paneLeaves(root).some((candidate) => candidate !== leaf && leafWorkspaceId(candidate) === wsId);
  if (!dropLeafFromTree(leaf)) return false;
  // Unified collapse: closing a view may drop its group below two
  // members; fold the survivors home before the single paint below
  // covers both.
  collapseUnderMemberedGroup(pre);
  // dropLeafFromTree never renders (the sync's ws sweep calls it
  // mid-pass; a render there would re-enter renderWorkspacePanes ->
  // sync). The explicit close owns the render + remount of the healed
  // active tab in the surviving panel: the owning module re-parents its
  // container into the fresh content slot on mount. Terminal tabs need
  // no remount call, the render moves #terminalShell itself.
  renderWorkspacePanes();
  if (lastOfWs && wsId && typeof closeWorkspaceById === "function") {
    // Fire-and-forget: closeWorkspaceById owns its own refresh and
    // error surfacing. The panel is already gone from the tree; a failed
    // close leaves the terminal rows to the sync's prune.
    void closeWorkspaceById(wsId);
  }
  if (migration && migration.active) {
    if (isEditorTab(migration.active)) void activateEditorTab(editorTabPath(migration.active));
    else if (isGitTab(migration.active)) void openGitTab(gitTabViewKey(migration.active));
    else if (typeof go === "function" && state.tab !== migration.active)
      go(workspaceIdForTab(migration.active), migration.active);
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

// Collector drop: remove a leaf whatever it holds (bound to a closed
// workspace, or an explicit panel close). collapseEmptyLeafInTree
// refuses leaves with tabs, so the ws sweep needs this stronger
// dropper. Reuses the same slot/normalize/focus mechanics: sibling
// promoted, single-child splits collapse, focus moves to the nearest
// survivor. Returns false when nothing changed (leaf already gone or
// it is the whole tree, where dropping it would leave the collector
// with nothing to render).
function dropLeafFromTree(leaf) {
  const entry = panesStateFor();
  const root = entry.root;
  if (!isPaneLeaf(leaf) || !paneLeaves(root).includes(leaf)) return false;
  if (root === leaf) return false;
  const slot = findLeafSlot(root, leaf);
  if (!slot) return false;
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  const holderArray = slot.holder;
  if (holderArray === "root") return false;
  const survivor = migrationTargetForClosedLeaf(root, leaf);
  const sibling = holderArray.length === 2 ? holderArray[1 - slot.index] : null;
  if (sibling) {
    const parentSlot = findSplitSlot(root, holderArray);
    if (!parentSlot) return false;
    if (parentSlot.holder === "root") entry.root = sibling;
    else parentSlot.holder[parentSlot.index] = sibling;
  } else {
    holderArray.splice(slot.index, 1);
    normalizeEntryRoot(entry);
  }
  const liveRoot = entry.root;
  const focusTarget = (survivor && paneLeaves(liveRoot).includes(survivor) && survivor !== leaf)
    ? survivor
    : activeLeaf(liveRoot) || paneLeaves(liveRoot)[0];
  if (focusTarget) focusLeaf(liveRoot, focusTarget);
  saveWorkspacePanesStates();
  return true;
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

// A split leaf whose last tab just closed keeps a dead pane on screen.
// Drop it the same way the strip close does: sibling promoted into the
// parent slot, single-child splits collapse, wider parents splice. No
// tab migration here: the leaf emptied out, so the nearest survivor
// (route- or tree-order) takes focus instead. Single-leaf trees keep
// their empty leaf for the New terminal card.
// Collapse works on any workspace's tree, not just the current one: the
// entry that owns the root must be the one rewritten. Callers pass the
// entry explicitly (panesStateFor() default keeps the historical
// single-workspace call sites unchanged); the root-replacement writes
// below target it, so a sweep over foreign trees can never swap another
// workspace's root object.
function collapseEmptyLeafInTree(root, leaf, entry = panesStateFor()) {
  if (!isPaneSplit(root)) return false;
  const leaves = paneLeaves(root);
  if (leaves.length <= 1 || !leaves.includes(leaf)) return false;
  if (leaf.tabs.length) return false;
  const survivor = migrationTargetForClosedLeaf(root, leaf);
  const slot = findLeafSlot(root, leaf);
  if (!slot || slot.holder === "root") return false;
  if (entry.maximizedPaneId === leaf.paneId) entry.maximizedPaneId = null;
  const holderArray = slot.holder;
  const sibling = holderArray.length === 2 ? holderArray[1 - slot.index] : null;
  if (sibling) {
    const parentSlot = findSplitSlot(root, holderArray);
    if (!parentSlot) return false;
    if (parentSlot.holder === "root") entry.root = sibling;
    else parentSlot.holder[parentSlot.index] = sibling;
  } else {
    holderArray.splice(slot.index, 1);
    normalizeEntryRoot(entry);
  }
  const liveRoot = entry.root;
  const focusTarget = (survivor && paneLeaves(liveRoot).includes(survivor) && survivor !== leaf)
    ? survivor
    : activeLeaf(liveRoot) || paneLeaves(liveRoot)[0];
  if (focusTarget) focusLeaf(liveRoot, focusTarget);
  saveWorkspacePanesStates();
  return true;
}

// Auto-close sweep (v3.2): only panels EMPTIED by a move, drop, or
// close auto-close; fresh splits (empty by design, Enter spawns there)
// keep standing until the user closes them. The emptying sites mark the
// leaf (leaf.autoCloseArmed = true) at the moment the last tab leaves it;
// the sweep then closes armed leaves the focus pointer is not on (focus
// moved with the moved tab or the close kept it one gesture), and the
// tree's last panel never drops. The marker clears when a leaf gains
// tabs again (Enter spawn, drag-in), so a re-filled panel never closes.
// Loop-guarded: one collapsed leaf reshapes the tree, so the sweep
// re-reads the root per iteration instead of walking a stale snapshot.
function armLeafAutoClose(leaf) {
  if (leaf && !leaf.tabs.length) leaf.autoCloseArmed = true;
}

function disarmLeafAutoClose(leaf) {
  if (leaf) leaf.autoCloseArmed = false;
}

// Fold mechanics: the lone view's tabs append into the collector
// (deduped, same contract as a close migration), its panel drops, and
// focus lands on the collector. The collector's active tab keeps
// priority; a folded label rides as a strip tab, not the shown one.
// Save sits after the drop: a failed drop must not persist the merged
// tabs while the panel still stands.
function foldLeafIntoCollector(view, collector) {
  for (const tabId of [...view.tabs])
    if (!collector.tabs.includes(tabId)) collector.tabs.push(tabId);
  disarmLeafAutoClose(collector);
  if (!collector.active) collector.active = view.active || collector.tabs[0] || null;
  const dropped = dropLeafFromTree(view);
  if (!dropped) return false;
  saveWorkspacePanesStates();
  focusLeaf(paneRootFor(), collector);
  return true;
}

// The decay fold: a group down to its last view folds that view back
// into the collector, so the fan-out never strands one split view
// beside the stack it came from. The stamped pre tells who left (a
// view, out of a group, with a same-ws collector); the CURRENT split
// around that collector decides whether the fold fires now, so two
// views emptied by one batch gesture stay (the surviving collector
// split still counts 2 views) and a stale pre cannot fire on a
// freshly placed view.
// Unified collapse (redo): a group whose fan-out dropped below TWO
// members (views + marked slots) dissolves back into its dock: every
// remaining same-ws view folds its labels in, every marked slot drops.
// The dock itself stays (it is the collector the labels return to);
// the wrappers flatten through the sibling-promotion the folds trigger.
// Called (1) per consumed pre stamp (gesture-driven removals: bar drop,
// strip drop, close) and (2) from the sweep's marker pass (closes that
// leave no stamp, like the slot's own ✕). Cross-ws views never fold
// into a foreign dock; they stand and the group dies around them.
function collapseGroupArea(split, dock) {
  if (!isPaneSplit(split) || !dock) return false;
  let changed = false;
  let guard = 6;
  while (guard-- > 0) {
    const liveRoot = paneRootFor();
    if (!paneLeaves(liveRoot).includes(dock)) break;
    if (paneGroupSplitForLeaf(liveRoot, dock) !== split) break;
    const views = paneGroupVisibleViews(split).filter((leaf) => leaf !== dock);
    const slots = paneGroupSlots(split);
    if (views.length + slots.length >= 2) break;
    if (views.length === 1) {
      const view = views[0];
      if (leafWorkspaceId(view) !== leafWorkspaceId(dock)) break;
      if (!foldLeafIntoCollector(view, dock)) break;
      changed = true;
      continue;
    }
    if (slots.length === 1) {
      if (!dropLeafFromTree(slots[0])) break;
      changed = true;
      continue;
    }
    break;
  }
  return changed;
}

// Pre-driven entry: the consumed stamp names the dock the removed view
// left; the dock's CURRENT structural area decides the fold.
function collapseUnderMemberedGroup(pre) {
  if (!pre || !pre.collectorId) return false;
  const root = paneRootFor();
  const collector = paneForPaneId(root, pre.collectorId);
  if (!collector || !paneLeaves(root).includes(collector)) return false;
  if (leafWorkspaceId(collector) !== (pre.wsId || null)) return false;
  const split = paneGroupSplitForLeaf(root, collector);
  if (!split) return false;
  return collapseGroupArea(split, collector);
}

// Marker pass: closes that produce no pre stamp (the slot's own ✕)
// still owe the group a collapse when the marked dock stands with a
// lone view. Fires only on the strict shape: a marked dock, exactly
// one view, no slots, no neutral empty leaf, and no second stack
// (manual split arrangements and dock-less pairs never fold).
function collapseMarkedGroupAreas() {
  const root = paneRootFor();
  if (!isPaneSplit(root)) return false;
  const areas = root.children.every((child) => child && child.kind === "pane")
    ? [root]
    : root.children.filter((child) => isPaneSplit(child));
  let changed = false;
  for (const area of areas) {
    const leaves = paneLeaves(area);
    const dock = leaves.find((leaf) => leaf.groupCollector === true);
    if (!dock) continue;
    if (paneGroupVisibleViews(area).length !== 1) continue;
    if (paneGroupSlots(area).length) continue;
    const stacks = leaves.filter(
      (leaf) => leafTerminalLabelCount(leaf) > 1 || leaf.groupCollector === true
    );
    if (stacks.length > 1) continue;
    const neutral = leaves.filter(
      (leaf) => leaf !== dock && !isGroupView(leaf) && !isGroupSlot(leaf)
        && leafTerminalLabelCount(leaf) === 0 && !leaf.tabs.length
    );
    if (neutral.length) continue;
    if (collapseGroupArea(area, dock)) changed = true;
  }
  return changed;
}

// A leaf inside a collapsed group split: the collapsed views and
// their dock. The sweep and the strip-count guards use this to keep
// the hidden tree intact while the stamp lives.
function leafInCollapsedSplit(root, leaf) {
  if (!root || !leaf) return false;
  const split = paneGroupSplitForLeaf(root, leaf);
  return !!(split && isCollapsedGroup(split));
}

function sweepAbandonedEmptyLeaves() {
  // Focus capture: the tree's focused leaf at sweep entry keeps immunity
  // for the WHOLE loop. collapseEmptyLeafInTree reassigns focus to the
  // survivor mid-collapse; without the capture, that shuffle would
  // abandon the originally focused armed leaf and the next iteration
  // would eat it, cascading a split tree down to one panel. The
  // gesture's focus (user click, split command, tab move) is the intent
  // signal; the sweep must never generate its own. Resolve through
  // activeLeaf (same accessor every consumer uses) so a stale/null
  // activePaneId heals to the effective focused leaf instead of
  // protecting nobody.
  const protectedLeaf = activeLeaf(paneRootFor());
  const protectedId = (protectedLeaf || {}).paneId || null;
  let guard = 16;
  let changed = false;
  // Decay fold first: an armed empty view took its label out of a
  // group; when the group drops below two members the survivors fold
  // home and their panels drop in this same sweep, before the armed
  // source itself collapses below. Each stamp is one-shot: consumed
  // here, or the pre stays stale for the next sweep to misfire on.
  for (const leaf of paneLeaves(paneRootFor())) {
    if (!leaf.autoCloseArmed || leaf.tabs.length || !leaf.autoClosePre) continue;
    const pre = leaf.autoClosePre;
    leaf.autoClosePre = null;
    if (collapseUnderMemberedGroup(pre)) changed = true;
  }
  while (guard-- > 0) {
    const root = paneRootFor();
    if (!isPaneSplit(root)) break;
    const leaves = paneLeaves(root);
    if (leaves.length <= 1) break;
    const victim = leaves.find((leaf) => leaf.autoCloseArmed && !leaf.tabs.length && leaf.paneId !== protectedId
      // A collapsed group's views stay in the tree by design: their
      // labels folded home on the collapse gesture, and the chip press
      // re-expands into them. Sweeping them would destroy the group.
      && !leafInCollapsedSplit(paneRootFor(), leaf));
    if (!victim) break;
    if (!collapseEmptyLeafInTree(paneRootFor(), victim)) break;
    changed = true;
  }
  // Marker pass AFTER the armed loop (phantom slots are gone by now):
  // unstamped closes (the slot's own ✕) still owe a marked group its
  // collapse when the strict under-membered shape stands.
  if (collapseMarkedGroupAreas()) changed = true;
  // Restore: a collapse may have moved focus to a survivor; put it back
  // on the captured leaf when it still lives, so the focused empty panel
  // (fresh split, Enter target) keeps its focus through the sweep.
  if (changed && protectedId) {
    const liveRoot = paneRootFor();
    const kept = paneForPaneId(liveRoot, protectedId);
    if (kept && activeLeaf(liveRoot) !== kept) focusLeaf(liveRoot, kept);
  }
  return changed;
}

// v3.2 choke point for single-tab removals from a leaf: splice the id
// out, heal the active pointer, and arm the leaf when the removal
// emptied it (the arm helper owns the emptiness guard). Every close
// path routes through here, so a future emptying site cannot forget
// the marker: a missing arm is the bug class v3.2 fixes (empty panels
// standing forever). neighborHeal picks the close-style pointer heal
// (the tab beside the closed one takes over); the terminal close and
// the strip paths use the simpler first-tab heal.
function removeTabFromLeaf(leaf, tabId, neighborHeal) {
  const at = leaf.tabs.indexOf(tabId);
  if (at < 0) return false;
  // Decay fold stamp before the splice changes the leaf's label count.
  leaf.autoClosePre = autoClosePreStateFor(paneRootFor(), leaf);
  leaf.tabs.splice(at, 1);
  if (neighborHeal) leaf.active = leaf.tabs[at] || leaf.tabs[at - 1] || leaf.tabs[0] || null;
  else if (leaf.active === tabId) leaf.active = leaf.tabs[0] || null;
  armLeafAutoClose(leaf);
  return true;
}

// Sweep helper for the close flows: drop the id from its leaf's tabs,
// but ONLY the id. A blanket empty-leaf sweep would also swallow a
// split-created sibling that is empty by design (its strip still
// offers New terminal). Collector model: the emptied panel STANDS as
// an empty panel (path + Enter hint); no collapse fires here. The
// explicit panel close (closeActivePane) and the workspace cascade
// own panel removal.
function pruneClosedTabFromLeaf(tabId) {
  if (!tabId) return false;
  const root = paneRootFor();
  const id = String(tabId);
  const leaf = paneForTab(root, id);
  if (!leaf) return false;
  if (!removeTabFromLeaf(leaf, id, false)) return false;
  saveWorkspacePanesStates();
  return true;
}

// Facade for cross-module terminal-tab closes (worktrees.js closeTab,
// core.js pane/tab.closed handlers): one call owns the whole close
// aftermath inside this module (prune the id, sweep armed+empty
// leaves, paint once). Callers used to reach for the internal sweep
// directly; the sweep's guards (focus capture, last-panel, focus
// restore) are module invariants and must not leak to other modules,
// and the tree/DOM pair must never diverge between the two calls.
function onTerminalTabClosed(tabId) {
  const pruned = pruneClosedTabFromLeaf(tabId);
  if (sweepAbandonedEmptyLeaves()) renderWorkspacePanes();
  return pruned;
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
  if (!target || target === leaf) return false;
  // Delegate to the shared move primitive (splice, activate, focus,
  // persist, module re-mount all live there; the v3.2 marker stays
  // with this gesture): the chord empties the source, so the source
  // arms here and the single render folds it.
  if (!movePaneTabTo(tabId, target.paneId, null, { skipRender: true })) return false;
  armLeafAutoClose(leaf);
  renderWorkspacePanes();
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

// ---- default-label workspace prefix (D15) ----------------------------
// Foreign-workspace default panels number inside their own workspace, so
// two bare numbers on one strip can read as one series when they are not.
// Only tabs OUTSIDE the selected workspace carry the prefix: the selected
// workspace's own numbers stay bare, and a workspace switch flips which
// side is prefixed (accepted trade-off, the pane badge names the leaf's
// workspace either way). Custom names never get a prefix: the user named
// the panel, the name is the identity. A foreign workspace with no
// matching state.workspaces row keeps the bare number (its row resolves
// through tabsById, but the display name needs the workspace record).
function foreignWorkspacePrefix(tabId) {
  if (!treeIsMixed()) return "";
  const row = paneTerminalTabById(tabId);
  const workspaceId = (row && row.workspace_id) || state.ws;
  if (!workspaceId || workspaceId === state.ws) return "";
  const workspace = (state.workspaces || []).find(
    (candidate) => candidate.workspace_id === workspaceId,
  );
  if (!workspace) return "";
  const name =
    (typeof worktreeDisplayName === "function" &&
      worktreeDisplayName(workspace)) ||
    workspace.label;
  return name ? `${name} ` : "";
}

// The name every panel-facing surface should speak: the visible strip
// label, prefix included (D15). Hover title, document title, and the
// strip itself must never drift apart on a foreign default panel.
function panelDisplayName(tab, index, tabs = state.tabs || []) {
  return panelVisibleLabel(tab, index, tabs);
}

function panelVisibleLabel(tab, index, tabs = state.tabs || []) {
  const label = String((tab && tab.label) || "").trim();
  if (isDefaultPanelTitle(label)) {
    const prefix = foreignWorkspacePrefix(tab && tab.tab_id);
    return prefix ? `${prefix}${panelNumberLabel(tab, index, tabs)}` : panelNumberLabel(tab, index, tabs);
  }
  return label;
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
    // Pass memo: the pane map builds once per paint on the first hover
    // read (strip tabs each carry a title attribute), and out-of-pass
    // callers keep computing it fresh exactly as before.
    if (panePassLookups) {
      if (!panePassLookups.panesByTab) panePassLookups.panesByTab = panesByTabIndex();
      return tabHoverInfo(tab, panePassLookups.panesByTab);
    }
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
function paneRootFor() {
  return panesStateFor().root;
}

// Location-bar + (collector): mint an empty panel for the FOCUSED
// panel's workspace, auto-split beside the focused leaf, focus it.
// Returns the minted leaf, or null when no tree exists yet (the
// dashboard owns the center; the caller falls back to newTab()).
function newPanelForFocused() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const anchor = activeLeaf(root);
  const wsId = anchor ? leafWorkspaceId(anchor) : null;
  const fresh = mintPanelForWorkspace(wsId, anchor);
  if (!fresh) return null;
  focusLeaf(paneRootFor(), fresh);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return fresh;
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
    disarmLeafAutoClose(leaf);
    // Refill clears the slot mark: a pane hosting an editor tab is a view.
    delete leaf.groupSlot;
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  }
  if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
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
  // v3.2: removal runs through the choke point (splice + neighbor
  // heal + arm-if-empty); the arm fires on the render below (sweep at
  // render top). The focused-leaf exception spares the emptied leaf
  // until focus moves elsewhere; fresh splits (never armed) stay
  // standing; single-leaf trees keep their last panel by the sweep
  // guard.
  const wasActive = leaf.active === tabId;
  if (!removeTabFromLeaf(leaf, tabId, true)) return;
  if (wasActive) {
    if (isEditorTab(leaf.active)) void activateEditorTab(editorTabPath(leaf.active));
    else if (isGitTab(leaf.active)) void openGitTab(gitTabViewKey(leaf.active));
    else if (leaf.active && typeof go === "function") go(workspaceIdForTab(leaf.active), leaf.active);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
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
    disarmLeafAutoClose(leaf);
    // Refill clears the slot mark: a pane hosting a git tab is a view.
    delete leaf.groupSlot;
    saveWorkspacePanesStates();
    renderWorkspacePanes();
  }
  if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
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
  // v3.2: same removal choke point and auto-close semantics as the
  // editor close above; the sweep's own guards (focused leaf, last
  // panel) carry the invariants.
  const wasActive = leaf.active === tabId;
  if (!removeTabFromLeaf(leaf, tabId, true)) return;
  if (wasActive) {
    if (isEditorTab(leaf.active)) void activateEditorTab(editorTabPath(leaf.active));
    else if (isGitTab(leaf.active)) void openGitTab(gitTabViewKey(leaf.active));
    else if (leaf.active && typeof go === "function") go(workspaceIdForTab(leaf.active), leaf.active);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
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
  // Group collapse: pressing a docked panel label inside a live group
  // returns the base state (one visualised panel). The pressed label's
  // dock collects every group view's terminal labels, the marked slots
  // drop, and the split renders as the dock alone with a "Group N
  // panels" chip whose press re-expands the group (spec: "once pressed
  // it will switch fully to that panel view").
  if (collapseGroupForTabPress(tabId)) return;
  // The route carries the tab's OWN workspace (D1 mixed tree): a
  // cross-workspace tab navigating under state.ws would land on a
  // mismatched route and the snapshot filter would hide its row.
  go(workspaceIdForTab(tabId), tabId);
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

// Per-leaf empty panel card (collector model): replaces the singleton
// #workspaceEmptyLeaf card render.js owned. Signature-gated innerHTML
// keeps a no-change render pass from rebuilding the card (focus stays
// put). The card is one .workspace-empty-leaf element per leaf: the
// existing card CSS (.workspace-empty-leaf + .workspace-empty-leaf-card)
// styles it, no new styles. Named-panel chip already identifies the
// workspace at the strip; the card repeats the PATH because the empty
// state is where the user asks "where am I".
function mountEmptyPanelCard(content, leaf) {
  if (!content) return;
  // Direct-child scan, not a :scope selector: the vm test stubs run a
  // hand-rolled querySelector that may not parse scoping syntax.
  let card = [...(content.children || [])].find(
    (child) => hasClass(child, "workspace-empty-leaf") && child !== el("workspaceEmptyLeaf"),
  );
  if (!card) {
    card = document.createElement("section");
    card.className = "workspace-empty-leaf";
    card.setAttribute("tabindex", "-1");
    const inner = document.createElement("div");
    inner.className = "workspace-empty-leaf-card";
    card.appendChild(inner);
    content.appendChild(card);
  }
  const wsId = leafWorkspaceId(leaf);
  const workspace = wsId ? (state.workspaces || []).find((w) => w.workspace_id === wsId) : null;
  const name = workspace
    ? ((typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) || workspace.label || wsId)
    : "";
  const newTitle = typeof titleWithWebuiShortcut === "function"
    ? titleWithWebuiShortcut("New terminal", "newPanel")
    : "New terminal";
  // Marked slots render a placeholder card instead of the empty hint:
  // the drop target needs a visible surface to hit, and the card text
  // tells the drag owner what the drop does (populate this group slot).
  if (leaf.groupSlot === true) {
    const slotHtml = `<h1>${escapeHtml(name || wsId || "Group slot")}</h1>`
      + `<p>Drag a tab here to add it to the group.</p>`;
    if (card.__herdrEmptySignature !== slotHtml) {
      card.__herdrEmptySignature = slotHtml;
      const inner = card.querySelector(".workspace-empty-leaf-card");
      if (inner) inner.innerHTML = slotHtml;
    }
    if (card.hidden) card.hidden = false;
    return;
  }
  const html = `<h1>${escapeHtml(name || wsId || "Empty panel")}</h1>`
    + `<p>No terminal in this panel yet.</p>`
    + `<p class="workspace-empty-leaf-hint">Press <kbd>Enter</kbd> to open a terminal.</p>`
    + `<button class="workspace-empty-leaf-new" title="${escapeAttr(newTitle)}" aria-label="${escapeAttr(newTitle)}" onclick="event.preventDefault();newTabForPane('${escapeAttr(encodeURIComponent(leaf.paneId))}')">New terminal</button>`;
  if (card.__herdrEmptySignature !== html) {
    card.__herdrEmptySignature = html;
    const inner = card.querySelector(".workspace-empty-leaf-card");
    if (inner) inner.innerHTML = html;
  }
  if (card.hidden) card.hidden = false;
}

// A card from the leaf's last empty state: removed the moment the
// leaf holds tabs again (the live surface owns the slot).
function removeEmptyPanelCard(content) {
  if (!content || !content.children) return;
  for (const child of [...content.children]) {
    if (hasClass(child, "workspace-empty-leaf") && child !== el("workspaceEmptyLeaf")) {
      detachDomNode(child);
    }
  }
}

// The shell must never linger inside an empty panel's slot. Scope is
// strictly THIS slot: a sibling terminal leaf can own the shell (owner
// resolution), and ripping it out of its live slot here would blank a
// rendered terminal. Only when the shell actually sits in this empty
// slot (this leaf owned it before its last tab closed) does it move
// back to the #workspacePanes home, hidden, same as the editor/git
// owner branch.
// A shell already PARKED at the home container hides too: the drop
// rescue moves it there without touching display, and this empty leaf
// is the owner-of-record the render resolved (the card branch returns
// before any owner-branch display write). Left shown, a phantom pane
// paints under the card for as long as this leaf stays empty. The home
// container hosts no live surface, so the hide is safe whatever owned
// the shell before; the next owner branch is the only thing that can
// lift it again.
function parkTerminalShellForEmptyLeaf(content) {
  if (!content) return;
  const terminalShell = el("terminalShell");
  if (!terminalShell) return;
  const panesContainer = el("workspacePanes");
  const shellInThisSlot = terminalShell.parentElement === content;
  const shellParkedHome = panesContainer && terminalShell.parentElement === panesContainer;
  if (!shellInThisSlot && !shellParkedHome) return;
  if (shellInThisSlot && panesContainer) {
    if (terminalShell.parentElement) terminalShell.parentElement.removeChild(terminalShell);
    panesContainer.appendChild(terminalShell);
  }
  if (terminalShell.style) terminalShell.style.display = "none";
  // Stale editor/git containers from a previous tab state hide too:
  // the card owns the slot now.
  hideStalePaneContainers(content);
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
  // Dock labels only: the marked collector inside a live group is the
  // label dock, not a viewing pane. The base rule is one visible panel
  // at a time, so a dock never selected for viewing mounts no surface:
  // its strip keeps the docked labels accessible, and pressing one
  // focuses the dock pane and the view follows the focus (the spec's
  // "once pressed it will switch fully to that panel view"). The dock
  // still mounts normally while focused: the user just chose it, and
  // the focused dock is the one panel being viewed. Editor/git actives
  // ride unchanged: they are client-owned views, not docked panels.
  if (leaf.groupCollector === true && activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab)) {
    const dockGroup = paneGroupForLeaf(root, leaf);
    const dockFocused = activeLeaf(root) === leaf;
    if (dockGroup && !dockFocused) {
      removeEmptyPanelCard(content);
      hideStalePaneContainers(content);
      // The dock's parked terminal must not paint under the labels:
      // a dock whose shell landed here in an earlier focused stint
      // (drop rescue, reshape) sends it home hidden, same as the
      // editor/git owner branch below.
      const shellNow = el("terminalShell");
      const panesHome = el("workspacePanes");
      if (shellNow && shellNow.parentElement === content && panesHome) {
        if (shellNow.parentElement) shellNow.parentElement.removeChild(shellNow);
        panesHome.appendChild(shellNow);
      }
      if (shellNow && shellNow.style) shellNow.style.display = "none";
      return;
    }
  }
  // Empty panel card (collector): a tabs-empty leaf is a valid standing
  // state, and its content slot carries the affordance instead of a
  // blank hole. The card names the bound workspace and routes Enter
  // through the document-level keydown (the pane body owns the key,
  // not the card). The singleton global #workspaceEmptyLeaf card this
  // replaces could only ever show for ONE workspace state; per-leaf
  // cards cover every panel in a mixed tree. No bound ws (unbound
  // survivor after its workspace closed) keeps a generic hint: Enter
  // routes through newTabForPane's discovery path only when a ws
  // exists, and state.ws gates the keydown, so the card is inert
  // chrome there, still naming what the panel is.
  const leafTabs = paneTabsForTree(leaf);
  if (!leafTabs.length) {
    mountEmptyPanelCard(content, leaf);
    parkTerminalShellForEmptyLeaf(content);
    return;
  }
  // The leaf has tabs: a card from its last empty state is stale chrome
  // competing with the live surface for the slot. Remove it before any
  // shell/container mount so the one-surface-per-slot invariant holds.
  removeEmptyPanelCard(content);
  const activeIsTerminal = !!activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab);
  const aux = window.HerdrPaneTerminals;
  // D8 cache: a leaf whose active tab is not a terminal anymore parks
  // its aux surface instead of disposing it (scrollback and the live
  // view survive an editor stint or an owner flip). Real disposal stays
  // on closeTab and the two parked-unrecoverable rules in releaseStale.
  // parkForTab itself no-ops when the tab has no surface.
  const parkAuxForThisLeaf = () => {
    if (aux && activeTab && typeof aux.parkForTab === "function") aux.parkForTab(activeTab);
  };
  const terminalShell = el("terminalShell");
  // Reshape commands (split, maximize, close-promote) move pane
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
      parkAuxForThisLeaf();
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
    parkAuxForThisLeaf();
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
  // The active terminal is NOT the shell's host: the owner leaf can
  // hold a non-route terminal as its active tab (a drop landed one
  // here, or a strip reorder left it on top) while the route tab lives
  // in another leaf. Showing the shell here would render the route
  // tab's pty under this leaf's highlighted tab and dispose the moved
  // tab's surface, the exact dispose-and-recreate the drag contract
  // forbids (D7.4). Mount the aux surface instead, same as a non-owner
  // leaf; the shell stays parked for its real owner.
  const routeTabForShell = state.tab != null ? String(state.tab) : null;
  if (activeIsTerminal && routeTabForShell && activeTab !== routeTabForShell && activeTab !== TERMINAL_TAB_PLACEHOLDER) {
    if (terminalShell) {
      const panesContainer = el("workspacePanes");
      if (panesContainer && terminalShell.parentElement !== panesContainer) {
        if (terminalShell.parentElement) terminalShell.parentElement.removeChild(terminalShell);
        panesContainer.appendChild(terminalShell);
      }
      if (terminalShell.style) terminalShell.style.display = "none";
    }
    hideStalePaneContainers(content);
    if (aux && activeTab && activeTab !== TERMINAL_TAB_PLACEHOLDER) {
      aux.ensureForLeaf(pane, leaf);
      if (auxTabs) auxTabs.push(activeTab);
    }
    return;
  }
  if (terminalShell && terminalShell.style) terminalShell.style.display = "";
  if (content && terminalShell && terminalShell.parentElement !== content)
    content.appendChild(terminalShell);
  hideStalePaneContainers(content);
  // The primary shell took this tab over: its aux surface, if any from an
  // earlier non-owner render, disposes.
  parkAuxForThisLeaf();
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
    const growChildren = [...parent.children].filter((child) => !hasClass(child, "pane-divider"));
    // The divider resizes the pair straddling it (tmux model): with
    // three or more children only the child before it and the child
    // after it move, the neighbors keep their share.
    const all = [...(parent.children || [])];
    const dividerAt = all.indexOf(divider);
    const before = all.slice(0, dividerAt).reverse().find((child) => !hasClass(child, "pane-divider"));
    const after = all.slice(dividerAt + 1).find((child) => !hasClass(child, "pane-divider"));
    if (!before || !after) return;
    dragging = {
      parent,
      growChildren,
      pair: [before, after],
      startX: event.clientX,
      startY: event.clientY,
      starts: { before: parseFloat(before.style.flexGrow) || 1, after: parseFloat(after.style.flexGrow) || 1 },
    };
    divider.setPointerCapture && divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    // pane-column stacks children vertically: the divider lies flat and
    // the drag walks the parent's height.
    const verticalStack = String(dragging.parent.className || "").includes("pane-column");
    const total = dragging.starts.before + dragging.starts.after;
    const rect = dragging.parent.getBoundingClientRect();
    const delta = verticalStack ? event.clientY - dragging.startY : event.clientX - dragging.startX;
    const axisSize = Math.max(1, verticalStack ? rect.height : rect.width);
    const fraction = Math.max(0.1, Math.min(0.9, (dragging.starts.before / total) + delta / axisSize));
    dragging.pair[0].style.flexGrow = String(fraction * total);
    dragging.pair[1].style.flexGrow = String((1 - fraction) * total);
  });
  const finish = () => {
    if (!dragging) return;
    // Persist the FULL size array: the drag moved one pair, but the tree
    // node's sizes cover every child of the split.
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
      const found = walk(child, `${id}/${splitNodeId(child)}`);
      if (found) return found;
    }
    return null;
  };
  return walk(root, splitNodeId(root));
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
  // Location bar pane controls: one group above the panes acting on the
  // focused leaf. The bar renders it and keys its repaints off the
  // signature.
  paneBarControlsHtml,
  paneBarControlsSignature,
  forgetWorkspacePanes,
  pruneWorkspaceTabsFromPanes,
  // Phase 4: split tree surface. paneLeaves/activePane expose the tree
  // walk; the commands are the strip buttons and shortcuts' entry points.
  paneLeaves,
  paneRootFor,
  paneTabsForTree,
  paneWorkspaceBadgeHtml,
  workspaceIdForTab,
  foreignWorkspacePrefix,
  panelVisibleLabel,
  panelDisplayName,
  panelNumberLabel,
  panelRenameInitialLabel,
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
  // Drag pipeline entry points (the strip listeners call these; tests
  // drive them directly because the vm DOM stub does not store listeners).
  paneStripDragOver,
  paneStripDrop,
  // p6: per-strip controls targeting the pressed pane.
  splitPaneRightFor,
  splitPaneDownFor,
  closePaneFor,
  maximizePaneFor,
  newTabForPane,
  requestTabPlacement,
  openPanelInWorkspace,
  paneMenuItemsFor,
  syncTerminalTabsIntoTree,
  terminalShellOwnerLeaf,
  mountDashboardInPane,
  mountEmptyLeafInPane,
  // Collector model helpers: chunk B/C (chips, sidebar resolution,
  // location-bar +) build on these. newPanelForFocused mints an empty
  // focused panel for the focused panel's workspace (auto-split beside
  // it). dropLeafFromTree removes a panel whatever it holds (explicit
  // close cascade + ws-close teardown).
  newPanelForFocused,
  dropLeafFromTree,
  leafWorkspaceId,
  leavesBoundTo,
  focusedLeaf,
  writeRouteFromLeaf,
  focusPanelFor,
  // Location bar unsplit wiring: the bar module owns the DOM, this
  // module owns the tree surgery the bar drop triggers.
  paneTabUnsplitHover,
  paneTabUnsplitDrop,
  // Group collapse (label press) + expand (collapsed chip press).
  expandCollapsedGroup,
  startCollapsedGroupRename,
  collapseGroupForTabPress,
  // Close-aftermath facade for cross-module terminal closes: prunes
  // the id from its leaf, sweeps armed+empty leaves, paints once.
  // The sweep and its guards stay inside this module.
  onTerminalTabClosed,
};
