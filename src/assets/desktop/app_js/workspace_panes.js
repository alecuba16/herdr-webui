// Center pane model for the desktop shell (one-visible-view redo).
// Panels are a FLAT list: every panel is a leaf ({paneId, tabs, active,
// wsId, groupId}) and only ONE subject renders at a time, either a
// single panel or one group's split layout ({kind:"row"|"column",
// sizes, children} trees INSIDE a group record). Dragging a panel label
// onto the view with a half-target preview forms groups; groups are
// the only other visible subject and fold to renameable chips when
// not selected. Tab identity is unchanged: terminal tabs use backend
// tab ids, editor tabs are editor:<path> (one per file), git tabs are
// git:<view-key> (one per view).
//
// Exactly one live terminal surface exists (#terminalShell, one wterm
// instance), so the model enforces a terminal singleton at command
// time: only the leaf holding the route terminal tab ever holds
// terminal tabs, groups never clone it, and the move command refuses
// it. Editor and git tabs can land in any leaf.
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

// Handler-payload escapers. escapeAttr covers attribute values; the
// inline onclick payloads below interpolate ids and file paths inside
// single-quoted JS strings, where HTML entities decode before the
// handler compiles, so those payloads need the JS-string escaper instead.
const escapeHandlerArg =
  (typeof HerdrAppHelpers !== "undefined" && HerdrAppHelpers.escapeJsSingleQuoted)
  || ((v) => String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));

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
  return `<button class="pane-tab git ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="git" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(gitTabTitle(viewKey))}" onclick="activatePaneTab('${escapeHandlerArg(tabId)}')" onauxclick="paneTabAuxClick(event,'git','${escapeHandlerArg(viewKey)}')"><span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close Git view" aria-label="Close Git view" onclick="event.stopPropagation();closeGitTab('${escapeHandlerArg(viewKey)}')">✕</span></button>`;
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
  return `<button class="pane-tab editor ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="editor" data-tab-id="${escapeAttr(tabId)}" draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" title="${escapeAttr(path)}" onclick="activatePaneTab('${escapeHandlerArg(tabId)}')" onauxclick="paneTabAuxClick(event,'editor','${escapeHandlerArg(encoded)}')">${dirty ? '<span class="pane-tab-dirty" title="Modified" aria-hidden="true">●</span>' : ""}<span class="pane-tab-label">${escapeHtml(label)}</span><span class="pane-tab-close" role="button" tabindex="0" title="Close file" aria-label="Close file" onclick="event.stopPropagation();closeEditorTab('${escapeHandlerArg(encoded)}')">✕</span></button>`;
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
  // workspacesById: the member header resolves a workspace record per
  // member per paint (chip and span both do); the Map keeps that a
  // lookup instead of a scan without changing precedence anywhere.
  const workspacesById = new Map();
  for (const workspace of state.workspaces || []) {
    if (workspace && !workspacesById.has(workspace.workspace_id)) workspacesById.set(workspace.workspace_id, workspace);
  }
  return { rows, known, workspacesById, panesByTab: null, treeMixed: treeIsMixedFor(root) };
}

function panesStateFor() {
  if (!state.workspacePanes[SESSION_PANES_KEY]) {
    state.workspacePanes[SESSION_PANES_KEY] = {
      v: 2,
      panels: [newLeaf("p1")],
      groups: [],
      visible: { type: "panel", id: "p1" },
      at: Date.now(),
    };
  }
  return state.workspacePanes[SESSION_PANES_KEY];
}

// ---- group records (one-visible-view model) -------------------------
// A group is an explicit record: ordered member paneIds, a layout tree
// of the same row/column shape the old renderer walked (children are
// paneIds or nested layout nodes), and a renameable name. Exactly one
// group renders at a time (entry.visible), same as a single panel.
let groupIdCounter = 0;
const usedGroupIds = new Set();

function newGroupId() {
  let id;
  do id = `g${++groupIdCounter}`;
  while (usedGroupIds.has(id));
  usedGroupIds.add(id);
  return id;
}

function groupById(root, groupId) {
  return (root && Array.isArray(root.groups) ? root.groups : []).find((g) => g && g.groupId === groupId) || null;
}

function groupForLeaf(root, leaf) {
  const groupId = leaf && leaf.groupId;
  return groupId ? groupById(root, groupId) : null;
}

// Members resolve through ids, never stored refs: persistence hands
// back JSON twins and a dissolved group must answer empty.
function groupMembers(group, entry) {
  // The entry is EXPLICIT on the load path: during loadWorkspacePanesStates
  // the loaded entry is not yet installed, so the panesStateFor() default
  // would lazily mint the boot entry and every group would resolve 0
  // members (the visible group pointer would heal to a panel).
  const resolved = entry || panesStateFor();
  const ids = (group && Array.isArray(group.memberIds) ? group.memberIds : []).slice();
  return ids.map((id) => resolved.panels.find((p) => p.paneId === id)).filter(Boolean);
}

function groupMemberCount(group, entry) {
  return groupMembers(group, entry).length;
}

function groupDefaultName(group) {
  return `Group ${groupMemberCount(group)} views`;
}

function groupVisibleName(group) {
  return (group && group.name) || groupDefaultName(group);
}

// The leaf holding a paneId inside a group layout tree (children are
// paneIds or nested nodes).
function layoutHoldsPaneId(node, paneId) {
  if (typeof node === "string") return node === paneId;
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node.children)) return node.children.some((c) => layoutHoldsPaneId(c, paneId));
  return false;
}

// The visible subject record: {kind:"panel", leaf} or {kind:"group",
// group}. A stale visible pointer (closed panel, dissolved group)
// heals to the first panel; an all-empty store has no subject.
function visibleSubject(entry) {
  if (!entry || !Array.isArray(entry.panels) || !entry.panels.length) return null;
  const vis = entry.visible;
  if (vis && vis.type === "group") {
    // Pass THIS entry: the member count must resolve against the entry
    // being read, not the lazily-minted store default (load path); the
    // same rule covers the survivor read below it.
    const group = groupById(entry, vis.id);
    if (group && groupMemberCount(group, entry) >= 2) return { kind: "group", group };
    // Standing under-2 record (close just spliced a member): the
    // survivor is the subject, not panels[0] from the fallback.
    if (group) {
      const survivor = groupMembers(group, entry)[0];
      if (survivor) return { kind: "panel", leaf: survivor };
    }
  }
  const panel = (vis && vis.type === "panel" && entry.panels.find((p) => p.paneId === vis.id)) || entry.panels[0];
  return { kind: "panel", leaf: panel };
}

// Is the named group the visible split subject? Chip affordances and
// drop validity both gate on this: only the visible group can grow or
// re-position (hidden records are read-only until reopened).
function visibleSubjectIsGroup(entry, groupId) {
  if (!entry || !groupId) return false;
  const vis = entry.visible;
  return !!(vis && vis.type === "group" && vis.id === groupId);
}

// Subject switch. Groups PERSIST: switching to a panel shows that panel
// flat while every group record survives as its own rail chip, and a
// group subject reopens the split. opts ({groupId, focusedPaneId})
// rides the op so the server's record (other clients, reload) learns
// the member this client last viewed inside that group.
function setVisibleSubject(type, id, opts) {
  const entry = panesStateFor();
  const subject = type === "group" ? { type: "group", id } : { type: "panel", id };
  const prev = visibleSubject(entry);
  entry.visible = subject;
  entry.at = Date.now();
  saveWorkspacePanesStates();
  // Server mode: the entry's visible rides the shared record as the
  // last writer's view (the design keeps the SUBJECT per-client, and
  // each adoption overlays its own pointer back). Fire-and-forget so
  // the local render never waits on the round trip: the local write is
  // already saved, and the helper only fires the op (null mutation).
  if (panesMode === "server") {
    const payload = { op: "subject.set", visible: subject };
    if (opts && opts.groupId && opts.focusedPaneId) {
      payload.groupId = opts.groupId;
      payload.focusedPaneId = opts.focusedPaneId;
    }
    panesOpWithFallback(payload, null);
  }
  renderWorkspacePanes();
  return prev;
}

// ---- panel model (one-visible-view redo) ----------------------------
// Panels carry a stable paneId used by the DOM reconcile and the focus
// pointer. The list helpers below are the only sanctioned access:
// everything that used to assume "the pane" goes through
// paneForTab/paneForPaneId/paneLeaves so a tab in any panel resolves,
// not just the first one. paneLeaves/paneRootFor keep their names for
// the consumers (pane_focus.js, tests): the "root" is the session entry
// and "leaves" are the flat panels list.

// Class test that works on real DOM elements and the minimal fakes the
// node harnesses use (className string, no classList/nodeType).
function hasClass(node, name) {
  return !!(node && typeof node.className === "string"
    && node.className.split(/\s+/).indexOf(name) >= 0);
}

// Recursive pane lookup by paneId. querySelector with attribute selectors
// is avoided on purpose: the node-test DOM stubs only support #id and
// .class selectors, and split trees bury panes several levels deep.
function findPaneElementById(element, paneId, className) {
  for (const child of element.children || []) {
    if (hasClass(child, className || "workspace-pane") && child.dataset && child.dataset.paneId === paneId)
      return child;
    const found = findPaneElementById(child, paneId, className);
    if (found) return found;
  }
  return null;
}

let paneIdCounter = 0;

// Editor opens currently inside the pane funnel (openEditorTab /
// activateEditorTab). The rehydration pass in mountPaneTabContent reads
// it to stay out of an in-flight open's way: a fresh open owns its own
// fetch and mount, and firing rehydration mid-open would double-create
// the editor. After a reload the set is empty, so a persisted editor
// tab with no container rehydrates through the funnel exactly once.
const editorOpensInFlight = new Set();
// Every panel shares this id set: duplicates would break the DOM
// reconcile (two panes keyed by one id) and paneForPaneId lookups.
const usedPaneIds = new Set();

// Layout node ids (group split trees) share the counter pattern: one
// session, one namespace, persistence keeps minted ids stable across
// reloads.
let splitIdCounter = 0;
const usedSplitIds = new Set();

function newLeaf(paneId) {
  let id = paneId;
  if (!id) {
    do id = `p${++paneIdCounter}`;
    while (usedPaneIds.has(id));
  }
  usedPaneIds.add(id);
  return { kind: "pane", paneId: id, tabs: [TERMINAL_TAB_PLACEHOLDER], active: TERMINAL_TAB_PLACEHOLDER, groupId: null };
}

function newEmptyLeaf() {
  const leaf = newLeaf();
  leaf.tabs = [];
  leaf.active = null;
  return leaf;
}

// Panel leaves bind one workspace (collector model): wsId rides the
// leaf so tabs, focus, and the location bar all resolve through the
// panel instead of the global selection. Old blobs without wsId heal
// in normalizePanelEntry. null wsId means unbound (fresh session
// panel, no workspace opened yet).
function newPanelLeaf(wsId) {
  const leaf = newEmptyLeaf();
  leaf.wsId = wsId || null;
  return leaf;
}

function leafWsId(leaf) {
  return (leaf && leaf.wsId) || null;
}

// Which workspace a panel's content belongs to. Bound panels answer
// their wsId; a blob healed without rows (offline boot, stub tests)
// falls back to the first terminal tab row. This is the routing truth
// for focus, close, and sidebar resolution.
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

// Cheap identity of what panel.update carries (ws binding + tab list +
// active pointer), as one string. syncTerminalTabsIntoTree snapshots it
// per leaf at entry and pushes only leaves whose print moved.
function leafSyncFingerprint(leaf) {
  return `${leafWsId(leaf) || ""}|${(leaf.tabs || []).join(",")}|${leaf.active || ""}`;
}

function leavesBoundTo(entry, wsId) {
  if (!wsId) return [];
  return paneLeaves(entry).filter((leaf) => leafWorkspaceId(leaf) === wsId);
}

// The panel the location bar describes and commands act on. Focus
// writes entry.activePaneId; a missing pointer heals to the visible
// subject's panel (or the first panel).
function focusedLeaf(entry = paneRootFor()) {
  if (!paneTreeRenderable(entry)) return null;
  return activeLeaf(entry);
}

function isPaneLeaf(node) {
  return !!(node && node.kind === "pane" && Array.isArray(node.tabs));
}

function isPaneSplit(node) {
  return !!(node && (node.kind === "row" || node.kind === "column")
    && Array.isArray(node.children) && node.children.length >= 2);
}

// Every panel in the session, in list order. Consumers keep the
// paneLeaves(root) call shape; the "root" is the session entry.
function paneLeaves(entry) {
  if (!entry || !Array.isArray(entry.panels)) return [];
  return entry.panels.filter(isPaneLeaf);
}

// The panel that acts: the focus pointer's panel when it names a live
// panel, else the visible subject's panel, else the first. Standalone
// harnesses that hand a raw leaf resolve it directly.
function activeLeaf(entry) {
  const leaves = paneLeaves(entry);
  if (!leaves.length) {
    if (isPaneLeaf(entry)) return entry;
    return null;
  }
  const byId = entry.activePaneId && leaves.find((l) => l.paneId === entry.activePaneId);
  if (byId) return byId;
  const subject = visibleSubject(entry);
  if (subject && subject.kind === "panel") return subject.leaf;
  if (subject && subject.kind === "group") {
    const members = groupMembers(subject.group);
    if (members.length) return members.find((l) => l.paneId === entry.activePaneId) || members[0];
  }
  return leaves[0];
}

function paneForPaneId(entry, paneId) {
  return paneLeaves(entry).find((l) => l.paneId === paneId) || null;
}

// Which panel owns a tab id. Editor/git tabs can sit in any panel;
// terminal ids resolve to their owner panel (or null while only the
// placeholder exists and no backend panels have loaded yet).
function paneForTab(entry, tabId) {
  return paneLeaves(entry).find((l) => l.tabs.includes(tabId)) || null;
}

function focusLeaf(entry, leaf) {
  if (!leaf) return;
  entry.activePaneId = leaf.paneId;
  rememberGroupFocus(entry, leaf.paneId);
}

// Group focus memory: the record carries the last member this client
// focused so reopening the split restores that member, not just
// members[0]. activePaneId cannot serve here: every rail chip press
// overwrites it with the panel the user switched TO. pane_focus.js
// (pane activation clicks) calls this directly to share the memory.
function rememberGroupFocus(entry, paneId) {
  if (!entry || !paneId) return;
  const leaf = paneForPaneId(entry, paneId);
  if (!leaf || !leaf.groupId) return;
  const group = (entry.groups || []).find((g) => g.groupId === leaf.groupId);
  if (group) group.focusedPaneId = paneId;
}

// Repairs one panel leaf loaded from storage: missing paneId, missing
// groupId, wsId healing. Returns the leaf or null for garbage.
// Ids are opaque tokens that land in single-quoted inline handlers
// (onclick="...('PANE_ID')"): a hostile stored or adopted entry can
// poison them with quote/bracket characters. Strip everything outside
// [A-Za-z0-9_-]; a fully-stripped id falls back to a fresh mint so the
// leaf stays addressable.
function sanitizePaneIdToken(value) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || null;
}

function normalizePanelLeaf(leaf) {
  if (!isPaneLeaf(leaf)) return null;
  leaf.paneId = sanitizePaneIdToken(leaf.paneId);
  if (!leaf.paneId) {
    do leaf.paneId = `p${++paneIdCounter}`;
    while (usedPaneIds.has(leaf.paneId));
  }
  if (leaf.groupId != null) leaf.groupId = sanitizePaneIdToken(leaf.groupId);
  // Restored ids must REGISTER like minted ones: the counter starts at
  // 0 in a fresh bundle, so an unregistered p1 from storage lets the
  // next mint produce a SECOND p1. paneForPaneId/activeLeaf then resolve
  // whichever duplicate comes first, and focus, Enter minting, and the
  // DOM reconcile (panes keyed by id) all act on the wrong panel.
  // Duplicates in a corrupt blob keep the first: the second
  // registration is idempotent on a Set.
  usedPaneIds.add(leaf.paneId);
  if (!Array.isArray(leaf.tabs)) leaf.tabs = [];
  if (leaf.groupId === "") leaf.groupId = null;
  // wsId healing (collector migration): legacy blobs carry no wsId.
  // Bind from the first terminal row that resolves, so the sync's
  // home ladder and the ws sweep see a real binding. Panels with only
  // editor/git ids or empty panels stay null (adoption binds them
  // later). state.tabs may be empty at load (offline boot, stub
  // tests): leafWorkspaceId re-derives from rows each call, so a
  // later snapshot still heals via the sync's adoption pass.
  if (!leaf.wsId) {
    for (const tabId of leaf.tabs) {
      if (isEditorTab(tabId) || isGitTab(tabId)) continue;
      const row = paneTerminalTabById(tabId);
      const ws = row && row.workspace_id;
      if (ws) {
        leaf.wsId = ws;
        break;
      }
    }
  }
  return leaf;
}

// Repairs a group layout tree loaded from storage: sizes rebuilt to the
// children count, split ids re-registered, paneId children kept as
// strings, nested nodes recursed. Returns the node or null.
function normalizeLayoutNode(node) {
  // paneId strings are layout leaves: the string branch MUST precede
  // the object guard, or every stored leaf child drops out of the tree
  // on load and the layout collapses to a flat member array.
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return null;
  if (!Array.isArray(node.children)) return null;
  node.children = node.children.map(normalizeLayoutNode).filter(Boolean);
  if (node.children.length < 2) return node.children[0] || null;
  if (!Array.isArray(node.sizes)) node.sizes = [];
  if (node.splitId) usedSplitIds.add(node.splitId);
  node.sizes = node.children.map((_, i) => (Number.isFinite(node.sizes[i]) && node.sizes[i] > 0 ? node.sizes[i] : 1));
  return node;
}

// Repairs a group record: re-registered id, members deduped against the
// panel list, layout healed, memberIds pruned to live panels. A group
// under two members dissolves (its members ungroup).
function normalizeGroupRecord(group, entry) {
  if (!group || typeof group !== "object") return null;
  group.groupId = sanitizePaneIdToken(group.groupId);
  if (!group.groupId) return null;
  usedGroupIds.add(group.groupId);
  const live = new Set(entry.panels.map((p) => p.paneId));
  const seen = new Set();
  const memberIds = (Array.isArray(group.memberIds) ? group.memberIds : []).filter((id) => {
    if (!live.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (memberIds.length < 2) {
    for (const id of memberIds) {
      const leaf = entry.panels.find((p) => p.paneId === id);
      if (leaf) leaf.groupId = null;
    }
    return null;
  }
  group.memberIds = memberIds;
  if (group.name != null && typeof group.name !== "string") group.name = null;
  // Focus memory is part of the record now; a stale member pointer
  // (closed panel) heals to null so reopening falls back to the
  // first member instead of a dead id.
  group.focusedPaneId = memberIds.includes(group.focusedPaneId) ? group.focusedPaneId : null;
  group.layout = normalizeLayoutNode(group.layout);
  // A degraded layout rebuilds FLAT from all memberIds (never the
  // first two: a 3+ member group would lose members from the layout
  // and render misses them).
  if (!group.layout || typeof group.layout === "string") group.layout = memberIds.slice();
  // Every member must appear in the layout; a stale layout rebuilds
  // flat from memberIds (geometry is cheap, membership is not).
  const missing = memberIds.filter((id) => !layoutHoldsPaneId(group.layout, id));
  if (missing.length) group.layout = memberIds.slice();
  for (const id of memberIds) {
    const leaf = entry.panels.find((p) => p.paneId === id);
    if (leaf) leaf.groupId = group.groupId;
  }
  return group;
}

// Repairs the whole session entry: panels healed, groups healed and
// dissolved-away, visible pointer validated. Returns the entry or null.
function normalizePanelEntry(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.panels)) return null;
  entry.panels = entry.panels.map(normalizePanelLeaf).filter(Boolean);
  if (!entry.panels.length) return null;
  if (!Array.isArray(entry.groups)) entry.groups = [];
  entry.groups = entry.groups.map((g) => normalizeGroupRecord(g, entry)).filter(Boolean);
  // The visible pointer survives only when it names a live subject;
  // anything else heals to the first panel (all panels are subjects now).
  const subject = visibleSubject(entry);
  entry.visible = subject && subject.kind === "group"
    ? { type: "group", id: subject.group.groupId }
    : { type: "panel", id: subject.leaf.paneId };
  return entry;
}

function loadWorkspacePanesStates() {
  try {
    // The store holds ONE session entry. v2 (one-visible-view redo)
    // carries {v, panels, groups, visible}. Legacy blobs (tree roots,
    // groupCollapsed stamps, per-workspace entries) MIGRATE: every leaf
    // in the old tree becomes a flat ungrouped panel, in tree order; the
    // old split/group semantics do not map 1:1 to groups, so panels
    // survive and geometry resets.
    const raw = localStorage.getItem(WORKSPACE_PANES_STORAGE_KEY);
    if (!raw) {
      localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
      return;
    }
    const parsed = JSON.parse(raw);
    const entry = parsed && typeof parsed === "object" ? parsed[SESSION_PANES_KEY] || Object.values(parsed)[0] : null;
    if (entry && Array.isArray(entry.panels)) {
      const healed = normalizePanelEntry(entry);
      if (healed) {
        // D13 reset, collector refinement: an all-empty entry whose
        // panels carry NO workspace binding is a ghost (every id closed
        // in a previous session, nothing adopted since) and resets to
        // the single default panel. Empty panels with a live binding are
        // real panels the user left and restore as-is.
        const restorable = healed.panels.some((leaf) => (leaf.tabs && leaf.tabs.length) || leafWsId(leaf));
        state.workspacePanes[SESSION_PANES_KEY] = restorable ? healed : {
          v: 2,
          panels: [newLeaf("p1")],
          groups: [],
          visible: { type: "panel", id: "p1" },
          at: Date.now(),
        };
      }
    } else if (entry && entry.root) {
      // Legacy tree blob: flatten every leaf into panels. Old marks
      // (groupCollector, groupSlot, groupCollapsed stamps) drop: the
      // new model re-groups through the drag gesture.
      const flat = [];
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node.children)) { node.children.forEach(walk); return; }
        if (node.kind === "pane" && Array.isArray(node.tabs)) flat.push(node);
      };
      walk(entry.root);
      const panels = flat.map((leaf) => normalizePanelLeaf(leaf)).filter(Boolean);
      if (panels.length) {
        for (const leaf of panels) {
          delete leaf.groupCollector;
          delete leaf.groupSlot;
          delete leaf.autoCloseArmed;
          delete leaf.autoClosePre;
        }
        state.workspacePanes[SESSION_PANES_KEY] = {
          v: 2,
          panels,
          groups: [],
          visible: { type: "panel", id: panels[0].paneId },
          at: entry.at || Date.now(),
        };
      }
    }
    localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

function saveWorkspacePanesStates() {
  try {
    // The session entry persists whenever it exists, no open-workspace
    // gate: panels survive the last workspace closing (an empty entry
    // resets itself on load) and a dashboard boot (entry simply not
    // created yet). Runtime-only fields drop out of the BLOB (replacer
    // below), never off the live entry: the render-top sweep still
    // needs the marker to find its victim.
    const stripRuntime = (key, value) => (key === "autoCloseArmed" || key === "autoClosePre" ? undefined : value);
    const live = {};
    if (state.workspacePanes[SESSION_PANES_KEY])
      live[SESSION_PANES_KEY] = state.workspacePanes[SESSION_PANES_KEY];
    if (Object.keys(live).length) localStorage.setItem(WORKSPACE_PANES_STORAGE_KEY, JSON.stringify(live, stripRuntime));
    else localStorage.removeItem(WORKSPACE_PANES_STORAGE_KEY);
  } catch (_) {}
}

// ---- server sync (shared panes) -------------------------------------
// The webui server owns the panel/group entry for this herdr session
// (GET/POST /api/workspace-panes, POST /api/workspace-panes/op). This
// layer adopts server entries, sends intent ops at the mutation sites,
// and demotes localStorage to a migration seed. Two failure shapes keep
// the old behavior: an older server without the routes (network error or
// non-JSON body) pins panesMode "local" for the session, and a failed
// op under "server" falls back to the local mutation so a dropped
// gesture never blocks the user.
let panesMode = "local";

function panesServerReachable() {
  return typeof api === "function" && state && typeof state === "object";
}

// Entry adoption. normalizePanelEntry repairs the server's entry the
// same way it repairs a stored blob (server invariants run server-side,
// but the client re-registers ids through the normalize pass). Three
// per-client overlays survive the swap: the visible pointer (each
// client keeps its own subject when still live), the auto-close arm
// markers (runtime-only, never serialized to the server), and the
// editor/git tab ids (client-owned; the server stores whatever the last
// writer pushed, so each client merges its own back).
function adoptServerPanesEntry(incoming, opts) {
  if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.panels)) return false;
  const prev = state.workspacePanes[SESSION_PANES_KEY] || null;
  const prevVisible = prev && prev.visible && typeof prev.visible === "object" ? prev.visible : null;
  const prevFocus = prev && prev.activePaneId ? String(prev.activePaneId) : null;
  const runtimeMarks = new Map();
  const localFileTabs = new Map();
  if (prev && Array.isArray(prev.panels)) {
    for (const leaf of prev.panels) {
      if (!leaf || !leaf.paneId) continue;
      if (leaf.autoCloseArmed || leaf.autoClosePre)
        runtimeMarks.set(leaf.paneId, { armed: !!leaf.autoCloseArmed, pre: leaf.autoClosePre || null });
      const fileTabs = (leaf.tabs || []).filter((id) => isEditorTab(id) || isGitTab(id));
      if (fileTabs.length) localFileTabs.set(leaf.paneId, fileTabs);
    }
  }
  const healed = normalizePanelEntry(incoming);
  if (!healed) return false;
  state.workspacePanes[SESSION_PANES_KEY] = healed;
  for (const leaf of healed.panels) {
    const marks = runtimeMarks.get(leaf.paneId);
    if (marks) {
      if (marks.armed) leaf.autoCloseArmed = true;
      if (marks.pre) leaf.autoClosePre = marks.pre;
    }
    const mine = localFileTabs.get(leaf.paneId);
    if (mine) {
      for (const id of mine) if (!leaf.tabs.includes(id)) leaf.tabs.push(id);
    }
  }
  if (!opts || !opts.keepLocalVisible) return true;
  const vis = prevVisible;
  if (vis && vis.type === "panel" && healed.panels.some((p) => p.paneId === vis.id && !p.groupId)) {
    healed.visible = { type: "panel", id: vis.id };
  } else if (vis && vis.type === "group" && (healed.groups || []).some((g) => g.groupId === vis.id)) {
    healed.visible = { type: "group", id: vis.id };
  }
  // Focus is per-client (focus.set rides the shared entry but this
  // client never sends it): the server's copy is some other writer's,
  // so the local pointer is restored when its panel survived the swap.
  if (prevFocus && healed.panels.some((p) => p.paneId === prevFocus)) {
    healed.activePaneId = prevFocus;
  }
  return true;
}

// Send one intent op. Returns the adopted server entry on success,
// null on transport failure. Any structured 4xx is an authoritative
// rejection (the server refused the intent, e.g. "panel is not
// grouped" or a 422 business-rule refusal): no retry, no demotion,
// no local twin: the caller must resync to server truth instead.
// Transport failures and 5xx retry once, then drop the session to
// local mode so the local mutation stands and no later adoption
// resurrects stale server state.
const PANES_OP_REJECTED = Symbol("panes op rejected");

async function panesServerOpRaw(op) {
  const body = await api("/api/workspace-panes/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
  const entry = body && body.entry && typeof body.entry === "object" ? body.entry : body;
  if (!adoptServerPanesEntry(entry, { keepLocalVisible: true })) return null;
  return entry;
}

// 4xx resync: the server rejected the intent, so the client adopts the
// server's current entry. Best-effort; a failed GET leaves the local
// entry untouched (server mode stays, the next op or broadcast retries
// the resync). opts.skipRender defers the paint: the reject path can
// fire inside a teardown loop (panel.close with skipRender), and a
// mid-sweep render re-enters the sync ladder the loop exists to avoid.
async function panesServerResync(opts) {
  try {
    const body = await api("/api/workspace-panes");
    const entry = body && typeof body === "object" ? body.entry || body : null;
    if (adoptServerPanesEntry(entry, { keepLocalVisible: true })) {
      saveWorkspacePanesStates();
      if (!(opts && opts.skipRender)) renderWorkspacePanes();
      announcePaneChanges("Panel change rejected, re-synced from server");
      return true;
    }
  } catch (_) {}
  return false;
}

function isAuthoritativeRejection(ex) {
  // 400 validation, 404 missing target, 422 business rule: all three
  // are the server answering "no" to this intent. Only these; a 401
  // needs re-auth, 409+ and 5xx are not refusal shapes.
  return !!ex && typeof ex === "object" && ex.status >= 400 && ex.status < 500 && ex.status !== 401;
}

async function panesServerOp(op, opts) {
  if (panesMode !== "server" || !panesServerReachable()) return null;
  try {
    const entry = await panesServerOpRaw(op);
    if (entry) {
      saveWorkspacePanesStates();
      renderWorkspacePanes();
      return entry;
    }
    return null;
  } catch (ex) {
    // Authoritative rejection: the server owns the truth, retrying the
    // same intent cannot help and demoting to local mode would fork the
    // session. Resync to the server entry; the rejected symbol tells the
    // fallback helper NOT to run the local twin over the resynced state.
    if (isAuthoritativeRejection(ex)) {
      await panesServerResync(opts);
      return PANES_OP_REJECTED;
    }
    // Retry once, then the session falls back to local mode.
    try {
      const entry = await panesServerOpRaw(op);
      if (entry) {
        saveWorkspacePanesStates();
        renderWorkspacePanes();
        return entry;
      }
    } catch (ex2) {
      if (isAuthoritativeRejection(ex2)) {
        await panesServerResync(opts);
        return PANES_OP_REJECTED;
      }
    }
    // Both tries failed on transport/5xx. Demote on the SERVER's last
    // known entry, not on the possibly-stale local one: the first POST
    // may have landed after all (a lost response), and running the
    // local twin over that state would fork the session. A successful
    // resync proves the server is reachable again, so the session stays
    // in server mode with the fresh entry; a failed resync confirms the
    // outage and the demotion is safe.
    if (await panesServerResync({ skipRender: !!(opts && opts.skipRender) })) {
      return PANES_OP_REJECTED;
    }
    panesMode = "local";
    return null;
  }
}

// One dispatch shape for the mutating sites. localMutation owns the
// local twin: local mode runs it plus the uniform save+render, and a
// failed server op (null: retry exhausted, or the session dropped to
// local mode) runs it plus the same save+render so the gesture never
// lands dead. A REJECTED result means the server refused the intent
// and the client resynced: the local twin must NOT run (it would
// recreate the refused mutation over server truth). Pass null when the
// caller already applied the change optimistically and settled it
// (rename, subject switch): the helper then only fires the op and
// save+renders on failure. Non-async on purpose: the local branch
// returns the twin's value synchronously, only the server branch
// returns a promise. opts.skipRender is for the teardown loops (prune
// sweep, ws sweep): a render inside the loop re-enters the sync ladder
// mid-sweep and re-homes ids into freshly minted leaves, so those
// callers save here and render once at their own settle.
function panesOpWithFallback(opPayload, localMutation, opts) {
  const settle = () => {
    // preLocal runs inside the twin (and only there): the server-success
    // path must not run it, the op response owns the post-op state.
    if (opts && typeof opts.preLocal === "function") opts.preLocal();
    const out = localMutation ? localMutation() : undefined;
    saveWorkspacePanesStates();
    if (!(opts && opts.skipRender)) renderWorkspacePanes();
    return out;
  };
  if (panesMode !== "server" || !panesServerReachable()) {
    return localMutation ? settle() : undefined;
  }
  // Rejection vs local-twin false: a refused intent must not be
  // mistaken for the twin's own "nothing changed" answer, so callers
  // needing the distinction compare against PANES_OP_REJECTED.
  return panesServerOp(opPayload, opts).then((entry) => {
    if (entry === PANES_OP_REJECTED) return PANES_OP_REJECTED;
    return entry || settle();
  });
}

// Boot adoption. GET the server entry; on success switch to server
// mode. On 404 (older server or a first boot) POST the local entry once
// as the seed: the seed-never-overwrites rule on the server keeps a
// second client from clobbering real content. Any other failure keeps
// local mode, where localStorage stays the truth as before.
async function bootWorkspacePanesFromServer() {
  // The mode is per-backend: a stale "server" value from the previous
  // session would keep ops targeting the wrong store until a failed op
  // demoted it, so reset before the fetch decides.
  panesMode = "local";
  if (!panesServerReachable()) return;
  try {
    const body = await api("/api/workspace-panes");
    const entry = body && typeof body === "object" ? body.entry || body : null;
    if (adoptServerPanesEntry(entry, { keepLocalVisible: true })) {
      panesMode = "server";
      saveWorkspacePanesStates();
      renderWorkspacePanes();
      return;
    }
    // No server entry yet: seed it with the local one (migration POST).
    await api("/api/workspace-panes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: paneRootFor() }),
    });
    panesMode = "server";
  } catch (_) {
    // Older server or transport failure: local mode stays.
  }
}

// Broadcast adoption (workspace_panes_changed). Idempotent against the
// settled entry: the sender's own op response already adopted the same
// snapshot, and a frame that matches the live entry skips the render.
function applyRemoteWorkspacePanesEntry(incoming) {
  if (panesMode !== "server") return false;
  const live = paneRootFor();
  if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.panels)) return false;
  if (live && Array.isArray(live.panels) && entrySignaturesMatch(live, incoming)) return false;
  const beforePanels = live && Array.isArray(live.panels) ? live.panels.length : 0;
  // Group delta reads the PRE-ADOPT local entry: adoption keeps every
  // server group now (persistence), so local-before vs local-after
  // measures exactly what the frame changed and never counts a
  // normalize repair (dead member sweep) as a server removal.
  const beforeGroups = live && Array.isArray(live.groups) ? live.groups.length : 0;
  const adopted = adoptServerPanesEntry(incoming, { keepLocalVisible: true });
  if (adopted) {
    saveWorkspacePanesStates();
    renderWorkspacePanes();
    // Polite announcement for remote panel/group changes (rename text
    // changes ride the chip repaint; add/remove is the structural news).
    const after = paneRootFor();
    const dPanels = after.panels.length - beforePanels;
    const dGroups = (after.groups || []).length - beforeGroups;
    const parts = [];
    if (dPanels > 0) parts.push(`${dPanels} panel${dPanels > 1 ? "s" : ""} added`);
    if (dPanels < 0) parts.push(`${-dPanels} panel${-dPanels > 1 ? "s" : ""} removed`);
    if (dGroups > 0) parts.push(`${dGroups} group${dGroups > 1 ? "s" : ""} added`);
    if (dGroups < 0) parts.push(`${-dGroups} group${-dGroups > 1 ? "s" : ""} removed`);
    if (parts.length) announcePaneChanges(`Panels updated: ${parts.join(", ")}`);
    else announcePaneChanges("Panels updated from another session");
  }
  return adopted;
}

// Signature compare for the broadcast guard: membership, groups, and the
// tab arrays. Runtime marks and the visible pointer are per-client and
// excluded on purpose (they never ride the server entry).
function entrySignaturesMatch(a, b) {
  const sig = (entry) => JSON.stringify({
    panels: (entry.panels || []).map((p) => [p.paneId, p.tabs || [], p.active || null, p.groupId || null, p.wsId || null, p.name || null]),
    groups: (entry.groups || []).map((g) => [g.groupId, g.memberIds || [], g.name || null, g.layout || null, g.focusedPaneId || null]),
  });
  return sig(a) === sig(b);
}

// A closed workspace never deletes the session entry: its ids leave
// through pruneWorkspaceTabsFromPanes, and the entry survives to host
// the remaining workspaces' panels. Legacy per-workspace entries from
// older sessions are dropped here.
function forgetWorkspacePanes(id) {
  for (const key of Object.keys(state.workspacePanes || {})) {
    if (key !== SESSION_PANES_KEY) delete state.workspacePanes[key];
  }
  saveWorkspacePanesStates();
}

// Eager teardown for a closing workspace (D10): its bound panels leave
// the list NOW, not on the next refresh tick. Between close and tick
// the strips would render dead ids with close buttons that POST against
// vanished panels. Editor/git ids ride the dropped panel (client-owned,
// no re-home target once the ws is gone). All-panels guard: the last
// panel keeps its slot emptied, ready for adoption by the next
// workspace; anything else drops through the group-aware removal.
function pruneWorkspaceTabsFromPanes(workspaceId) {
  if (!workspaceId) return false;
  let changed = false;
  for (const key of Object.keys(state.workspacePanes || {})) {
    const entry = state.workspacePanes[key];
    if (!entry || !Array.isArray(entry.panels)) continue;
    const doomed = paneLeaves(entry).filter((leaf) => leafWorkspaceId(leaf) === workspaceId);
    if (!doomed.length) continue;
    if (entry.panels.length === doomed.length) {
      // Every panel belonged to the closing ws: keep the list but empty
      // it, so one panel stays ready for adoption. The sweep collapses
      // the armed empties down to that one survivor.
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
      if (dropLeafFromTree(leaf, { skipRender: true })) changed = true;
    }
  }
  if (changed) saveWorkspacePanesStates();
  return changed;
}

loadWorkspacePanesStates();

// The session entry itself. Consumers that used to walk a tree root
// keep the paneRootFor()/paneRoot() call shape.
function paneRoot() {
  return panesStateFor();
}

// An entry renders when it holds at least one panel.
function paneTreeRenderable(entry) {
  return paneLeaves(entry).length > 0;
}

// Leaf-level accessors default to the acting panel. paneTabs/paneActiveTab
// keep their 3b/3c signatures: existing callers ask about the strip they
// are looking at.
function paneTabs(entry = paneRoot()) {
  const leaf = isPaneLeaf(entry) ? entry : activeLeaf(entry);
  return leaf ? leaf.tabs : [];
}

function paneActiveTab(entry = paneRoot()) {
  const leaf = isPaneLeaf(entry) ? entry : activeLeaf(entry);
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
// The cascade only considers leaves that actually render this pass
// (the visible subject's members); hidden panels must never own the
// shell, or the visible pane parks it and shows a blank slot.
function renderedLeavesForSubject(subject) {
  if (!subject) return [];
  if (subject.kind === "group") return groupMembers(subject.group);
  return [subject.leaf];
}

function terminalShellOwnerLeaf(root) {
  const rendered = renderedLeavesForSubject(visibleSubject(root));
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
  // Server mode: the server mints. The op response adopts the new panel
  // and the next sync pass homes the id into it (one-tick delay beats a
  // client-only panel the next adoption would drop).
  if (panesMode === "server") {
    void panesServerOp({ op: "panel.create", wsId: wsId || undefined });
    return null;
  }
  return mintPanelForWorkspace(wsId, focused || leaves[0]);
}

// Structural mint: the fresh panel appends to the flat list. Returns
// the minted leaf; the caller lands the ids and the route sync moves
// focus when the route points here. The anchor argument stays for the
// call shape (focus keeps meaning), geometry no longer applies.
function mintPanelForWorkspace(wsId, anchor) {
  const fresh = newPanelLeaf(wsId);
  const entry = panesStateFor();
  entry.panels.push(fresh);
  if (anchor) fresh.wsId = wsId || leafWsId(anchor) || null;
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
  // Server-mode chatter guard: fingerprints the leaves the sync STARTED
  // with, so the panel.update push below fires only for leaves this pass
  // actually rewrote. Without it every pusher (route change, prune, heal)
  // pays one POST per leaf in the tree.
  const syncEntryFingerprint = new Map(
    paneLeaves(paneRootFor()).map((leaf) => [leaf.paneId, leafSyncFingerprint(leaf)])
  );
  for (const id of allBackendIds) {
    // paneRootFor() per iteration: the mint can append a panel mid-pass
    // (the entry object stays), but re-reading keeps the lookup honest
    // against any future entry swap.
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
    if (!home.tabs.includes(id) && leafBusyViews(home)) {
      // One view per flat panel: the id splits the busy home instead
      // of stacking a second view. Deferred (see queueHomingSplit): the
      // id stays homeless this pass, the task lands it.
      queueHomingSplit(home.paneId, wsId, id);
      continue;
    }
    if (!home.tabs.includes(id)) {
      home.tabs.push(id);
      // v3.2: an adopted id refills the panel; an armed auto-close from
      // an earlier emptying gesture must not fire on the refill.
      disarmLeafAutoClose(home);
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
      if (dropLeafFromTree(deadLeaf, { skipRender: true })) changed = true;
    }
  }
  // Tail passes re-read the entry: the placement loop above may have
  // minted a panel mid-pass, and the ws sweep may have dropped panels.
  // Every read below names the live entry.
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
          // Server mode: the server mints (same rule as the home ladder);
          // adoption lands the panel and the next pass focuses it.
          if (panesMode === "server") {
            void panesServerOp({ op: "panel.create", wsId: state.ws || undefined });
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
  if (changed) {
    saveWorkspacePanesStates();
    // Server mode: push the tabs deltas so the server entry holds the
    // authoritative arrays (terminal ids are backend truth; editor/git
    // ids ride as opaque strings). One panel.update per leaf,
    // fire-and-forget: the next sync pass re-derives the same state if a
    // push is lost.
    if (panesMode === "server") {
      for (const leaf of paneLeaves(paneRootFor())) {
        // New leaves (absent from the entry map) always push: the server
        // has to learn them once. Touched leaves push their delta;
        // untouched ones stay quiet.
        const entryPrint = syncEntryFingerprint.get(leaf.paneId);
        if (entryPrint && entryPrint === leafSyncFingerprint(leaf)) continue;
        void panesServerOp({
          op: "panel.update",
          paneId: leaf.paneId,
          tabs: (leaf.tabs || []).slice(),
          active: leaf.active || undefined,
          wsId: leafWorkspaceId(leaf) || undefined,
        });
      }
    }
  }
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

// Builds the Phase 3 leaf shell (.workspace-pane > .pane-tab-strip +
// .pane-content) shared by every render path that materializes a missing
// pane node.
function createPaneElement(paneId) {
  const pane = document.createElement("div");
  pane.className = "workspace-pane";
  pane.dataset.paneId = paneId;
  pane.id = `pane-${paneId}`;
  const strip = document.createElement("div");
  strip.className = "pane-tab-strip";
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Pane tabs");
  // The strip drags as a split member (bare-chrome drags arm the
  // re-position payload; children with their own drag wiring refuse
  // the walk first in paneStripMemberDragStart).
  strip.setAttribute("draggable", "true");
  strip.setAttribute("ondragstart", "paneStripMemberDragStart(event)");
  strip.setAttribute("ondragend", "paneMemberDragEnd()");
  pane.appendChild(strip);
  const content = document.createElement("div");
  content.className = "pane-content";
  pane.appendChild(content);
  return pane;
}

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

function reconcileSplitNode(container, node, idPath, resolveLeaf) {
  // Group layout children are paneId strings; resolveLeaf maps them to
  // the live panel leaves (paneLeaves walks, never stored refs). Nested
  // split nodes pass the resolver down unchanged.
  const leafOf = (child) => {
    if (isPaneSplit(child)) return null;
    if (typeof child === "string") return resolveLeaf ? resolveLeaf(child) : null;
    return child;
  };
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
    // The rail's group chip points aria-controls at this wrapper
    // (pane-layout-<splitId path>, slashes flattened), so every split
    // wrapper mints that id: the root wrapper is the chip's target
    // while the group is the visible subject, and nested wrappers just
    // carry unique ids.
    element.id = `pane-layout-${String(idPath).replace(/\//g, "-")}`;
    container.appendChild(element);
  }
  const wanted = node.kind === "row" ? "pane-row" : "pane-column";
  if (element.className.split(/\s+/).indexOf(wanted) < 0) element.className = wanted;
  // Sizes are flex-grow numbers written straight onto the children; the
  // divider drag updates them live and reads them back on pointerup.
  // Child split ids extend the parent path so two same-index splits in
  // different parents never collide.
  const childIds = node.children.map((child, i) =>
    isPaneSplit(child) ? `${idPath}/${splitNodeId(child)}` : ((leafOf(child) && leafOf(child).paneId) || `p?${i}`));
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
        const leaf = leafOf(child);
        if (!leaf) return;
        mount = document.createElement("div");
        mount.className = "workspace-pane";
        mount.dataset.paneId = leaf.paneId;
        mount.id = `pane-${leaf.paneId}`;
        const strip = document.createElement("div");
        strip.className = "pane-tab-strip";
        strip.setAttribute("role", "tablist");
        strip.setAttribute("aria-label", "Pane tabs");
        // Same strip-member drag attrs as createPaneElement: split
        // members materialize through this factory inside group
        // layouts.
        strip.setAttribute("draggable", "true");
        strip.setAttribute("ondragstart", "paneStripMemberDragStart(event)");
        strip.setAttribute("ondragend", "paneMemberDragEnd()");
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
      reconcileSplitNode(mount, child, childId, resolveLeaf);
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

// Strip-wide member dragstart: inside the visible split the whole
// member strip arms the re-position drag, not just the merged header
// button. The listener rides #workspacePanes (one wiring pass), so the
// STRIP is resolved from the event target chain, never currentTarget.
// Children that own their own drag refuse the walk first: pane tabs
// drag to reorder and the merged header button arms the same member
// payload itself. The same visible-group gate as the header keeps
// flats and parked groups inert.
function paneStripMemberDragStart(event) {
  const drag = activeDragKind();
  if (drag) return;
  let strip = event && event.target;
  while (strip && !hasClass(strip, "pane-tab-strip")) {
    // Pane tabs and the merged header button own their own drags.
    if (hasClass(strip, "pane-tab") || hasClass(strip, "pane-member-header")) return;
    // The rename input replaces the header inside the strip; a text
    // selection drag from it must never arm the member payload.
    if (strip.tagName === "INPUT") return;
    strip = strip.parentElement;
  }
  if (!strip) return;
  const pane = strip.parentElement;
  const paneId = pane && pane.dataset ? pane.dataset.paneId : null;
  if (!paneId) return;
  paneMemberDragStart(event, paneId);
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
  container.addEventListener("dragstart", paneStripMemberDragStart);
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
    }
  });
}

// ---- label rail (one-visible-view model) ------------------------------
// The rail sits at the top of #workspacePanes: one chip per ungrouped
// panel (press switches the visible subject, drag enters the split
// preview) plus one chip per group ("Group N views", press shows the
// group, double-click renames). Grouped panels fold behind their
// group's chip while the group is not the visible subject.
function railEntryLabelForPanel(leaf) {
  // A set name wins (panel rename); everything else derives from the
  // active tab or the bound workspace as before.
  if (leaf && leaf.name) return String(leaf.name);
  const activeTab = paneActiveTabOf(leaf);
  if (activeTab && !isEditorTab(activeTab) && !isGitTab(activeTab)) {
    const row = paneTerminalTabById(activeTab);
    const visible = row && panelVisibleLabel(row, row.number || 1);
    if (visible) return visible;
  }
  const wsId = leafWorkspaceId(leaf);
  const workspace = wsId ? (state.workspaces || []).find((w) => w.workspace_id === wsId) : null;
  return workspace
    ? ((typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) || workspace.label || wsId)
    : (wsId || "panel");
}

function paneActiveTabOf(leaf) {
  return leaf && leaf.active && (leaf.tabs || []).includes(leaf.active) ? leaf.active : (leaf.tabs || [])[0] || null;
}

function railPanelChipHtml(leaf, isActive) {
  const label = railEntryLabelForPanel(leaf);
  const encoded = encodeURIComponent(leaf.paneId);
  const title = `Show panel ${label}`;
  if (state.editingPanelPaneId === leaf.paneId) {
    return `<input class="pane-group-rename-input" aria-label="Rename panel" value="${escapeAttr(state.editingPanelValue || "")}"${typeof inputAttrs === "function" ? inputAttrs("done") : ""} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitPanelChipRename('${escapeHandlerArg(encoded)}')" oninput="state.editingPanelValue=this.value" onkeydown="panelChipRenameKey(event,'${escapeHandlerArg(encoded)}')">`;
  }
  // Every rail chip is an ungrouped panel (grouped members carry no
  // chip), so every chip drags: the label drag starts a split.
  return `<button class="pane-label-chip${isActive ? " active" : ""}" role="tab" id="pane-rail-tab-${escapeAttr(leaf.paneId)}" aria-selected="${isActive ? "true" : "false"}" aria-controls="pane-${escapeAttr(leaf.paneId)}" tabindex="${isActive ? "0" : "-1"}" draggable="true" data-pane-id="${escapeAttr(leaf.paneId)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)} (double-click or press F2 to rename)" onclick="event.preventDefault();showPanelFromRail('${escapeHandlerArg(encoded)}')" ondblclick="startPanelChipRename('${escapeHandlerArg(encoded)}')" onkeydown="railChipKeyDown(event,'panel','${escapeHandlerArg(encoded)}')" ondragstart="paneLabelDragStart(event,'${escapeHandlerArg(encoded)}')" ondragend="paneLabelDragEnd()"><span class="pane-label-chip-text">${escapeHtml(label)}</span></button>`;
}

function railGroupChipHtml(group, isActive) {
  const name = groupVisibleName(group);
  const title = `${name} (double-click or press F2 to rename)`;
  const encoded = encodeURIComponent(group.groupId);
  if (state.editingPaneGroup === group.groupId) {
    return `<input class="pane-group-rename-input" aria-label="Rename panel group" value="${escapeAttr(state.editingPaneGroupValue || "")}"${typeof inputAttrs === "function" ? inputAttrs("done") : ""} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitPaneGroupRename('${escapeHandlerArg(encoded)}')" oninput="state.editingPaneGroupValue=this.value" onkeydown="paneGroupRenameKey(event,'${escapeHandlerArg(encoded)}')">`;
  }
  // The group's split wrapper id matches the one reconcileSplitNode
  // stamps (pane-layout-<splitId path>); a degraded flat layout has no
  // wrapper yet, so the container stands in until the next render mints
  // the split.
  const layoutControls = group.layout && isPaneSplit(group.layout)
    ? `pane-layout-${String(splitNodeId(group.layout)).replace(/\//g, "-")}`
    : "workspacePanes";
  return `<button class="pane-label-chip pane-panel-group-chip${isActive ? " active" : ""}" role="tab" id="pane-rail-tab-${escapeAttr(group.groupId)}" aria-selected="${isActive ? "true" : "false"}" aria-controls="${escapeAttr(layoutControls)}" tabindex="${isActive ? "0" : "-1"}" draggable="false" data-group-id="${escapeAttr(group.groupId)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" onclick="event.preventDefault();showGroupFromRail('${escapeHandlerArg(encoded)}')" ondblclick="startPaneGroupRename('${escapeHandlerArg(encoded)}')" onkeydown="railChipKeyDown(event,'group','${escapeHandlerArg(encoded)}')">${escapeHtml(name)}</button>`;
}

// Group rename (rail chip double-click): the name rides the group
// record and persists through saveWorkspacePanesStates. The groupId
// keys the edit session, so a dissolve mid-edit ends it naturally.
function startPaneGroupRename(encodedGroupId) {
  const groupId = decodeURIComponent(String(encodedGroupId || ""));
  const group = groupById(paneRootFor(), groupId);
  if (!group) return;
  state.editingPaneGroup = groupId;
  state.editingPaneGroupValue = group.name || "";
  renderWorkspacePanes();
  setTimeout(() => {
    if (state.editingPaneGroup !== groupId) return;
    const input = document.querySelector(".pane-group-rename-input");
    // select() alone is a text-range call, not a focus grant: in some
    // focus contexts the input stays unfocused with the range set.
    if (input && input.focus) input.focus();
    if (input && input.select) input.select();
  }, 0);
}

function paneGroupRenameKey(e, encodedGroupId) {
  if (e.key === "Enter") {
    if (e.preventDefault) e.preventDefault();
    commitPaneGroupRename(encodedGroupId);
  } else if (e.key === "Escape") {
    state.editingPaneGroup = null;
    state.editingPaneGroupValue = "";
    renderWorkspacePanes();
    focusRailChipAfterRename("group", decodeURIComponentSafe(encodedGroupId));
  }
}

function commitPaneGroupRename(encodedGroupId) {
  const groupId = decodeURIComponent(String(encodedGroupId || ""));
  const group = groupById(paneRootFor(), groupId);
  const editingId = state.editingPaneGroup;
  // Capture the draft BEFORE the editing state resets: the reads below
  // would see "" and every commit would land as an empty rename.
  const draft = String(state.editingPaneGroupValue || "").trim();
  state.editingPaneGroup = null;
  state.editingPaneGroupValue = "";
  if (!group || editingId !== groupId) {
    renderWorkspacePanes();
    focusRailChipAfterRename("group", groupId);
    return;
  }
  // Empty reverts to the default "Group N views" (a stale custom name
  // must not outlive the panels it counted).
  if (draft) group.name = draft;
  else group.name = null;
  if (panesMode === "server") {
    panesOpWithFallback({ op: "group.rename", groupId, name: draft || null }, null);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  focusRailChipAfterRename("group", groupId);
  announcePaneChanges(draft ? `Group renamed to ${draft}` : "Group name cleared");
}

// Panel rename (rail chip double-click, same edit contract as the
// group chips): the name rides the panel record. The op response
// repaints every client of the session.
function startPanelChipRename(encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const leaf = paneId ? paneForPaneId(paneRootFor(), paneId) : null;
  if (!leaf) return;
  state.editingPanelPaneId = paneId;
  state.editingPanelValue = leaf.name || "";
  renderWorkspacePanes();
  setTimeout(() => {
    if (state.editingPanelPaneId !== paneId) return;
    const input = document.querySelector(".pane-group-rename-input");
    // Same as the group rename: focus explicitly, then select.
    if (input && input.focus) input.focus();
    if (input && input.select) input.select();
  }, 0);
}

function panelChipRenameKey(e, encodedPaneId) {
  if (e.key === "Enter") {
    if (e.preventDefault) e.preventDefault();
    commitPanelChipRename(encodedPaneId);
  } else if (e.key === "Escape") {
    // Escape is the way back while editing: drop the draft, keep the
    // committed name untouched, land focus on the chip the edit came
    // from. Blur would commit, so the cancel must repaint first.
    if (e.preventDefault) e.preventDefault();
    state.editingPanelPaneId = null;
    state.editingPanelValue = "";
    renderWorkspacePanes();
    focusRailChipAfterRename("panel", decodeURIComponentSafe(encodedPaneId));
  }
}

function commitPanelChipRename(encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const leaf = paneId ? paneForPaneId(paneRootFor(), paneId) : null;
  const editingId = state.editingPanelPaneId;
  // Same draft-before-reset rule as the group rename: the reads below
  // must not see the cleared editing value.
  const draft = String(state.editingPanelValue || "").trim();
  state.editingPanelPaneId = null;
  state.editingPanelValue = "";
  if (!leaf || editingId !== paneId) {
    renderWorkspacePanes();
    focusRailChipAfterRename("panel", paneId);
    return;
  }
  // Empty reverts to the derived label (active tab, workspace name).
  leaf.name = draft || null;
  if (panesMode === "server") {
    panesOpWithFallback({ op: "panel.rename", paneId, name: draft || null }, null);
  }
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  focusRailChipAfterRename("panel", paneId);
  announcePaneChanges(draft ? `Panel renamed to ${draft}` : "Panel name cleared");
}

// Keyboard rename entry (F2 always; Enter when the chip is already the
// visible subject) plus arrow/Home/End roving navigation on the rail.
// Enter on a non-visible chip falls through to the native button
// click, which activates the subject (the tab pattern's activation
// key); a second Enter on the now-selected chip opens the rename.
function railChipKeyDown(e, kind, encodedId) {
  if (!e) return;
  if (e.key === "F2" || (e.key === "Enter" && e.currentTarget
      && e.currentTarget.getAttribute && e.currentTarget.getAttribute("aria-selected") === "true")) {
    if (e.preventDefault) e.preventDefault();
    if (kind === "group") startPaneGroupRename(encodedId);
    else startPanelChipRename(encodedId);
    return;
  }
  const nav = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (nav) {
    if (e.preventDefault) e.preventDefault();
    moveRailChipFocus(nav);
    return;
  }
  if (e.key === "Home" || e.key === "End") {
    if (e.preventDefault) e.preventDefault();
    moveRailChipFocus(e.key === "Home" ? -Infinity : Infinity);
  }
}

// Arrow/Home/End roving on the rail: all chips are one tablist, the
// tabindex-0 chip (the visible subject) is the only tab stop, and the
// arrows move both focus and the roving tabindex.
function moveRailChipFocus(delta) {
  const container = el("workspacePanes");
  if (!container) return;
  const rail = [...(container.children || [])].find((child) => hasClass(child, "pane-label-rail"));
  if (!rail) return;
  const chips = [...(rail.children || [])].filter((child) => hasClass(child, "pane-label-chip"));
  if (!chips.length) return;
  const current = chips.indexOf(document.activeElement);
  const next = delta === -Infinity ? 0 : delta === Infinity ? chips.length - 1
    : Math.max(0, Math.min(chips.length - 1, (current < 0 ? 0 : current) + delta));
  for (const chip of chips) {
    if (chip.tabIndex !== undefined) chip.tabIndex = -1;
  }
  const target = chips[next];
  if (target.tabIndex !== undefined) target.tabIndex = 0;
  if (target && typeof target.focus === "function") target.focus();
}

// Focus restore after a rename commit/cancel: the rail re-rendered, so
// the chip is re-resolved by paneId/groupId and focused again. A grouped
// member has no rail chip at all; its merged header button is the focus
// target. Falls back to the visible subject's chip when the edited
// subject vanished.
function focusRailChipAfterRename(kind, id) {
  setTimeout(() => {
    let target = findRailChipElement(kind, id);
    if (!target && kind === "panel" && typeof document !== "undefined") {
      target = findPaneElementById(el("workspacePanes") || document.body, id, "pane-member-header");
    }
    if (target && typeof target.focus === "function") target.focus();
  }, 0);
}

function findRailChipElement(kind, id) {
  const container = el("workspacePanes");
  if (!container || !id) return null;
  const rail = [...(container.children || [])].find((child) => hasClass(child, "pane-label-rail"));
  if (!rail) return null;
  return [...(rail.children || [])].find((child) =>
    child.dataset && ((kind === "group" && child.dataset.groupId === id)
      || (kind !== "group" && child.dataset.paneId === id))) || null;
}

// aria-live polite announcements: remote adoption changes and rename
// text changes. The live region is a singleton span inside the rail's
// parent container (never re-created by a rail innerHTML rebuild).
// announcePaneChanges is safe in stub DOMs: a missing container is a
// no-op.
function announcePaneChanges(text) {
  const value = String(text || "");
  if (!value) return;
  const container = el("workspacePanes");
  if (!container) return;
  let live = document.getElementById("paneA11yLive");
  if (!live) {
    if (typeof document.createElement !== "function") return;
    live = document.createElement("span");
    live.id = "paneA11yLive";
    live.className = "pane-a11y-live";
    live.setAttribute("aria-live", "polite");
    if (live.setAttribute) live.setAttribute("role", "status");
    if (typeof live.textContent === "string") live.textContent = "";
    container.appendChild(live);
  }
  // Two-tick write: clearing then setting makes repeated identical
  // announcements fire again (screen readers announce the mutation).
  setTimeout(() => {
    if (typeof live.textContent === "string") live.textContent = "";
    setTimeout(() => {
      if (typeof live.textContent === "string") live.textContent = value;
    }, 0);
  }, 0);
}

// The rail lists every UNGROUPED panel chip plus one chip per group
// record: a grouped member's identity lives in its merged header, so
// its rail chip returns only on ungroup exit or group dissolve.
// Groups persist, so a hidden group keeps its chip and clicking it
// reopens the split. The rail paints when more than one choice exists;
// a single-panel session with no groups renders nothing (the strip
// carries the identity already).
function renderLabelRail(container, entry, subject) {
  let rail = [...(container.children || [])].find((child) => hasClass(child, "pane-label-rail")) || null;
  // Every LIVE ungrouped leaf gets a chip: the sweep folds abandoned
  // empties and closeActivePane drops closed panels, so what sits in
  // the tree is reachable by right. A view-less leaf (fresh mint,
  // armed empty) is still a subject the user must be able to switch
  // back to; filtering it would orphan it behind a rail that refuses
  // to render.
  const chipPanels = paneLeaves(entry).filter((leaf) => !leaf.groupId);
  const panels = chipPanels;
  const groups = (entry.groups || []).filter((g) => groupMemberCount(g, entry) >= 2);
  // A lone group still paints the rail: it is the drag-out exit
  // target (a member dragged onto it ungroups), and hiding it would
  // strand the gesture with no release target.
  const needRail = panels.length + groups.length > 1 || groups.length > 0;
  if (!needRail) {
    if (rail) detachDomNode(rail);
    return;
  }
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "pane-label-rail";
    rail.setAttribute("role", "tablist");
    rail.setAttribute("aria-label", "Panels and groups");
    // The rail sits ABOVE the subject: the container is a column flex,
    // so the rail must precede the layout nodes in DOM order.
    const firstPane = [...(container.children || [])].find((child) =>
      hasClass(child, "workspace-pane") || hasClass(child, "pane-row") || hasClass(child, "pane-column"));
    if (firstPane && container.insertBefore) container.insertBefore(rail, firstPane);
    else container.appendChild(rail);
    wireRailMemberDrop(rail);
  }
  let html = "";
  for (const leaf of panels) {
    const active = subject && subject.kind === "panel" && subject.leaf === leaf;
    html += railPanelChipHtml(leaf, active);
  }
  for (const group of groups) {
    html += railGroupChipHtml(group, subject.kind === "group" && subject.group === group);
  }
  // The open rename input must survive repaints (an innerHTML swap
  // kills focus mid-keystroke), but the rail cannot freeze: a remote
  // adoption that changes sibling chips mid-edit still needs the fresh
  // build. So rebuild the rail, then swap the LIVE input back in place of
  // the fresh copy, restoring focus and selection. The guard tracks RAIL
  // edits only: a grouped member's rename input lives in its merged
  // header (no rail chip), so a header edit must not be read as a
  // rail/input disagreement and rebuild the rail on every pass.
  const editingPanelLeaf = state.editingPanelPaneId ? paneForPaneId(entry, state.editingPanelPaneId) : null;
  const editingState = !!((editingPanelLeaf && !editingPanelLeaf.groupId) || state.editingPaneGroup);
  const railShowsInput = [...(rail.children || [])].some((child) =>
    hasClass(child, "pane-group-rename-input"));
  if (railShowsInput === editingState && editingState && rail.__herdrRailSignature !== html) {
    const input = [...(rail.children || [])].find((child) => hasClass(child, "pane-group-rename-input")) || null;
    const selStart = input && typeof input.selectionStart === "number" ? input.selectionStart : null;
    const selEnd = input && typeof input.selectionEnd === "number" ? input.selectionEnd : null;
    rail.__herdrRailSignature = html;
    rail.innerHTML = html;
    const fresh = [...(rail.children || [])].find((child) => hasClass(child, "pane-group-rename-input")) || null;
    if (input && fresh && fresh.parentNode && typeof fresh.parentNode.replaceChild === "function") {
      fresh.parentNode.replaceChild(input, fresh);
      if (typeof input.focus === "function") input.focus();
      if (typeof selStart === "number" && typeof selEnd === "number"
          && typeof input.setSelectionRange === "function") {
        input.setSelectionRange(selStart, selEnd);
      }
    }
  } else if (railShowsInput !== editingState || (!editingState && rail.__herdrRailSignature !== html)) {
    rail.__herdrRailSignature = html;
    rail.innerHTML = html;
  }
}

// The rail as an UNGROUP drop target: a member chip held over the
// rail leaves the visible group and returns as an independent panel.
// The rail is a subject chooser, not a reordering strip, so only the
// exit gesture lands here; every other drag kind passes through to the
// container wiring untouched.
function wireRailMemberDrop(rail) {
  if (!rail || rail.__herdrRailMemberDropWired || typeof rail.addEventListener !== "function") return;
  rail.__herdrRailMemberDropWired = true;
  rail.addEventListener("dragenter", (event) => {
    paneRailMemberDragOver(event);
  });
  rail.addEventListener("dragover", (event) => {
    paneRailMemberDragOver(event);
  });
  rail.addEventListener("drop", (event) => {
    paneRailMemberDrop(event);
  });
  // dragleave fires on every chip boundary crossing; the highlight
  // only clears when the pointer truly leaves the rail row.
  rail.addEventListener("dragleave", (event) => {
    const drag = activeDragKind();
    if (!drag || drag.kind !== "member") return;
    const related = event.relatedTarget;
    if (!related || (typeof related.closest === "function" && !related.closest(".pane-label-rail"))) {
      if (rail.classList && rail.classList.remove) rail.classList.remove("pane-rail-drop-target");
    }
  });
}

function paneRailMemberDragOver(event) {
  const drag = activeDragKind();
  if (!drag || drag.kind !== "member") return;
  // Strip hovers keep their own affordances (carets, workspace hints);
  // the member exit only arms over the rail's own chip row.
  if (event.target && event.target.closest && event.target.closest(".pane-tab-strip")) return;
  if (event.preventDefault) event.preventDefault();
  if (event.dataTransfer && "dropEffect" in event.dataTransfer)
    event.dataTransfer.dropEffect = "move";
  const rail = event.currentTarget;
  if (rail && rail.classList && rail.classList.add) rail.classList.add("pane-rail-drop-target");
}

function paneRailMemberDrop(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? dropDragKindFromData(event.dataTransfer)
      : null);
  const rail = event.currentTarget;
  if (rail && rail.classList && rail.classList.remove) rail.classList.remove("pane-rail-drop-target");
  if (!drag || drag.kind !== "member") return;
  if (event.target && event.target.closest && event.target.closest(".pane-tab-strip")) return;
  if (event.preventDefault) event.preventDefault();
  // The rail owns this release: stop the bubble so the container's
  // payload re-read cannot run a second pass over the same drop.
  if (event.stopPropagation) event.stopPropagation();
  const root = paneRootFor();
  const leaf = paneForPaneId(root, drag.paneId);
  paneMemberDragEnd();
  if (!leaf) return;
  ungroupMember(leaf);
}

// Subject switch from a rail chip: the panel press shows the panel
// flat while its group record persists; pressing a member chip also
// remembers that member as the group's focus so reopening restores it.
function showPanelFromRail(encodedPaneId) {
  const entry = paneRootFor();
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const leaf = paneId ? paneForPaneId(entry, paneId) : null;
  if (!leaf) return false;
  focusLeaf(entry, leaf);
  const group = groupForLeaf(entry, leaf);
  setVisibleSubject("panel", leaf.paneId,
    group ? { groupId: group.groupId, focusedPaneId: leaf.paneId } : null);
  saveWorkspacePanesStates();
  if (!writeRouteFromLeaf(leaf) || typeof go !== "function") renderWorkspacePanes();
  return true;
}

// Subject switch from the rail: the group chip press reopens the split.
// The focused member resolves in priority order: the group record's
// memory (the member this or another client last opened the split on),
// then the focus pointer while it still names a member (same-session
// press), then the first member. Reopening writes the memory back so
// the server round trip keeps it.
function showGroupFromRail(encodedGroupId) {
  const entry = paneRootFor();
  const groupId = decodeURIComponent(String(encodedGroupId || ""));
  const group = groupById(entry, groupId);
  if (!group || groupMemberCount(group) < 2) return false;
  const members = groupMembers(group);
  const remembered = group.focusedPaneId
    ? members.find((l) => l.paneId === group.focusedPaneId)
    : null;
  const focused = remembered || (entry.activePaneId && members.find((l) => l.paneId === entry.activePaneId));
  const target = focused || members[0];
  focusLeaf(entry, target);
  const prev = setVisibleSubject("group", group.groupId, { groupId: group.groupId, focusedPaneId: target.paneId });
  saveWorkspacePanesStates();
  if (!writeRouteFromLeaf(target) || typeof go !== "function") renderWorkspacePanes();
  return prev;
}

function renderWorkspacePanes() {
  const container = el("workspacePanes");
  if (!container) return;
  wirePanelChipDrag(container);
  // The no-workspace dashboard owns the container: no pane skeleton
  // renders until a workspace opens, or the takeover would rebuild
  // dead chrome right after the dashboard mount pass detached it.
  if (dashboardOwnsPaneArea()) return;
  const entry = paneRoot();
  if (!paneTreeRenderable(entry)) return;
  // Auto-close runs BEFORE the subject read: the sweep drops panels
  // EMPTIED by a gesture (armed at the emptying site: moves, drops,
  // closes, backend prunes), and the paint below must show the
  // settled entry, never an entry mid-drop. Every emptying path
  // renders (poll ticks, focus gestures, moves, closes), so this one
  // hook covers them all; the focused panel and the entry's last
  // panel survive by the sweep's own guards.
  if (sweepAbandonedEmptyLeaves()) {
    if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
    if (window.HerdrPaneFocus && typeof window.HerdrPaneFocus.applyFocusClasses === "function")
      window.HerdrPaneFocus.applyFocusClasses();
  }
  // Re-read after the sweep: a drop can remove panels and dissolve
  // groups, and the paint below must target the live entry, not the
  // pre-sweep snapshot.
  const settled = paneRoot();
  syncTerminalTabsIntoTree(settled);
  const subject = visibleSubject(settled);
  if (!subject) return;
  // Per-pass lookups (see panePassLookups above) exist only for the paint
  // below: installed after the sweep and the sync settled the entry, and
  // restored in the finally even when a mount call throws, so no caller
  // outside this pass can read a stale memo.
  const savedPassLookups = panePassLookups;
  panePassLookups = buildPanePassLookups(settled);
  try {
    // Never innerHTML this container: #terminalShell (and the #tabs /
    // #projectDashboard siblings app.html parks here) are live nodes the
    // whole app resolves by id. Build the layout with createElement so those
    // nodes stay attached, then move #terminalShell into its pane below.
    const renderLeaves = [];
    if (subject.kind === "group" && isPaneSplit(subject.group.layout)) {
      reconcileSplitNode(container, subject.group.layout, splitNodeId(subject.group.layout), (id) => paneForPaneId(settled, id));
      renderLeaves.push(...groupMembers(subject.group));
    } else if (subject.kind === "group") {
      // Degraded layout (flat array): fall back to a flat pair render.
      const members = groupMembers(subject.group);
      const layout = { kind: "row", sizes: members.map(() => 1), children: members.map((m) => m.paneId) };
      subject.group.layout = layout;
      reconcileSplitNode(container, layout, splitNodeId(layout), (id) => paneForPaneId(settled, id));
      renderLeaves.push(...members);
    } else {
      // Single panel subject: keep the Phase 3 flat contract (no wrapper
      // element), so existing callers and probes that query
      // .workspace-pane directly stay valid.
      let pane = [...container.children].find((child) => hasClass(child, "workspace-pane"));
      if (!pane) {
        pane = createPaneElement(subject.leaf.paneId || "root");
        container.appendChild(pane);
      }
      renderLeaves.push(subject.leaf);
    }
    // Stale layout nodes from a previous subject (split chrome from the
    // group paint, or extra flat panes from the single paint) go once the
    // current subject owns the container. Live surfaces rescue out
    // first; the rail is chrome and rebuilds below.
    cleanupAbandonedSubjectDom(container, subject, renderLeaves);
    renderLabelRail(container, settled, subject);
    // Every rendered leaf mounts its strip and active tab: strips render
    // everywhere, and the terminal leaf mounts/parks the one
    // #terminalShell surface. A leaf whose active tab is editor/git keeps
    // its own module container (the owning module mounts it);
    // mountPaneTabContent only decides where the terminal shell lives and
    // which stale containers hide.
    const auxTabs = [];
    renderLeaves.forEach((leaf) => {
      const pane = paneLeafElement(container, subject, leaf);
      if (pane) {
        renderLeafInto(pane, leaf);
        mountPaneTabContent(pane, leaf, auxTabs);
      }
    });
    // Non-owner terminal leaves own aux surfaces; a tab not still on
    // screen (closed or dropped panel, tab moved to the owner) parks its
    // surface in the D8 cache (releaseStale also runs the cap eviction).
    if (window.HerdrPaneTerminals) window.HerdrPaneTerminals.releaseStale(auxTabs);
    // A reshape can drop the leaf hosting the empty-leaf card (group
    // dissolve, close, subject switch): rescue parks it home hidden, and
    // only this sync decides whether the zero-tab state still warrants it.
    // Without the call here a quiet zero-tab workspace has no event-driven
    // refresh coming, so the card stayed parked and gone until some other
    // action rendered. Same bare-function guard style as the callers in
    // this file: standalone VM harnesses load this module without render.js.
    if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
    // Mirror the entry's active pointer onto the pane elements (focus ring).
    if (window.HerdrPaneFocus && typeof window.HerdrPaneFocus.applyFocusClasses === "function")
      window.HerdrPaneFocus.applyFocusClasses();
    // The bar's pane controls act on the focused leaf, so every reshape
    // (group change, close, focus follow) must repaint them. The bar
    // sync is signature-gated: a no-change reshape costs one string compare.
    if (window.HerdrLocationBar && typeof window.HerdrLocationBar.sync === "function")
      window.HerdrLocationBar.sync();
  } finally {
    panePassLookups = savedPassLookups;
  }
}

// Subject-scoped DOM cleanup: keeps the panes the current subject
// renders (keyed by paneId), drops every other layout node and stray
// flat pane; the label rail survives as chrome. Live surfaces rescue
// out before any drop.
function cleanupAbandonedSubjectDom(container, subject, renderLeaves) {
  const keepIds = new Set(renderLeaves.map((leaf) => leaf.paneId));
  const layoutRoot = subject.kind === "group" && isPaneSplit(subject.group.layout) ? splitNodeId(subject.group.layout) : null;
  [...(container.children || [])].forEach((child) => {
    if (hasClass(child, "pane-label-rail")) return;
    if (hasClass(child, "pane-row") || hasClass(child, "pane-column")) {
      if (layoutRoot && child.dataset && child.dataset.splitId === layoutRoot) return;
      rescueLiveSurfaces(container, child);
      detachDomNode(child);
    } else if (hasClass(child, "workspace-pane")) {
      // A GROUP subject renders its members inside the layout wrapper
      // ONLY: a flat pane left over from a previous panel render keeps
      // the same paneId, so the keep-set alone would hold it and both
      // copies would paint. When the subject is a group, the wrapper is
      // the only home and every direct flat pane goes.
      if (!layoutRoot && keepIds.has(child.dataset ? child.dataset.paneId : null)) return;
      rescueLiveSurfaces(container, child);
      detachDomNode(child);
    } else if (hasClass(child, "pane-strip-rail")) {
      detachDomNode(child);
    }
  });
}

function paneLeafElement(container, root, leaf) {
  // Group subjects render through the split reconcile: the pane sits
  // somewhere in the layout wrapper, keyed by paneId. Single-panel
  // subjects keep the flat contract (first .workspace-pane child).
  // root is the VISIBLE SUBJECT for the render pass (kind: panel|group)
  // and the session entry everywhere else: accept both by testing the
  // subject shape (kind) and falling back to the entry's visible
  // subject when the caller passed the entry.
  const subject = root && root.kind ? root : null;
  const isGroup = subject
    ? subject.kind === "group"
    : !!(root && (visibleSubject(root) || {}).kind === "group");
  if (isGroup) {
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
  return `<button class="pane-ws-badge" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" onclick="event.stopPropagation();HerdrPaneWorkspacePicker.openPicker(this,'${escapeHandlerArg(encodedPane)}','switch')">${escapeHtml(label)}</button>`;
}

// Panels hosting the selected workspace's terminal tabs carry the
// pane-owns-current class: on mixed sessions it paints a distinct
// border so the home pane reads at a glance (the D4 badge names it,
// the border locates it). Single-workspace sessions skip the class:
// every pane would wear it, no information.
function markCurrentWorkspacePane(pane, leaf) {
  if (!pane || !pane.classList) return;
  const ids = leafWorkspaceIds(leaf);
  const owns = treeIsMixed() && ids.length === 1 && ids[0] === state.ws;
  if (owns && !pane.classList.contains("pane-owns-current")) pane.classList.add("pane-owns-current");
  if (!owns && pane.classList.contains("pane-owns-current")) pane.classList.remove("pane-owns-current");
}

// Panel chip (collector model): one chip per strip's leading edge, only
// when the session holds more than one panel. Standalone panels name
// their workspace (worktree display name when it has one). Grouped
// panels sit behind their group chip in the rail; the strip chip
// still names the panel itself (focus and identity, never grouping).
// Single-panel sessions hide the chip: one panel names itself through
// the location bar and sidebar already.

// Terminal labels stacked in one strip. Editor and git tabs ride on
// the panel they opened from, the boot placeholder is not a label yet:
// neither counts toward the stack.
function leafTerminalLabelCount(leaf) {
  return (leaf.tabs || []).filter((id) => !isEditorTab(id) && !isGitTab(id) && id !== TERMINAL_TAB_PLACEHOLDER).length;
}

// Group stamp for the sweep (kept minimal in the flat model): a group
// member emptied by a gesture carries which group it belonged to, so
// the sweep dissolves the group instead of leaving a one-member stub.
// Ids, not refs: the stamp rides the leaf through saveWorkspacePanesStates.
function autoClosePreStateFor(root, leaf) {
  if (!leaf) return null;
  const group = groupForLeaf(root, leaf);
  return group ? { collectorId: group.groupId, wsId: leafWorkspaceId(leaf) || null } : null;
}

// Identity chip on each strip of the VISIBLE split: names the member
// (workspace + panel identity), click focuses it, drag re-positions
// inside the split or drops on the rail to leave the group and return
// as an independent panel. Flat views carry no chip: the rail already
// names every independent panel, and a chip there duplicated the
// panel's identity next to its own tab label.
function panePanelChipHtml(leaf) {
  const root = paneRootFor();
  if (!leaf) return "";
  // Merged-header era: the chip IS the member's merged header. The
  // split-visibility gate stays (flats and hidden groups carry no
  // chip); the returned markup is the one fused element the split
  // renders, so external probes read the same html the strip shows.
  const group = groupForLeaf(root, leaf);
  if (!group || !visibleSubjectIsGroup(root, group.groupId)) return "";
  return paneMergedHeaderHtml(leaf, paneTabsForTree(leaf), paneActiveTabOf(leaf));
}

// The member identity every split surface speaks: a set name is the
// identity alone; a default panel carries its worktree name plus
// number so two panels of one worktree never read identical in a
// split. Shared by the merged header and the legacy chip callers.
function paneMemberHeaderLabel(leaf) {
  const root = paneRootFor();
  const wsId = leafWorkspaceId(leaf);
  const workspace = panePassLookups
    ? (panePassLookups.workspacesById.get(wsId) || null)
    : (wsId ? (state.workspaces || []).find((w) => w.workspace_id === wsId) || null : null);
  const wsName = workspace
    ? ((typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) || workspace.label || wsId)
    : (wsId || "panel");
  const name = leaf.name ? String(leaf.name).trim() : "";
  if (name) return name;
  // The active tab decides the number; an editor/git active tab is
  // not a terminal row, so the first terminal tab of the leaf takes
  // over (the number still identifies the panel behind the view).
  const tabs = leaf.tabs || [];
  const activeTab = paneActiveTabOf(leaf);
  const candidate = activeTab && paneTerminalTabById(activeTab) ? activeTab : tabs.find((id) => paneTerminalTabById(id)) || null;
  const row = candidate ? paneTerminalTabById(candidate) : null;
  const number = row ? String(row.number || "") : "";
  return number ? `${wsName} ${number}` : wsName;
}

// The origin a member header speaks: the view's own workspace when the
// view carries one (terminal rows own a workspace_id), else the leaf's
// binding, else the selected workspace. Same precedence the strip
// prefixes use (row first, state.ws last), so the two never disagree.
function paneMemberWorktreeName(leaf, tabId) {
  let wsId = leafWorkspaceId(leaf) || state.ws;
  if (tabId && !isEditorTab(tabId) && !isGitTab(tabId)) {
    const row = paneTerminalTabById(tabId);
    if (row && row.workspace_id) wsId = row.workspace_id;
  }
  const workspace = panePassLookups
    ? (panePassLookups.workspacesById.get(wsId) || null)
    : ((state.workspaces || []).find((w) => w.workspace_id === wsId) || null);
  return workspace
    ? ((typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) || workspace.label || wsId)
    : (wsId || "panel");
}

// The view span of a merged member header: the worktree and the view
// in one line, "wt · view". The title carries the full detail (path,
// refs, row label) because the span ellipsizes.
function paneMemberViewSpan(origin, fullTitle, viewLabel) {
  const title = origin ? `${origin} · ${fullTitle}` : fullTitle;
  const text = origin ? `${origin} · ${viewLabel}` : String(viewLabel);
  return `<span class="pane-member-view" title="${escapeAttr(title)}">${escapeHtml(text)}</span>`;
}

// The merged member header (locked model): ONE element per split
// member. The member identity (label + accent) and its single view
// ride one button: click focuses the member (the view is the panel's
// only content, so the focus IS the view activation), drag repositions
// or exits to the rail, and close UNGROUPS (exit-to-rail, not close).
// Degraded multi-tab blobs render the extra views as plain tabs after
// the header rather than dropping a live view.
function paneMergedHeaderHtml(leaf, tabs, activeTab) {
  const label = paneMemberHeaderLabel(leaf);
  const encodedPane = leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  const dragAttrs = ` draggable="true" ondragstart="paneMemberDragStart(event,'${escapeHandlerArg(encodedPane)}')" ondragend="paneMemberDragEnd()"`;
  // Grouped members carry no rail chip, so the rename input mounts
  // right here: the header button swaps to the same input the rail
  // uses and commit/cancel restore focus to the header.
  if (state.editingPanelPaneId === leaf.paneId) {
    return `<input class="pane-group-rename-input pane-member-header-input" aria-label="Rename panel" value="${escapeAttr(state.editingPanelValue || "")}"${typeof inputAttrs === "function" ? inputAttrs("done") : ""} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitPanelChipRename('${escapeHandlerArg(encodedPane)}')" oninput="state.editingPanelValue=this.value" onkeydown="panelChipRenameKey(event,'${escapeHandlerArg(encodedPane)}')">`;
  }
  const views = tabs || [];
  const single = views.length === 1 ? views[0] : null;
  // The view span is the header's only visible voice: a set name REPLACES
  // its text (one span, the rename is the label now) instead of mounting a
  // second span beside it, so a renamed member never shows two text spans.
  // Origin plus view stay reachable through title and aria-label.
  let viewHtml = "";
  if (leaf.name) {
    viewHtml = `<span class="pane-label-chip-text" title="${escapeAttr(label)}">${escapeHtml(leaf.name)}</span>`;
  } else if (single) {
    const origin = paneMemberWorktreeName(leaf, single);
    if (isEditorTab(single)) {
      viewHtml = paneMemberViewSpan(origin, editorTabPath(single), editorTabLabel(editorTabPath(single)));
    } else if (isGitTab(single)) {
      viewHtml = paneMemberViewSpan(origin, gitTabTitle(gitTabViewKey(single)), gitTabLabel(gitTabViewKey(single)));
    } else {
      // Known-but-unresolved rows (older servers without maps, or a
      // snapshot race) still render a span: the chip names the panel,
      // the span names the view, and a missing row must not silently
      // drop the view half of the header. The raw id is the honest
      // label until the row resolves.
      const row = paneTerminalTabById(single);
      let rowLabel = "";
      if (row) {
        rowLabel = String(row.label || "").trim() || `tab ${row.number || ""}`.trim();
      } else if (terminalTabKnown(single)) {
        rowLabel = String(single);
      }
      if (rowLabel) viewHtml = paneMemberViewSpan(origin, rowLabel, rowLabel);
    }
  }
  const header =
    `<button class="pane-member-header pane-panel-chip" role="tab" id="pane-header-${escapeAttr(leaf.paneId || "")}" aria-selected="${activeTab === single ? "true" : "false"}" aria-label="Focus panel: ${escapeAttr(label)}" title="Focus panel: ${escapeAttr(label)} (double-click or press F2 to rename)" data-pane-id="${escapeAttr(leaf.paneId || "")}"${dragAttrs}` +
    ` onclick="event.preventDefault();focusPanelFor('${escapeHandlerArg(encodedPane)}')" ondblclick="startPanelChipRename('${escapeHandlerArg(encodedPane)}')" onkeydown="memberHeaderKey(event,'${escapeHandlerArg(encodedPane)}')">` +
    `${viewHtml}` +
    `<span class="pane-tab-close" role="button" tabindex="0" title="Leave split" aria-label="Leave split" onclick="event.stopPropagation();ungroupPaneMember('${escapeHandlerArg(encodedPane)}')">✕</span>` +
    `</button>`;
  const extra = views.length > 1
    ? views.map((tabId) => {
        if (isEditorTab(tabId)) return paneEditorTabButtonHtml(tabId, tabId === activeTab);
        if (isGitTab(tabId)) return paneGitTabButtonHtml(tabId, tabId === activeTab);
        return paneTerminalTabButtonHtml(paneTerminalTabById(tabId), tabId === activeTab);
      }).join("")
    : "";
  return header + extra;
}

// Merged-header close: the member leaves the split through the
// ungroup op (exit-to-rail), never a close. The panel and its view
// survive as an independent rail panel.
function ungroupPaneMember(encodedPaneId) {
  const root = paneRootFor();
  const paneId = decodeURIComponentSafe(encodedPaneId);
  const leaf = paneId ? paneForPaneId(root, paneId) : activeLeaf(root);
  if (!leaf) return false;
  return ungroupMember(leaf);
}

// Merged-header keyboard: F2 renames the panel (same affordance as
// the rail chip). The close span stays click-and-delegated-Enter:
// bindings.js routes Enter/Space through .pane-tab-close, the same
// contract as the tab-close spans.
function memberHeaderKey(e, encodedPaneId) {
  if (!e) return;
  if (e.key === "F2") {
    if (e.preventDefault) e.preventDefault();
    startPanelChipRename(encodedPaneId);
  }
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
  // Stripless flats: only a member of the VISIBLE split renders a
  // strip, and its strip is ONE merged header (chip label + view tab
  // + close fused, per the locked model). A flat panel names itself
  // through the rail chip and the bar; a strip there duplicated the
  // identity and broke the one-view contract.
  const root = paneRootFor();
  const group = groupForLeaf(root, leaf);
  const inSplit = !!(group && visibleSubjectIsGroup(root, group.groupId));
  const strip = pane.querySelector(".pane-tab-strip");
  if (!strip) return;
  // The current-workspace marker rides the pane element, not the
  // strip: flats keep the marker even with the strip hidden.
  markCurrentWorkspacePane(pane, leaf);
  if (!inSplit) {
    // Flat pane: no strip at all. Existing strips from pre-rework
    // sessions clear once here; autoClose markers live on the leaf
    // record, not the DOM, so the sweep keeps its state. The hidden
    // attr re-asserts every pass because unhidePaneStrips (dashboard
    // and empty-leaf unmounts) force-shows every strip; the signature
    // guard above only guards the innerHTML rebuild.
    if (strip.__herdrPaneSignature !== "") {
      strip.__herdrPaneSignature = "";
      strip.innerHTML = "";
    }
    if (strip.setAttribute) strip.setAttribute("hidden", "hidden");
    return;
  }
  wirePaneStripDrag(strip);
  const activeTab = paneActiveTab(leaf);
  // The merged header: the member chip's identity and the view tab's
  // controls ride ONE element (label + accent + view tab + close).
  // paneTabsForTree yields at most one view under the invariant; a
  // degraded multi-tab blob still renders each tab rather than
  // dropping a live view.
  const stripHtml = paneMergedHeaderHtml(leaf, paneTabsForTree(leaf), activeTab);
  if (strip.__herdrPaneSignature !== stripHtml) {
    strip.__herdrPaneSignature = stripHtml;
    strip.innerHTML = stripHtml;
    if (strip.removeAttribute) strip.removeAttribute("hidden");
  }
}

// Node-test stubs have no .remove(): fall back to removeChild.
function detachDomNode(node) {
  if (node.remove) node.remove();
  else if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
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
    return `<span class="pane-tab terminal ${isActive ? "active" : ""}" role="tab"><input class="tab-rename-input" aria-label="Rename panel" value="${escapeAttr(state.editingTabValue)}"${inputAttrs("done")} onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${escapeHandlerArg(tab.tab_id)}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${escapeHandlerArg(tab.tab_id)}')"></span>`;
  // The strip prefix is the panel's origin, and only a
  // default-numbered label gets one (a custom name is the identity).
  // Computed HERE, once, and panelVisibleLabel receives it so the two
  // never drift: the visible span text, the data-ws-prefix attribute,
  // and the accessible name all derive from this one result. It renders
  // as a muted ::before (data-ws-prefix) so the number stays the
  // readable head; the full string rides aria-label (beats title for
  // screen readers, and the visible text may truncate).
  const isDefault = isDefaultPanelTitle(String((tab && tab.label) || "").trim());
  const prefix = isDefault ? workspacePrefixForTab(tab && tab.tab_id) : "";
  const shown = prefix ? panelNumberLabel(tab, index, tabs) : panelVisibleLabel(tab, index, tabs);
  const label = prefix ? `${prefix}${shown}` : shown;
  const labelSpan = prefix
    ? `<span class="pane-tab-label" data-ws-prefix="${escapeAttr(prefix.trim())}">${escapeHtml(shown)}</span>`
    : `<span class="pane-tab-label">${escapeHtml(label)}</span>`;
  const ariaLabel = `Panel ${label}`;
  return `<button class="pane-tab terminal ${isActive ? "active" : ""}" role="tab" aria-selected="${isActive ? "true" : "false"}" data-tab-kind="terminal" data-tab-id="${escapeAttr(tab.tab_id)}" draggable="true" aria-label="${escapeAttr(ariaLabel)}" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()" onclick="activatePaneTab('${escapeHandlerArg(tab.tab_id)}')" onauxclick="paneTabAuxClick(event,'terminal','${escapeHandlerArg(tab.tab_id)}')" ondblclick="event.preventDefault();startTabRename('${escapeHandlerArg(tab.tab_id)}','${escapeHandlerArg(panelRenameInitialLabel(tab))}')" title="${escapeAttr(tabHoverTitle(tab))}">${paneTabStatusHtml(tab)}${labelSpan}<span class="pane-tab-close" role="button" tabindex="0" title="Close panel" aria-label="Close panel" onclick="event.stopPropagation();closeTab('${escapeHandlerArg(tab.tab_id)}')">✕</span></button>`;
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
function paneBarControlsHtml() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return "";
  const leaf = activeLeaf(root);
  if (!leaf) return "";
  // The dashboard owns the pane area in the empty state: pane controls
  // would target dead chrome, the bar renders none.
  if (dashboardOwnsPaneArea()) return "";
  return `<span class="pane-strip-controls pane-bar-controls">${paneNewTabControlHtml(leaf)}${paneCloseControlHtml(leaf)}${paneFindControlHtml(leaf)}${paneMarkdownControlHtml(leaf)}${paneMenuControlHtml()}</span>`;
}

// Signature for the bar's render loop: every input that changes the
// controls' markup or state, so the bar repaints only on real change.
// The visible subject rides along: a rail press swaps the acting panel
// without touching the route, and the bar must follow.
function paneBarControlsSignature() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root) || dashboardOwnsPaneArea()) return "none";
  const leaf = activeLeaf(root);
  if (!leaf) return "none";
  const subject = visibleSubject(root);
  const activeTab = leaf.active || (leaf.tabs || [])[0] || null;
  const tabKind = isEditorTab(activeTab) ? "editor" : isGitTab(activeTab) ? "git" : activeTab ? "term" : "none";
  return [
    leaf.paneId,
    subject ? `${subject.kind}:${subject.kind === "group" ? subject.group.groupId : subject.leaf.paneId}` : "",
    paneLeaves(root).length,
    tabKind,
    paneMarkdownControlState(leaf),
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
  return `<button class="pane-strip-button pane-find-button" title="Find / replace" aria-label="Find / replace" onclick="event.preventDefault();openPaneEditorFind('${escapeHandlerArg(encoded)}')">⌕</button>`;
}

// Markdown editor tabs get one eye control beside the find button: it
// cycles rendered preview, raw source, and edit. Non-markdown files and
// read-only mounts (partial previews) keep the strip without it.
// Which eye-button state the active editor tab is in: "" (no control),
// "edit", "source", or "preview". The bar signature needs the state as a
// token so a mode toggle repaints the button; paneMarkdownControlHtml
// renders from the same token.
function paneMarkdownControlState(leaf) {
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
  if (file.editing) return "edit";
  return file.previewSource ? "source" : "preview";
}

function paneMarkdownControlHtml(leaf) {
  const state = paneMarkdownControlState(leaf);
  if (!state) return "";
  const encoded = encodeURIComponent(editorTabPath(leaf.active));
  if (state === "edit") {
    // Edit mode: the eye returns to the rendered preview. Dirty drafts
    // stay in the draft buffer; going back is the same unsaved state the
    // tab close would confirm about.
    return `<button class="pane-strip-button pane-md-button" title="Show rendered preview" aria-label="Show rendered preview" onclick="event.preventDefault();paneMarkdownPreview('${escapeHandlerArg(encoded)}')">◔</button>`;
  }
  return state === "source"
    ? `<button class="pane-strip-button pane-md-button" title="Edit markdown source" aria-label="Edit markdown source" onclick="event.preventDefault();paneMarkdownEdit('${escapeHandlerArg(encoded)}')">✎</button>`
    : `<button class="pane-strip-button pane-md-button" title="Show markdown source" aria-label="Show markdown source" onclick="event.preventDefault();paneMarkdownSource('${escapeHandlerArg(encoded)}')">◑</button>`;
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
    return `<button class="pane-strip-button pane-new-picker" title="New panel in a workspace" aria-label="New panel in a workspace" aria-haspopup="dialog" onclick="event.preventDefault();HerdrPaneWorkspacePicker.openPicker(this,'${escapeHandlerArg(encoded)}','new-tab')">+</button>`;
  }
  return `<button class="pane-strip-button" title="${escapeAttr(titleWithWebuiShortcut("New panel", "newPanel"))}" aria-label="New panel" onclick="event.preventDefault();newPanelForFocused()">+</button>`;
}

// Close only exists when another panel could take the route: one panel
// keeps it hidden (closing the last panel is closing the workspace).
// Stripless model: this is a REAL close of the panel (the panel record
// and its view go), never a merge into a neighbor. A split member
// closed from its bar ungroups (the merged header's own ✕ carries
// the split-exit); this control closes the panel outright.
function paneCloseControlHtml(leaf) {
  const root = paneRootFor();
  if (paneLeaves(root).length < 2) return "";
  const encoded = leaf && leaf.paneId ? encodeURIComponent(leaf.paneId) : "";
  return `<button class="pane-strip-button" title="Close panel" aria-label="Close panel" onclick="event.preventDefault();closePaneFor('${escapeHandlerArg(encoded)}')">✕</button>`;
}

// ---- pane menu (Phase 5) -----------------------------------------------
// One menu for the strip's [⋮]: actions depend on the pane's active tab
// kind (terminal, editor, git). Transient by design: it lives outside the
// re-rendered strip, so a strip reconcile never destroys it mid-click.
let paneMenu = null;

function paneMenuItemsFor(leaf, root) {
  const items = [];
  // Rename always names the PANEL (leaf.name), never the tab row: the
  // stripless flat carries no tab strip for a tab-rename input, and
  // the merged header + rail chip speak the panel identity. The rail
  // chip swap (startPanelChipRename) is the one rename surface left.
  items.push({
    id: "rename-pane",
    label: "Rename panel",
    action: () => { focusLeaf(root, leaf); startPanelChipRename(encodeURIComponent(leaf.paneId)); },
  });
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
  // Abandoning a tab drag mid-flight must clear the chrome it owns
  // (preview square, caret, workspace hint), or the dotted square
  // sticks on the last hovered half. The location bar's remove
  // indicator clears here too: the drag may end on the bar's drop, in
  // which case the bar's own drop handler already ran; anywhere else
  // the class would stick.
  clearPanelDropPreview();
  clearPaneDropCaret();
  clearPaneWorkspaceDropHint();
  clearLocationBarPaneRemove();
  document.querySelectorAll(".pane-tab-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-tab-dragging");
  });
}

// The location bar's ungroup affordance: a herdr-pane-tab drag whose
// owning panel sits in a group qualifies (the remove indicator
// paints on hover); the drop hands the panel back to the rail as an
// ungrouped label.
function clearLocationBarPaneRemove() {
  const bar = el("locationBar");
  if (bar && bar.classList && bar.classList.remove) bar.classList.remove("location-bar-pane-remove");
}

// The ungroup gesture: a member's LABEL (terminal tab) dragged to the
// location bar leaves the group. Qualifies while the drag rides a
// terminal tab whose owning panel belongs to a group with 2+ members.
function paneTabUnsplitTarget(tabId) {
  if (!tabId) return null;
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const leaf = paneForTab(root, tabId);
  if (!leaf || !leaf.groupId) return null;
  const group = groupForLeaf(root, leaf);
  if (!group || groupMemberCount(group) < 2) return null;
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
  paneTabDragEnd();
  ungroupMember(target.leaf);
  return true;
}

// Remove a member from its group: the member turns back into an
// ungrouped panel (its label returns to the rail). The group keeps
// the remaining members; dropping under two dissolves it entirely
// and, when it was visible, the subject heals through visibleSubject.
function ungroupMember(leaf) {
  const root = paneRootFor();
  const group = groupForLeaf(root, leaf);
  if (!group) return false;
  return panesOpWithFallback(
    { op: "group.ungroup", paneId: leaf.paneId },
    () => localUngroupMember(leaf),
  );
}

function localUngroupMember(leaf) {
  const root = paneRootFor();
  const group = groupForLeaf(root, leaf);
  if (!group) return false;
  // Survivor and subject reads BEFORE the member splice: the member
  // list dies with the record on a dissolve, and the heal needs the
  // surviving sibling, not the panels[0] fallback.
  const survivor = groupMembers(group, root).find((member) => member !== leaf) || null;
  const wasVisible = !!(root.visible && root.visible.type === "group" && root.visible.id === group.groupId);
  const at = group.memberIds.indexOf(leaf.paneId);
  if (at >= 0) group.memberIds.splice(at, 1);
  leaf.groupId = null;
  if (groupMemberCount(group, root) < 2) {
    for (const member of groupMembers(group, root)) member.groupId = null;
    const atRec = root.groups.indexOf(group);
    if (atRec >= 0) root.groups.splice(atRec, 1);
    // The dissolve hands the subject to the surviving member when the
    // pointer named this group; visibleSubject below re-derives the
    // same pointer from the healed panel id.
    if (survivor && wasVisible) root.visible = { type: "panel", id: survivor.paneId };
  } else {
    group.layout = memberLayoutWithout(group.layout, leaf.paneId);
    // Focus memory cannot name the just-removed member: the record
    // keeps a dead pointer otherwise, and reopening the group would
    // fall back to members[0] only because of the normalize heal.
    if (group.focusedPaneId === leaf.paneId) group.focusedPaneId = null;
  }
  const subject = visibleSubject(root);
  root.visible = subject && subject.kind === "group"
    ? { type: "group", id: subject.group.groupId }
    : { type: "panel", id: subject.leaf.paneId };
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
}

// Layout surgery: drop paneId from the layout tree. A split that falls
// under two children collapses to its survivor; the ROOT dropping to
// one child returns that child (a paneId string or nested node). A
// degraded FLAT array filters the id directly: without it the removed
// member would sit in the layout until the next normalize rebuild.
function memberLayoutWithout(node, paneId) {
  if (!node) return null;
  if (node === paneId) return null;
  if (Array.isArray(node)) {
    const kept = node.filter((child) => child !== paneId);
    return kept.length ? kept : null;
  }
  if (!Array.isArray(node.children)) return node;
  node.children = node.children
    .map((child) => memberLayoutWithout(child, paneId))
    .filter(Boolean);
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  node.sizes = node.children.map((_, i) => (Number.isFinite(node.sizes[i]) && node.sizes[i] > 0 ? node.sizes[i] : 1));
  return node;
}

// Rail label drag (one-visible-view model): a panel label picked from
// the rail carries the panel's paneId. The drop creates or extends a
// group at the previewed quadrant. Group chips never drag (spec has
// no group-drag gesture).
let paneDragLabelPaneId = null;

function paneLabelDragStart(event, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const root = paneRootFor();
  const leaf = paneId ? paneForPaneId(root, paneId) : null;
  // A grouped member never drags as a grouping payload: panels cannot
  // group outside a split view, and a parked (hidden) group member is
  // not addressable until its chip reopens the split. Leaving a group
  // is the tab-to-location-bar ungroup gesture inside the split.
  // Refuse the dragstart so the chip cannot offer a dead drop target.
  if (!leaf || leaf.groupId) {
    if (event && event.preventDefault) event.preventDefault();
    return;
  }
  paneDragLabelPaneId = paneId;
  if (event && event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-label", paneId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  const chip = event && event.target;
  if (chip && chip.classList && chip.classList.add) chip.classList.add("pane-label-dragging");
}

function paneLabelDragEnd() {
  paneDragLabelPaneId = null;
  clearPanelDropPreview();
  document.querySelectorAll(".pane-label-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-label-dragging");
  });
}

function paneLabelDragKind() {
  return paneDragLabelPaneId ? { kind: "label", paneId: paneDragLabelPaneId } : null;
}

// Member drag (group view): a strip chip of a VISIBLE-group member
// carries the panel's paneId. Inside the split the drop re-positions
// the panel; over the rail it ungroups. The member kind outranks the
// tab kind in activeDragKind so a terminal-tab drag started from the
// same strip never forks the state mid-gesture.
let paneDragMemberPaneId = null;

function paneMemberDragStart(event, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const root = paneRootFor();
  const leaf = paneId ? paneForPaneId(root, paneId) : null;
  const group = groupForLeaf(root, leaf);
  // Only a member of the visible split drags: an independent panel's
  // chip never carries the drag wiring, and a stale group (dissolved
  // under the pointer mid-gesture) must not arm a dead drag.
  if (!leaf || !group || !visibleSubjectIsGroup(root, group.groupId)) {
    if (event && event.preventDefault) event.preventDefault();
    return;
  }
  paneDragMemberPaneId = paneId;
  if (event && event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-member", paneId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  const chip = event && event.target;
  if (chip && chip.classList && chip.classList.add) chip.classList.add("pane-label-dragging");
}

function paneMemberDragEnd() {
  paneDragMemberPaneId = null;
  clearPanelDropPreview();
  clearPaneDropCaret();
  clearPaneWorkspaceDropHint();
  document.querySelectorAll(".pane-rail-drop-target").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-rail-drop-target");
  });
  document.querySelectorAll(".pane-label-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-label-dragging");
  });
}

function paneMemberDragKind() {
  return paneDragMemberPaneId ? { kind: "member", paneId: paneDragMemberPaneId } : null;
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
  // Every panel-facing surface speaks worktreeDisplayName (branch or
  // checkout basename); workspaceDisplayTitle is label-first and would
  // name the same worktree differently here than in the chip beside it.
  const label =
    (typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) ||
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

// Which drag payload is in flight: a pane tab (text/herdr-pane-tab), a
// strip member chip (text/herdr-pane-member, the visible group's view),
// a rail panel label (text/herdr-pane-label), or a sidebar workspace
// card (state.dragWorkspace, set by workspaceDragStart). Member and
// tab drags win when several signals somehow exist (a member drag is
// never a tab drag: the kinds are armed by different elements).
function activeDragKind() {
  if (paneMemberDragKind()) return paneMemberDragKind();
  if (paneDragLabelPaneId) return { kind: "label", paneId: paneDragLabelPaneId };
  if (paneDragTabId) return { kind: "tab", tabId: paneDragTabId };
  if (state.dragWorkspace) return { kind: "workspace", workspaceId: state.dragWorkspace };
  return null;
}

// Container-level drags (one-visible-view model): a TAB drag keeps the
// member-strip caret flow; a LABEL drag from the rail previews the
// split quadrant over the visible subject; a MEMBER drag from a group
// strip chip previews the re-position quadrant over another member's
// pane. All share the container wiring from wirePanelChipDrag.
function paneContainerTabDragOver(event) {
  const drag = activeDragKind();
  if (!drag) return;
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (drag.kind === "label" || drag.kind === "member") {
    if (onStrip) return;
    const container = el("workspacePanes");
    const target = panelDropTargetAt(container, event);
    const valid = drag.kind === "label" ? labelDropTargetValid(target, drag) : memberDropTargetValid(target, drag);
    if (!target || !valid) {
      clearPanelDropPreview();
      return;
    }
    if (event.preventDefault) event.preventDefault();
    if (event.dataTransfer && "dropEffect" in event.dataTransfer)
      event.dataTransfer.dropEffect = "move";
    positionPanelDropPreview(container, event, target);
    return;
  }
  if (drag.kind !== "tab") return;
  // The strip owns its own hover: skip when the pointer rides a strip
  // so the caret keeps precedence and the square never overlaps it.
  if (onStrip) return;
  // TAB drags no longer split: the group gesture owns geometry. The
  // caret path in the strips handles reordering; content hovers keep
  // the preview hidden so a release over dead space drops clean.
  clearPanelDropPreview();
}

// A member re-position drop qualifies on another member of the same
// visible group: the release pane hosts the dragged view's new slot.
// The dragged member never hosts its own drop (a no-op at best, a
// corruption vector at worst: layoutWithPanelAt assumes an external
// id).
function memberDropTargetValid(target, drag) {
  const root = paneRootFor();
  if (!target || !target.paneId) return false;
  const dragged = paneForPaneId(root, (drag && drag.paneId) || (paneMemberDragKind() ? paneMemberDragKind().paneId : null));
  if (!dragged || !dragged.groupId) return false;
  const group = groupForLeaf(root, dragged);
  if (!group || !visibleSubjectIsGroup(root, group.groupId)) return false;
  if (target.paneId === dragged.paneId) return false;
  const host = paneForPaneId(root, target.paneId);
  return !!(host && host.groupId === group.groupId);
}

// A label drop qualifies only when the auto-join neighbor exists
// (panel subject) or the visible subject is a group (growth). The
// dragged panel itself never hosts its own drop.
function labelDropTargetValid(target, drag) {
  const root = paneRootFor();
  if (!target || !target.paneId) return false;
  const subject = visibleSubject(root);
  if (!subject) return false;
  // The dragged panel comes from the CAPTURED drag state (payload or
  // module state), never from the drop host: after paneLabelDragEnd()
  // clears the module state, a host fallback would resolve the host
  // itself as the dragged panel and refuse every drop.
  const dragged = paneForPaneId(root, (drag && drag.paneId) || (paneLabelDragKind() ? paneLabelDragKind().paneId : null));
  if (!dragged) return false;
  if (subject.kind === "group") {
    // Growth needs the dragged panel OUTSIDE the group (a member drag
    // is the ungroup gesture, never a re-position).
    return !dragged.groupId;
  }
  if (subject.leaf === dragged) return false;
  const neighbor = autoJoinNeighborFor(dragged);
  return !!neighbor;
}

// The auto-join neighbor (spec point 3): the ungrouped panel beside
// the dragged one in rail order, right by default, left when the
// dragged label is the LAST (or the settings choice flips the side).
function autoJoinNeighborFor(dragged) {
  const root = paneRootFor();
  const ungrouped = railOrderUngroupedPanels(root);
  const at = ungrouped.indexOf(dragged);
  if (at < 0) return null;
  // The settings choice flips which neighbor fills the other half
  // ("right" default, "left" alternative). Bundle-scope options, same
  // read pane_terminals uses; the typeof guard keeps standalone-VM
  // harnesses (no core.js) on the default.
  const preferLeft = typeof options === "object" && options && options.paneGroupAutoJoin === "left";
  const next = ungrouped[at + 1] || null;
  const prev = ungrouped[at - 1] || null;
  // Right preference: the right neighbor when it exists, else the
  // left. The dragged-last rule in the spec ("left if its the
  // latest") falls out of the same fallback.
  if (preferLeft) return prev || next;
  return next || prev;
}

// Rail order for the neighbor rule: ungrouped panels in entry.panels
// order (the rail renders that list verbatim).
function railOrderUngroupedPanels(root) {
  return paneLeaves(root).filter((leaf) => !leaf.groupId);
}

// Label drop on the visible subject: create the group (panel subject)
// or grow the visible group. The dragged panel lands at the previewed
// quadrant; the auto-join neighbor fills the opposite side. A member
// drop re-positions the dragged view inside the visible group.
function paneContainerTabDrop(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? dropDragKindFromData(event.dataTransfer)
      : null);
  if (!drag) return;
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (onStrip) return;
  if (drag.kind === "member") {
    const container = el("workspacePanes");
    const target = panelDropTargetAt(container, event);
    if (!target || !memberDropTargetValid(target, drag)) {
      paneMemberDragEnd();
      return;
    }
    if (event.preventDefault) event.preventDefault();
    const moved = repositionGroupMember(drag.paneId, target.paneId, target.axis === "row" ? "row" : "column", target.first);
    paneMemberDragEnd();
    return;
  }
  if (drag.kind !== "label") {
    // TAB drops outside strips end the drag cleanly: strips own every
    // tab drop, and content hovers offered no preview.
    if (drag.kind === "tab") paneTabDragEnd();
    return;
  }
  const container = el("workspacePanes");
  const target = panelDropTargetAt(container, event);
  // The drag state must survive until the validity gate and the
  // surgery below resolve the dragged panel: paneLabelDragEnd() clears
  // paneDragLabelPaneId, so an earlier call would leave the validity
  // check reading the DROP HOST as the dragged panel (every drop
  // refused). The clear runs on every exit through the finally-style
  // call below, so no path leaks drag state.
  if (!target || !labelDropTargetValid(target, drag)) {
    paneLabelDragEnd();
    return;
  }
  if (event.preventDefault) event.preventDefault();
  const root = paneRootFor();
  const dragged = paneForPaneId(root, drag.paneId);
  if (!dragged) {
    paneLabelDragEnd();
    return;
  }
  const axis = target.axis === "row" ? "row" : "column";
  // The layout host for growth drops: the pane the pointer rode. The
  // clear must run on EVERY exit (a refused drop would otherwise leak
  // the host into the next growth drop and misplace it).
  dropHostPaneId = target.paneId || null;
  let landed = false;
  if (labelDropCreatesGroup(root)) {
    landed = createGroupFromDrop(dragged, axis, target.first);
  } else {
    landed = growVisibleGroupWith(dragged, axis, target.first);
  }
  dropHostPaneId = null;
  paneLabelDragEnd();
  if (!landed) return;
  // A thenable landed value means a server op owns the outcome: its
  // settle owns save+render. REJECTED is not thenable and still paints
  // here; a local paint on the promise path would persist and paint a
  // visible subject with the "__pending__" placeholder id.
  if (landed && typeof landed.then === "function") return;
  saveWorkspacePanesStates();
  renderWorkspacePanes();
}

// dataTransfer-only drops (no dragstart ran in this document, e.g. a
// stub event): read the payload kind straight from the data. The
// member payload outranks the label one: both carry a paneId, but a
// member payload only ever mints on a visible-group chip.
function dropDragKindFromData(dataTransfer) {
  const member = dataTransfer.getData("text/herdr-pane-member");
  if (member) return { kind: "member", paneId: member };
  const label = dataTransfer.getData("text/herdr-pane-label");
  if (label) return { kind: "label", paneId: label };
  const tab = dataTransfer.getData("text/herdr-pane-tab");
  if (tab) return { kind: "tab", tabId: tab };
  return null;
}

// Panel subject: the drop creates the group. The dragged panel and
// the auto-join neighbor join; the previously visible panel hands the
// subject over (it is NOT a member).
function labelDropCreatesGroup(root) {
  const subject = visibleSubject(root);
  return !!(subject && subject.kind === "panel");
}

function createGroupFromDrop(dragged, axis, draggedFirst) {
  const root = paneRootFor();
  const neighbor = autoJoinNeighborFor(dragged);
  if (!neighbor) return false;
  // Server owns the mint: the op response carries the authoritative
  // entry (new groupId, layout, visible) and panesServerOp adopts it.
  // The local pointer is written first so the adopt pass keeps it; the
  // failed-op fallback rewrites it before the local twin runs.
  const runLocal = () => {
    root.visible = { type: "panel", id: dragged.paneId };
    return localCreateGroupFromDrop(dragged, neighbor, axis, draggedFirst);
  };
  if (panesMode === "server") {
    root.visible = { type: "group", id: "__pending__" };
    return panesOpWithFallback(
      {
        op: "group.create",
        paneId: dragged.paneId,
        neighborPaneId: neighbor.paneId,
        axis,
        draggedFirst,
      },
      runLocal,
    );
  }
  return runLocal();
}

function localCreateGroupFromDrop(dragged, neighbor, axis, draggedFirst) {
  const root = paneRootFor();
  const group = {
    groupId: newGroupId(),
    name: null,
    memberIds: [dragged.paneId, neighbor.paneId],
    layout: null,
    // Fresh split opens focused on the dragged panel (parity with
    // the server op, which seeds the same memory).
    focusedPaneId: dragged.paneId,
  };
  // The dragged panel sits at the release quadrant; the neighbor
  // fills the other half.
  group.layout = { kind: axis, sizes: [1, 1], children: draggedFirst ? [dragged.paneId, neighbor.paneId] : [neighbor.paneId, dragged.paneId] };
  root.groups.push(group);
  dragged.groupId = group.groupId;
  neighbor.groupId = group.groupId;
  setVisibleSubject("group", group.groupId);
  focusLeaf(root, dragged);
  return true;
}

// Group subject: the dragged ungrouped panel joins the visible group
// at the previewed quadrant inside the layout.
function growVisibleGroupWith(dragged, axis, draggedFirst) {
  const root = paneRootFor();
  const subject = visibleSubject(root);
  if (!subject || subject.kind !== "group" || dragged.groupId) return false;
  const group = subject.group;
  return panesOpWithFallback(
    {
      op: "group.grow",
      groupId: group.groupId,
      paneId: dragged.paneId,
      axis,
      draggedFirst,
      hostPaneId: dropHostPaneId || undefined,
    },
    () => localGrowVisibleGroupWith(dragged, group, axis, draggedFirst),
  );
}

function localGrowVisibleGroupWith(dragged, group, axis, draggedFirst) {
  const root = paneRootFor();
  group.memberIds.push(dragged.paneId);
  dragged.groupId = group.groupId;
  group.layout = layoutWithPanelAt(group.layout, dragged.paneId, axis, draggedFirst);
  focusLeaf(root, dragged);
  return true;
}

// ---- one-view-per-flat-panel split engine -------------------------------
// A flat panel holds at most one view. Every creator that would push a
// second view into a busy leaf instead SPLITS: the old view keeps its
// panel, a fresh member mints beside it (row axis: old left, new right)
// and takes the focus. A busy MEMBER of a group grows the split the
// same way, seated next to the busy member. The terminal placeholder
// is not a view: a placeholder-only leaf counts as free.
function leafBusyViews(leaf) {
  return ((leaf && leaf.tabs) || []).filter((id) => id !== TERMINAL_TAB_PLACEHOLDER).length;
}

// Tab-landing applyView shared by the creators: the view lands in the
// fresh member and its pointer follows. Pure leaf surgery, no render
// or save: the split engine's settle tail owns both, so the group and
// the tab never appear out of sync.
function landTabIntoLeaf(leaf, tabId) {
  if (!leaf || !tabId) return false;
  if (leaf.tabs.includes(tabId)) {
    leaf.active = tabId;
    return true;
  }
  leaf.tabs.push(tabId);
  leaf.active = tabId;
  disarmLeafAutoClose(leaf);
  return true;
}

// Split entry point. Returns the fresh member leaf, null when the
// gesture could not land (already announced), or PANES_OP_REJECTED
// when the server refused it (the resync already painted server
// truth; the caller must not touch local state). The fresh member
// binds the host's workspace unless wsIdOverride names another one
// (the picker path lands a panel in a picked workspace).
async function splitLeafWithFreshMember(leaf, applyView, wsIdOverride) {
  if (!leaf) return null;
  const group = groupForLeaf(paneRootFor(), leaf);
  if (!group) return splitFlatHost(leaf, applyView, wsIdOverride);
  return splitGroupedHost(leaf, group, applyView, wsIdOverride);
}

// The fresh panel minted by a server panel.create: the op response
// adopts the entry, and the new id is the one the panel list gained
// (known ids snapshotted before the op). Exactly one gain is the
// answer; anything else means a broadcast raced the gesture.
function adoptedFreshPanel(knownIds) {
  const gained = paneLeaves(paneRootFor()).filter((l) => !knownIds.has(l.paneId));
  return gained.length === 1 ? gained[0] : null;
}

// Server mint prologue shared by splitFlatHost and splitGroupedHost:
// panel.create mints the fresh member, the adopted panel must be exactly
// one new id (else the gesture raced a broadcast). Returns the fresh leaf,
// PANES_OP_REJECTED when the server refused, null when nothing landed
// (already announced), or false when the op transport failed (the caller
// falls back to its local twin).
async function splitMintFresh(targetWs) {
  const known = new Set(paneLeaves(paneRootFor()).map((l) => l.paneId));
  const mint = await panesServerOp({ op: "panel.create", wsId: targetWs });
  if (mint === PANES_OP_REJECTED) return PANES_OP_REJECTED;
  if (!mint) return false;
  const freshMint = adoptedFreshPanel(known);
  if (!freshMint) {
    announcePaneChanges("Could not place the new view");
    return null;
  }
  return freshMint;
}

// Flat host. Server: panel.create mints the fresh member bound to the
// host's workspace, then group.create wraps [host, fresh] with the
// fresh member focused and the group visible (dragged = the fresh
// panel, neighbor = the host, draggedFirst false = host LEFT). Local
// mode and a demoted session run the local twin; a REJECTED op is
// server truth: no local surgery, no view.
async function splitFlatHost(leaf, applyView, wsIdOverride) {
  const targetWs = wsIdOverride || leafWorkspaceId(leaf) || undefined;
  const localTwin = (preMinted) => {
    const rootNow = paneRootFor();
    const host = paneForPaneId(rootNow, leaf.paneId);
    if (!host) return null;
    const fresh = preMinted || mintPanelForWorkspace(targetWs || null, host);
    if (!fresh || !rootNow.panels.includes(fresh)) return null;
    const group = {
      groupId: newGroupId(),
      name: null,
      memberIds: [host.paneId, fresh.paneId],
      layout: { kind: "row", sizes: [1, 1], children: [host.paneId, fresh.paneId] },
      focusedPaneId: fresh.paneId,
    };
    rootNow.groups.push(group);
    host.groupId = group.groupId;
    fresh.groupId = group.groupId;
    return settleSplitView(host, fresh, applyView);
  };
  if (panesMode !== "server" || !panesServerReachable()) return localTwin(null);
  const freshMint = await splitMintFresh(targetWs);
  if (freshMint === PANES_OP_REJECTED) return PANES_OP_REJECTED;
  if (!freshMint) return freshMint === null ? null : localTwin(null);
  const create = await panesServerOp({
    op: "group.create",
    paneId: freshMint.paneId,
    neighborPaneId: leaf.paneId,
    axis: "row",
    draggedFirst: false,
  });
  if (create === PANES_OP_REJECTED) {
    dropFreshSplitMember(freshMint.paneId);
    return PANES_OP_REJECTED;
  }
  // Transport failure after a successful mint: the session demoted to
  // local, so the twin adopts the already-minted panel instead of
  // minting a second one.
  if (!create) return localTwin(freshMint);
  const rootNow = paneRootFor();
  const hostNow = paneForPaneId(rootNow, leaf.paneId);
  const freshNow = paneForPaneId(rootNow, freshMint.paneId);
  if (!hostNow || !freshNow || !hostNow.groupId || freshNow.groupId !== hostNow.groupId) {
    announcePaneChanges("Could not place the new view");
    return null;
  }
  return settleSplitView(hostNow, freshNow, applyView);
}

// Member host. The sync ladder can home an id into any bound leaf, so
// the busy member's group may be PARKED: group.grow only runs on the
// visible subject, so a parked group opens first (subject.set).
// Server: panel.create mints, the subject opens when parked, then
// group.grow seats the fresh member beside the busy member.
async function splitGroupedHost(leaf, group, applyView, wsIdOverride) {
  const targetWs = wsIdOverride || leafWorkspaceId(leaf) || undefined;
  const localTwin = (preMinted) => {
    const rootNow = paneRootFor();
    const host = paneForPaneId(rootNow, leaf.paneId);
    const groupNow = groupById(rootNow, group.groupId);
    if (!host || !groupNow) return null;
    const fresh = preMinted || mintPanelForWorkspace(targetWs || null, host);
    if (!fresh || !rootNow.panels.includes(fresh)) return null;
    fresh.groupId = groupNow.groupId;
    groupNow.memberIds.push(fresh.paneId);
    // Seat beside the busy member: layoutWithPanelAt reads the drop
    // host, so pin it for the call and restore it after (the drag
    // paths set the same global before their own surgery).
    const prevHost = dropHostPaneId;
    dropHostPaneId = leaf.paneId;
    groupNow.layout = layoutWithPanelAt(groupNow.layout, fresh.paneId, "row", false);
    dropHostPaneId = prevHost;
    return settleSplitView(host, fresh, applyView);
  };
  if (panesMode !== "server" || !panesServerReachable()) return localTwin(null);
  const freshMint = await splitMintFresh(targetWs);
  if (freshMint === PANES_OP_REJECTED) return PANES_OP_REJECTED;
  if (!freshMint) return freshMint === null ? null : localTwin(null);
  if (!visibleSubjectIsGroup(paneRootFor(), group.groupId)) {
    const vis = await panesServerOp({ op: "subject.set", visible: { type: "group", id: group.groupId } });
    if (vis === PANES_OP_REJECTED) {
      dropFreshSplitMember(freshMint.paneId);
      return PANES_OP_REJECTED;
    }
    if (!vis) return localTwin(freshMint);
  }
  const grow = await panesServerOp({
    op: "group.grow",
    groupId: group.groupId,
    paneId: freshMint.paneId,
    axis: "row",
    draggedFirst: false,
    hostPaneId: leaf.paneId,
  });
  if (grow === PANES_OP_REJECTED) {
    dropFreshSplitMember(freshMint.paneId);
    return PANES_OP_REJECTED;
  }
  if (!grow) return localTwin(freshMint);
  const rootNow = paneRootFor();
  const hostNow = paneForPaneId(rootNow, leaf.paneId);
  const freshNow = paneForPaneId(rootNow, freshMint.paneId);
  if (!hostNow || !freshNow || freshNow.groupId !== group.groupId) {
    announcePaneChanges("Could not place the new view");
    return null;
  }
  return settleSplitView(hostNow, freshNow, applyView);
}

// Shared tail: the view lands in the fresh member (applyView owns the
// tab push; a falsy answer means nothing landed and the fresh member
// drops), then the fresh member takes focus under the split subject.
function settleSplitView(host, fresh, applyView) {
  if (applyView && !applyView(fresh)) {
    dropFreshSplitMember(fresh.paneId);
    return null;
  }
  const root = paneRootFor();
  disarmLeafAutoClose(host);
  disarmLeafAutoClose(fresh);
  const group = groupForLeaf(root, fresh);
  if (group) setVisibleSubject("group", group.groupId, { groupId: group.groupId, focusedPaneId: fresh.paneId });
  focusLeaf(root, fresh);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return fresh;
}

// Cleanup when a fresh split member never landed its view: the panel
// closes through the real close path (server op, local twin, group
// surgery), so no empty second panel and no under-two group survive.
function dropFreshSplitMember(freshPaneId) {
  const leaf = paneForPaneId(paneRootFor(), freshPaneId);
  if (!leaf) return;
  if (!dropLeafFromTree(leaf)) return;
  // The local twin splices the member but leaves the group record;
  // the sweep dissolves it and heals the subject.
  sweepAbandonedEmptyLeaves();
  renderWorkspacePanes();
}

// Deferred homing splits (one view per flat panel): a homeless terminal
// id whose home leaf is busy splits the home instead of stacking. The
// sync runs inside the render pass, so the split (whose settle repaints)
// must leave that pass: the id stays homeless this tick, the queued
// task lands it through the full engine, and the dedupe set keeps a
// sync tick that fires while the task is in flight from double-splitting.
const pendingHomingSplits = new Set();

function queueHomingSplit(homePaneId, wsId, tabId) {
  const key = String(tabId);
  if (pendingHomingSplits.has(key)) return;
  pendingHomingSplits.add(key);
  const run = async () => {
    try {
      const root = paneRootFor();
      // Landed elsewhere already (placement race, broadcast): done.
      if (paneForTab(root, tabId)) return;
      const host = paneForPaneId(root, homePaneId);
      if (!host) return;
      const fresh = await splitLeafWithFreshMember(host, (target) => landTabIntoLeaf(target, tabId), wsId);
      if (fresh) return; // landed; REJECTED leaves server truth in charge
      // Split failed (announced): never strand the id, land it in the
      // host as the pre-invariant behavior did.
      if (!host.tabs.includes(tabId)) {
        host.tabs.push(tabId);
        if (!host.active) host.active = tabId;
        disarmLeafAutoClose(host);
        saveWorkspacePanesStates();
        renderWorkspacePanes();
      }
    } finally {
      pendingHomingSplits.delete(key);
    }
  };
  // Sandbox harnesses (node --test without a timer global) still need
  // the invariant: fire the split now instead of deferring. The browser
  // keeps the deferred path so the sync render pass never awaits.
  if (typeof setTimeout !== "function") { void run(); return; }
  setTimeout(run, 0);
}

// Member re-position inside the visible group (strip chip drag): the
// dragged view moves beside the release host at the previewed quadrant.
// Same dispatch shape as ungroupMember; the server owns the op name
// group.move, the local twin runs the same surgery on the local entry.
function repositionGroupMember(paneId, hostPaneId, axis, draggedFirst) {
  const root = paneRootFor();
  const dragged = paneForPaneId(root, paneId);
  const group = groupForLeaf(root, dragged);
  if (!dragged || !group) return false;
  return panesOpWithFallback(
    {
      op: "group.move",
      groupId: group.groupId,
      paneId,
      hostPaneId,
      axis,
      draggedFirst,
    },
    () => {
      const groupNow = groupForLeaf(paneRootFor(), paneId);
      if (!groupNow) return false;
      const removed = memberLayoutWithout(groupNow.layout, paneId);
      dropHostPaneId = hostPaneId;
      groupNow.layout = removed === null ? paneId : layoutWithPanelAt(removed, paneId, axis, draggedFirst);
      dropHostPaneId = null;
      return true;
    },
  );
}

// Layout insertion: the new paneId lands at the quadrant the release
// named, relative to the quadrant's host pane (the pane under the
// pointer). Same-kind hosts extend, other-kind hosts nest, the old
// split mechanics carried over for group layouts only.
function layoutWithPanelAt(layout, paneId, axis, first) {
  const hostId = layoutHostPaneIdUnderPointer();
  if (layout === null || typeof layout === "string" || !isPaneSplit(layout)) {
    // Flat or degraded layout: rebuild as a flat split with the new
    // panel at the requested end.
    const ids = Array.isArray(layout) ? layout.slice() : (layout ? [layout] : []);
    const others = ids.filter((id) => id !== paneId);
    if (!others.length) others.push(paneId === (ids[0] || paneId) ? paneId : ids[0] || paneId);
    const children = first ? [paneId, ...others] : [...others, paneId];
    return { kind: axis, sizes: children.map(() => 1), children };
  }
  const hostIds = collectLayoutPaneIds(layout);
  const host = (hostId && hostIds.includes(hostId)) ? hostId : hostIds[0];
  const slot = findLayoutSlotFor(layout, host);
  if (!slot) {
    const children = first ? [paneId, ...collectLayoutPaneIds(layout)] : [...collectLayoutPaneIds(layout), paneId];
    return { kind: axis, sizes: children.map(() => 1), children };
  }
  if (slot.parent === null) {
    // Layout root IS the host pane (a lone paneId wrapped): wrap it.
    return { kind: axis, sizes: [1, 1], children: first ? [paneId, layout] : [layout, paneId] };
  }
  const parent = slot.parent;
  if (parent.kind === axis) {
    // Extend the same-axis parent at the host index.
    const share = Math.max(1, (parent.sizes && parent.sizes[slot.index]) || 1) / 2;
    parent.children.splice(first ? slot.index : slot.index + 1, 0, paneId);
    if (!Array.isArray(parent.sizes)) parent.sizes = parent.children.map(() => 1);
    parent.sizes.splice(first ? slot.index : slot.index + 1, 0, share);
    parent.sizes[first ? slot.index + 1 : slot.index] = share;
    return layout;
  }
  // Nest under the host.
  parent.children[slot.index] = {
    kind: axis,
    sizes: [1, 1],
    children: first ? [paneId, host] : [host, paneId],
  };
  return layout;
}

// The pane under the drag pointer at drop time (layout host). Set by
// paneContainerTabDrop before the layout surgery reads it; the dragover
// preview already resolved the same host through panelDropTargetAt.
let dropHostPaneId = null;

function layoutHostPaneIdUnderPointer() {
  return dropHostPaneId || null;
}

function collectLayoutPaneIds(node) {
  if (!node) return [];
  if (typeof node === "string") return [node];
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap((child) => collectLayoutPaneIds(child));
}

// Host slot lookup in a layout tree: {parent, index} where parent is
// the split node holding the host paneId at children[index], or
// {parent: null} when the layout IS the host.
function findLayoutSlotFor(node, hostId) {
  if (typeof node === "string") return node === hostId ? { parent: null } : null;
  if (!node || !Array.isArray(node.children)) return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === hostId) return { parent: node, index: i };
    const found = findLayoutSlotFor(child, hostId);
    if (found) return found;
  }
  return null;
}

function paneStripDragOver(event) {
  const drag = activeDragKind();
  if (!drag) return;
  // A member drag transiting a strip paints nothing: the caret is a
  // TAB affordance, and the member's landing zones (pane quadrant,
  // rail) keep their own previews. No preventDefault either, so the
  // strip never arms itself as a drop target for the member payload.
  if (drag.kind === "member") return;
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
}

function paneStripDrop(event) {
  const drag = activeDragKind()
    || (event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  const pane = event.target && event.target.closest ? event.target.closest(".workspace-pane") : null;
  if (drag && drag.kind === "member") {
    // A member release over a strip is a gesture miss: the member's
    // landing zones are the pane quadrant and the rail. Clean the drag
    // state, no surgery.
    paneMemberDragEnd();
    return;
  }
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
  // Recompute the caret index from the release coordinates instead of
  // trusting strip.dataset.dropIndex: the strip may have re-rendered
  // (losing the dataset) or the pointer kept moving after the last
  // dragover, so a cached index lands the tab in a stale slot.
  const index = strip ? paneDropIndexAt(strip, event, tabId) : NaN;
  // v3.2 marker ownership: the emptying gesture decides, the move is
  // pure tree surgery. A same-pane drop is a reorder (renders itself);
  // a cross-pane strip drop arms its emptied source BEFORE the single
  // render so the sweep folds it in this same paint, not the next one.
  // One view per flat panel (strip-drop edition): a drop into a BUSY
  // member never stacks. The dropped id grows the split through the
  // same engine the creators use, so the invariant holds here too.
  // The identity rule only rejects the no-op self-drop (the id would
  // move into the leaf that already holds it), not the legitimate
  // arrival into a busy leaf.
  const rootBeforeMove = paneRootFor();
  const source = tabId ? paneForTab(rootBeforeMove, tabId) : null;
  const dropIndex = Number.isFinite(index) ? index : null;
  if (!source || source.paneId === paneId) {
    movePaneTabTo(tabId, paneId, dropIndex);
    return;
  }
  const targetLeaf = paneId ? paneForPaneId(rootBeforeMove, paneId) : null;
  if (targetLeaf && leafBusyViews(targetLeaf)) {
    void movePaneTabViaSplit(tabId, targetLeaf);
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
  source.active = source.tabs[0] || null;
  // Refill protocol: the pane receiving the tab sheds any stale arm.
  disarmLeafAutoClose(target);
  // Keep the active pointer on the pane receiving the tab: the next
  // sidebar open lands there, matching a click on the moved tab.
  focusLeaf(root, target);
  saveWorkspacePanesStates();
  // Cross-leaf move: server mode pushes the tabs delta per affected
  // leaf (same payload shape as the sync tail push) so the server entry
  // holds the authoritative arrays. Fire-and-forget: a lost push
  // re-derives on the next sync pass.
  if (panesMode === "server") {
    for (const leaf of [source, target]) {
      void panesServerOp({
        op: "panel.update",
        paneId: leaf.paneId,
        tabs: (leaf.tabs || []).slice(),
        active: leaf.active || undefined,
        wsId: leafWorkspaceId(leaf) || undefined,
      });
    }
  }
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

// One view per flat panel: a strip drop aiming at a BUSY leaf does not
// stack. The dropped id leaves its source leaf, then grows the split
// beside the busy target through the shared engine (parity with every
// creator: paneEnsureEditorTab, the sync homing split, landTabIntoLeaf).
// The busy target keeps every view it holds; the dropped id lands in a
// fresh member and the group stays one-view-per-member.
// Splice-then-split, never split-then-splice: the split engine renders
// its own settle tail, so the id must leave its source BEFORE that
// paint; landing it afterwards would keep the old owner leaf rendering
// a view that no longer belongs to it, and a demoted local twin's
// settle would render while the id still sits in its old home.
// The engine answers REJECTED (server truth; the resync painted), null
// (announced; the id already left, both halves stay live in place), or
// the fresh member. null takes the no-migration path below: every view
// must survive somewhere and no leaf ends stacked.
async function movePaneTabViaSplit(tabId, targetLeaf) {
  const root = paneRootFor();
  const source = paneForTab(root, tabId);
  if (!source || source === targetLeaf) return;
  const at = source.tabs.indexOf(tabId);
  if (at < 0) return;
  source.autoClosePre = autoClosePreStateFor(root, source);
  source.tabs.splice(at, 1);
  source.active = source.tabs[0] || null;
  // Server truth must learn the splice BEFORE any split op response
  // adopts an entry: the adopted entry would carry the id in its old
  // home and the settle's sync pass would hand it right back (one-owner
  // rule, first owner wins). Same fire-and-forget push movePaneTabTo
  // uses; a lost push re-derives on the next sync.
  if (panesMode === "server") {
    void panesServerOp({
      op: "panel.update",
      paneId: source.paneId,
      tabs: (source.tabs || []).slice(),
      active: source.active || undefined,
      wsId: leafWorkspaceId(source) || undefined,
    });
  }
  const fresh = await splitLeafWithFreshMember(targetLeaf, (candidate) => {
    if (candidate === source) return false;
    return landTabIntoLeaf(candidate, tabId);
  });
  if (fresh === PANES_OP_REJECTED) return;
  if (fresh) {
    // The settle already rendered and saved; the fresh member's delta
    // (the landed view) reaches the server on the next sync pass push,
    // same as every creator's split.
    return;
  }
  // Split failed (announced): never lose the view. The id returns to
  // its source at its old slot, the arm the splice earned stands (the
  // source was emptied by this gesture), and no push runs: the leaves
  // hold the same ids as before.
  const back = paneForTab(paneRootFor(), tabId) ? null : paneForPaneId(paneRootFor(), source.paneId);
  if (!back) return;
  const backAt = Math.min(at, back.tabs.length);
  back.tabs.splice(backAt, 0, tabId);
  back.active = tabId;
  armLeafAutoClose(back);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
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

// Encoded-paneId resolver for the inline strip handlers (✕ close, +
// new tab, Enter spawn): decode, resolve by id; an empty id means
// "the acting panel" (active leaf), a KNOWN id resolves to its leaf,
// and an unknown non-empty id resolves to nothing: the button belonged
// to a pane that no longer exists (stale strip after an adoption), and
// falling back to the active leaf there would close or mint into a
// random other panel.
function leafForPaneId(root, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  if (!paneId) return activeLeaf(root);
  return paneForPaneId(root, paneId) || null;
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
  if (typeof newTab !== "function") return;
  let target = leaf;
  if (leaf && leafBusyViews(leaf)) {
    // One view per flat panel: the + SPLITS a busy leaf. The fresh
    // empty member takes the placement and the backend id lands in
    // it on the next sync. A failed split keeps the placement on the
    // original leaf (the id lands in place, pre-invariant behavior).
    const fresh = await splitLeafWithFreshMember(leaf, () => true);
    if (fresh === PANES_OP_REJECTED) return;
    if (fresh) target = fresh;
  }
  if (target) {
    // Terminal ids are the only backend kind; remember where this one
    // belongs before the backend list lands.
    requestTabPlacement(target.paneId);
  }
  await newTab();
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
  let targetPaneId = paneId || null;
  if (paneId) {
    const root = paneRootFor();
    const leaf = paneTreeRenderable(root) ? leafForPaneId(root, paneId) : null;
    if (leaf && leafBusyViews(leaf)) {
      // One view per flat panel: a new panel in a busy pane SPLITS, the
      // fresh member binding the PICKED workspace (the picker's whole
      // point is cross-workspace placement). A failed split keeps the
      // placement on the original leaf.
      const fresh = await splitLeafWithFreshMember(leaf, () => true, workspaceId);
      if (fresh === PANES_OP_REJECTED) return;
      if (fresh) targetPaneId = fresh.paneId;
    }
  }
  if (targetPaneId) requestTabPlacement(targetPaneId);
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

// Closes the acting panel for real (stripless model): the panel record
// and every view it holds go, nothing merges into a neighbor. Each view
// closes through its own confirmation path first (terminal askQuestion,
// editor dirty confirm; git closes silent), so a cancel stops the whole
// close with the tree intact. After the views die, the panel drops via
// dropLeafFromTree; the last panel of a workspace keeps the workspace
// cascade (closeTab owns it for terminals, forgetWorkspacePanes for the
// record). Focus/visible healing stays with the sweep and visibleSubject.
async function closeActivePane() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return false;
  const leaf = activeLeaf(root);
  if (!leaf) return false;
  const leaves = paneLeaves(root);
  // Single-panel session: closing it would leave nothing to render.
  if (leaves.length <= 1) return false;
  // View-by-view close, each through its own confirm path. The closes
  // re-render; the doomed leaf's identity stays stable while its tabs
  // drain one by one.
  for (const tabId of [...leaf.tabs]) {
    if (tabId === TERMINAL_TAB_PLACEHOLDER) continue;
    const doomed = paneForPaneId(paneRootFor(), leaf.paneId);
    if (!doomed || !(doomed.tabs || []).includes(tabId)) continue;
    if (isEditorTab(tabId)) {
      await closeEditorTab(encodeURIComponent(editorTabPath(tabId)));
    } else if (isGitTab(tabId)) {
      closeGitTab(gitTabViewKey(tabId));
    } else {
      // Terminal rows own the backend panel: a real close rides the
      // tab close (confirm + POST + prune + sweep), exactly like the
      // tab strip ✕. closeTab owns the in-flight guard and the
      // workspace cascade for the workspace's last terminal. A dead
      // row (sync pruned it) has no backend panel left: prune the id
      // here so the panel can still drop.
      if (typeof closeTab === "function" && terminalTabKnown(tabId)) {
        await closeTab(tabId);
      } else {
        pruneClosedTabFromLeaf(tabId);
      }
    }
    // A canceled confirm leaves the view standing: the panel close
    // stops here, tree untouched. The leaf itself vanishing mid-loop
    // (sweep or workspace cascade) is the close finishing another way.
    const after = paneRootFor();
    const drained = paneForPaneId(after, leaf.paneId);
    if (!drained) return true;
    if ((drained.tabs || []).includes(tabId)) return false;
  }
  // Placeholder-only or fully drained: drop the panel record. The
  // workspace cascade (closeTab on the workspace's last terminal) may
  // have removed the leaf already through forgetWorkspacePanes: that
  // outcome IS the close, report success. A panel with only placeholder
  // views still needs the record drop; the sweep below owns the group
  // surgery and the subject heal.
  if (!paneForPaneId(paneRootFor(), leaf.paneId)) return true;
  const dropped = dropLeafFromTree(leaf);
  // Server mode: the op owns the splice; the sweep (group dissolve,
  // subject heal) only runs once the adoption landed. REJECTED means the
  // server kept the panel: report the close refused, nothing swept.
  if (dropped && typeof dropped.then === "function") {
    const settled = await dropped;
    if (settled === PANES_OP_REJECTED) return false;
    if (sweepAbandonedEmptyLeaves()) renderWorkspacePanes();
    return true;
  }
  if (!dropped) return false;
  if (sweepAbandonedEmptyLeaves()) renderWorkspacePanes();
  return true;
}

// Panel removal for the flat list: splice the panel out, drop it from
// any group (the group dissolves under two members through the sweep),
// heal the visible pointer. Returns false when nothing changed (panel
// already gone, or it is the last one, where dropping it would leave
// nothing to render).
function dropLeafFromTree(leaf, opts) {
  const entry = panesStateFor();
  if (!isPaneLeaf(leaf)) return false;
  const at = entry.panels.indexOf(leaf);
  if (at < 0) return false;
  if (entry.panels.length <= 1) return false;
  // Server owns the splice and the group surgery. The local mutation
  // runs when the op fails (the helper's fallback), and the op response
  // repaints through adoption. The doom read (paneId, group) happens
  // BEFORE anything mutates, mirroring the server's own
  // capture-before-remove rule.
  const doomedId = leaf.paneId;
  return panesOpWithFallback(
    { op: "panel.close", paneId: doomedId },
    () => localDropLeafFromTree(leaf),
    opts,
  );
}

function localDropLeafFromTree(leaf) {
  const entry = panesStateFor();
  if (!isPaneLeaf(leaf)) return false;
  const at = entry.panels.indexOf(leaf);
  if (at < 0) return false;
  if (entry.panels.length <= 1) return false;
  const group = groupForLeaf(entry, leaf);
  entry.panels.splice(at, 1);
  if (group) {
    const memberAt = group.memberIds.indexOf(leaf.paneId);
    if (memberAt >= 0) group.memberIds.splice(memberAt, 1);
    group.layout = memberLayoutWithout(group.layout, leaf.paneId);
  }
  entry.activePaneId = entry.activePaneId === leaf.paneId ? null : entry.activePaneId;
  const subject = visibleSubject(entry);
  entry.visible = subject && subject.kind === "group"
    ? { type: "group", id: subject.group.groupId }
    : { type: "panel", id: subject.leaf.paneId };
  if (entry.activePaneId === null && subject) entry.activePaneId = subject.kind === "group"
    ? (groupMembers(subject.group)[0] || {}).paneId || null
    : subject.leaf.paneId;
  saveWorkspacePanesStates();
  return true;
}

// Flat-model sweep: armed empty panels (emptied by a gesture) drop
// from the session, and a group left under two members dissolves (its
// remaining panel turns ungrouped). The focused panel and the last
// panel always survive.
function sweepAbandonedEmptyLeaves() {
  const root = paneRootFor();
  const protectedLeaf = activeLeaf(root);
  const protectedId = (protectedLeaf || {}).paneId || null;
  let changed = false;
  // Armed empty panels drop, one at a time, guards against loops.
  // The focused panel and the last panel survive by the checks below.
  let guard = 16;
  while (guard-- > 0) {
    const live = paneRootFor();
    const leaves = paneLeaves(live);
    if (leaves.length <= 1) break;
    const victim = leaves.find((leaf) => leaf.autoCloseArmed && !leaf.tabs.length && leaf.paneId !== protectedId);
    if (!victim) break;
    if (!dropLeafFromTree(victim)) break;
    changed = true;
  }
  // Group dissolve: a group under two members is not a group anymore.
  for (const group of [...(paneRootFor().groups || [])]) {
    if (groupMemberCount(group) >= 2) continue;
    // Survivor read BEFORE the record splice: the member list dies
    // with the record, and the heal below needs the surviving member,
    // not the panels[0] fallback.
    const survivor = groupMembers(group)[0] || null;
    const rootNow = paneRootFor();
    const wasVisible = !!(rootNow.visible && rootNow.visible.type === "group" && rootNow.visible.id === group.groupId);
    for (const member of groupMembers(group)) member.groupId = null;
    const at = paneRootFor().groups.indexOf(group);
    if (at >= 0) paneRootFor().groups.splice(at, 1);
    if (wasVisible && survivor) rootNow.visible = { type: "panel", id: survivor.paneId };
    changed = true;
  }
  // Visible heal: a dropped panel or dissolved group can leave the
  // pointer stale; visibleSubject's fallbacks own the repair.
  if (changed) {
    const live = paneRootFor();
    const subject = visibleSubject(live);
    live.visible = subject && subject.kind === "group"
      ? { type: "group", id: subject.group.groupId }
      : { type: "panel", id: subject.leaf.paneId };
    saveWorkspacePanesStates();
  }
  return changed;
}

// Auto-close arm/disarm (v3.2): only panels EMPTIED by a move, drop,
// or close auto-close; fresh panels (empty by design, Enter spawns
// there) never arm. The arm helper owns the emptiness guard; the
// marker clears when a panel gains tabs again, so a re-filled panel
// never closes.
function armLeafAutoClose(leaf) {
  if (leaf && !leaf.tabs.length) leaf.autoCloseArmed = true;
}

function disarmLeafAutoClose(leaf) {
  if (leaf) leaf.autoCloseArmed = false;
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
  // The pruned id changes the strip label count even when the panel
  // survives (no sweep change); callers only paint when the closed tab
  // was the route tab, and renderWorkspacePanes is signature-gated so
  // one paint here is idempotent.
  if (sweepAbandonedEmptyLeaves() || pruned) renderWorkspacePanes();
  return pruned;
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

// ---- default-label workspace prefix ---------------------------------
// Default panels number inside their own workspace, and a bare number
// names nothing: the worktree name rides every default label so two
// panels read "main 1", "feat/panels 1" instead of colliding "1"s.
// The prefix comes from the ROW's workspace (not the selected one), so
// it stays stable across a workspace switch. Custom names never get a
// prefix: the user named the panel, the name is the identity. A row
// whose workspace record is missing keeps the bare number (the display
// name needs the workspace record).
function workspacePrefixForTab(tabId) {
  const row = paneTerminalTabById(tabId);
  const workspaceId = (row && row.workspace_id) || state.ws;
  return workspacePrefixForWorkspaceId(workspaceId);
}

// The prefix for a known workspace id, shared by the row-lookup path and
// the direct-row callers (hover, title) that carry the id themselves.
function workspacePrefixForWorkspaceId(workspaceId) {
  if (!workspaceId) return "";
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
// label, prefix included. Hover title, document title, and the strip
// itself must never drift apart on a default panel. The row's own
// workspace_id wins over the id-by-tabId lookup: hover and title callers
// pass rows straight from the backend (they may never exist in state
// yet), and a state.ws fallback would stamp the wrong worktree on them.
function panelDisplayName(tab, index, tabs = state.tabs || []) {
  return panelVisibleLabel(tab, index, tabs);
}

function panelVisibleLabel(tab, index, tabs = state.tabs || []) {
  const label = String((tab && tab.label) || "").trim();
  if (isDefaultPanelTitle(label)) {
    const prefix = (tab && tab.workspace_id)
      ? workspacePrefixForWorkspaceId(tab.workspace_id)
      : workspacePrefixForTab(tab && tab.tab_id);
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
// The pane model only stores identity; the file browser module (ensured
// loaded before any real open) owns per-file state and mounts the editor
// container into the pane content slot.
function paneRootFor() {
  return panesStateFor();
}

// Location-bar + (collector): mint an empty panel for the FOCUSED
// panel's workspace, focus it. Returns the minted leaf, or null when
// no entry exists yet (the dashboard owns the center; the caller
// falls back to newTab()).
function newPanelForFocused() {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const anchor = activeLeaf(root);
  const wsId = anchor ? leafWorkspaceId(anchor) : null;
  if (panesMode === "server") {
    // Server mints the paneId: the returned entry names the new panel,
    // and the focus lands on the appended panel of the same ws (the
    // server appends, so it is the last panel bound like this).
    void panesServerOp({ op: "panel.create", wsId: wsId || undefined }).then((entry) => {
      if (!entry || entry === PANES_OP_REJECTED) {
        if (entry !== PANES_OP_REJECTED) {
          const fresh = mintPanelForWorkspace(wsId, anchor);
          if (fresh) {
            focusLeaf(paneRootFor(), fresh);
            saveWorkspacePanesStates();
            renderWorkspacePanes();
          }
        }
        return;
      }
      const panels = entry.panels || [];
      const fresh = panels[panels.length - 1];
      if (fresh) {
        focusLeaf(paneRootFor(), paneForPaneId(paneRootFor(), fresh.paneId));
        saveWorkspacePanesStates();
        renderWorkspacePanes();
      }
    });
    return null;
  }
  const fresh = mintPanelForWorkspace(wsId, anchor);
  if (!fresh) return null;
  focusLeaf(paneRootFor(), fresh);
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return fresh;
}

// One view per flat panel: a creator landing a view the active leaf
// does not own SPLITS instead of pushing. The applyView pushes the
// tab id into the fresh member and points its active there; a falsy
// split answer (gesture failed, server refused) lands nothing, the
// caller proceeds with its module open over the ORIGINAL leaf.
async function paneEnsureEditorTab(path) {
  return paneEnsureTabId(editorTabId(path));
}

// Shared core of paneEnsureEditorTab and paneEnsureGitTab: owner lookup and
// focus, free/busy landing of the tab id, PANES_OP_REJECTED propagation, and
// the in-place degrade when a split fails. Returns the owner/fresh/leaf the
// tab landed in, PANES_OP_REJECTED on server refusal, or null when no tree.
async function paneEnsureTabId(tabId) {
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  // A tab id belongs to one leaf. An open request while another leaf
  // owns the id (strip click on a non-active pane, drawer nav) must
  // focus that leaf, not mint a second tab: a duplicate id desyncs the
  // strip from the container mount and leaves one pane blank. The
  // pointer move holds even when the module open bails later
  // (closed drawer, load failure).
  const owner = paneForTab(root, tabId);
  if (owner) {
    owner.active = tabId;
    focusLeaf(root, owner);
    saveWorkspacePanesStates();
    renderWorkspacePanes();
    if (typeof syncWorkspaceEmptyLeaf === "function") syncWorkspaceEmptyLeaf();
    return owner;
  }
  const leaf = activeLeaf(root);
  if (!leaf) return null;
  if (!leaf.tabs.includes(tabId)) {
    if (!leafBusyViews(leaf)) {
      // Free flat leaf (or placeholder-only): the first view lands in
      // place, exactly as before.
      leaf.tabs.push(tabId);
      leaf.active = tabId;
      disarmLeafAutoClose(leaf);
      saveWorkspacePanesStates();
      renderWorkspacePanes();
    } else {
      // Busy leaf: split. The old view keeps its panel, the new view
      // lands RIGHT, focused. The split rendered already (settle tail).
      // A falsy split answer (gesture failed, server refused) lands
      // nothing, the caller proceeds with its module open over the
      // ORIGINAL leaf.
      const fresh = await splitLeafWithFreshMember(leaf, (target) => landTabIntoLeaf(target, tabId));
      if (fresh === PANES_OP_REJECTED) return PANES_OP_REJECTED;
      if (fresh) return fresh;
      // Split failed (announced where the engine could): degrade to
      // the old in-place landing so the module mount still finds a
      // recorded tab id, else setActivePaneTab would point active at a
      // non-member id and the next sync heal would wipe it.
      leaf.tabs.push(tabId);
      leaf.active = tabId;
      disarmLeafAutoClose(leaf);
      saveWorkspacePanesStates();
      renderWorkspacePanes();
      return leaf;
    }
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
  editorOpensInFlight.add(id);
  const leaf = await paneEnsureEditorTab(id);
  // null covers the no-tree boot (dashboard): the old flow still opened
  // the file through the module. Only a server rejection bails.
  if (leaf === PANES_OP_REJECTED) return;
  const registry = await ensureFileBrowserModule();
  if (!registry || !registry.openEditorTab) {
    // Module failed to load: drop the placeholder so the strip does not
    // keep a dead tab around.
    closeEditorTabImmediate(encodeURIComponent(id));
    return;
  }
  try {
    await registry.openEditorTab(id, searchHighlight || null);
  } finally {
    editorOpensInFlight.delete(id);
  }
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
async function paneEnsureGitTab(viewKey) {
  return paneEnsureTabId(gitTabId(viewKey));
}

async function ensureGitUiModule() {
  // Same bare-function guard as the file browser: the loader lives in the
  // concatenated bundle scope; standalone-VM tests boot without it.
  if (typeof ensureGitUiLoaded === "function") await ensureGitUiLoaded();
  return window.HerdrGitUi;
}

async function openGitTab(viewKey) {
  if (!viewKey) return;
  const leaf = await paneEnsureGitTab(String(viewKey));
  // null covers the no-tree boot: the old flow still opened the view
  // through the module. Only a server rejection bails.
  if (leaf === PANES_OP_REJECTED) return;
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
  editorOpensInFlight.add(path);
  const registry = await ensureFileBrowserModule();
  try {
    if (registry && registry.openEditorTab) {
      await registry.openEditorTab(path);
      return;
    }
  } finally {
    editorOpensInFlight.delete(path);
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
  const root = paneRootFor();
  // A tab click on a panel whose subject is hidden (grouped behind a
  // chip, or another rail label) switches the subject to its owner
  // first: the open paths below must target the clicked tab's own
  // panel. The same-tab early return below never re-renders, so the
  // subject switch renders here.
  const owner = paneForTab(root, tabId);
  if (owner) {
    const subject = visibleSubject(root);
    const ownerVisible = subject && subject.kind === "panel" && subject.leaf === owner;
    const ownerInVisibleGroup = !!(subject && subject.kind === "group"
      && groupMembers(subject.group).includes(owner));
    if (!ownerVisible && !ownerInVisibleGroup) {
      // Same memory rule as a rail member press: viewing a hidden
      // member remembers it for the group chip's reopen.
      const ownerGroup = groupForLeaf(root, owner);
      setVisibleSubject("panel", owner.paneId,
        ownerGroup ? { groupId: ownerGroup.groupId, focusedPaneId: owner.paneId } : null);
      focusLeaf(paneRootFor(), owner);
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
  const subject = visibleSubject(root);
  let pane = null;
  if (subject && subject.kind === "group") {
    const leaf = activeLeaf(root) || groupMembers(subject.group)[0];
    pane = leaf ? paneLeafElement(container, root, leaf) : null;
  } else {
    pane = [...container.children].find((child) => hasClass(child, "workspace-pane"));
    if (!pane && subject) {
      pane = createPaneElement(subject.leaf.paneId || "root");
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
  const html = `<h1>${escapeHtml(name || wsId || "Empty panel")}</h1>`
    + `<p>No terminal in this panel yet.</p>`
    + `<p class="workspace-empty-leaf-hint">Press <kbd>Enter</kbd> to open a terminal.</p>`
    + `<button class="workspace-empty-leaf-new" title="${escapeAttr(newTitle)}" aria-label="${escapeAttr(newTitle)}" onclick="event.preventDefault();newTabForPane('${escapeHandlerArg(encodeURIComponent(leaf.paneId))}')">New terminal</button>`;
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
    } else if (activeTab && isEditorTab(activeTab)) {
      // Reload rehydration: a persisted editor tab survives the tree but
      // its container never existed in this document, so the claim found
      // nothing and the pane rendered an empty slot. The in-flight set
      // keeps the pass out of a live open's way (that open owns its own
      // fetch and mount); after a reload the set is empty and the tab
      // rehydrates through the funnel. One attempt per leaf and path; a
      // refused fetch (deleted file) must not loop the render.
      const rehydratePath = editorTabPath(activeTab);
      const triedKey = "__herdrEditorRehydrated:" + rehydratePath;
      if (rehydratePath && !leaf[triedKey] && !editorOpensInFlight.has(rehydratePath)) {
        leaf[triedKey] = true;
        editorOpensInFlight.add(rehydratePath);
        void (async () => {
          try {
            const registry = await ensureFileBrowserModule();
            if (registry && registry.openEditorTab) await registry.openEditorTab(rehydratePath);
          } catch (_) {
            // A failed fetch leaves the tab listed but contentless; the
            // claim pass runs again on the next render and the one-shot
            // flag keeps it from hammering the endpoint.
          } finally {
            editorOpensInFlight.delete(rehydratePath);
          }
        })();
      }
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

// Maps a split element back to its group layout node via the splitId
// chain and stores the dragged sizes. The splitId path encodes the
// layout position, so the lookup walks the same path the renderer used.
function writeDividerSizes(splitElement, sizes) {
  const root = paneRootFor();
  const subject = visibleSubject(root);
  const layout = subject && subject.kind === "group" ? subject.group.layout : null;
  const path = String(splitElement.dataset.splitId || "");
  const node = layout ? findSplitByPath(layout, path) : null;
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
  // Phase 4 surface. paneLeaves/activePane expose the flat panel walk;
  // consumers keep the names.
  paneLeaves,
  paneRootFor,
  paneTabsForTree,
  paneWorkspaceBadgeHtml,
  workspaceIdForTab,
  foreignWorkspacePrefix: workspacePrefixForTab,
  panelVisibleLabel,
  panelDisplayName,
  panelNumberLabel,
  panelRenameInitialLabel,
  activePane: () => activeLeaf(paneRootFor()),
  activePaneElement,
  closeActivePane,
  // The [⋮] kind-aware pane menu.
  togglePaneMenu,
  closePaneMenu,
  // Tab drag between member strips.
  movePaneTabTo,
  paneDropIndexAt,
  // Drag pipeline entry points (the strip listeners call these; tests
  // drive them directly because the vm DOM stub does not store listeners).
  paneStripDragOver,
  paneStripDrop,
  // Rail label drag pipeline (container wiring + drop).
  paneLabelDragStart,
  paneLabelDragEnd,
  // Strip chip HTML (split-only) + member chip drag pipeline (group
  // view: re-position inside the split, rail drop ungroups).
  panePanelChipHtml,
  paneMergedHeaderHtml,
  ungroupPaneMember,
  memberHeaderKey,
  paneMemberDragStart,
  paneMemberDragEnd,
  paneStripMemberDragStart,
  paneRailMemberDrop,
  paneContainerTabDragOver,
  paneContainerTabDrop,
  showPanelFromRail,
  showGroupFromRail,
  rememberGroupFocus,
  closePaneFor,
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
  // focused panel for the focused panel's workspace. dropLeafFromTree
  // removes a panel whatever it holds (explicit close cascade + ws-close
  // teardown).
  newPanelForFocused,
  dropLeafFromTree,
  leafWorkspaceId,
  leavesBoundTo,
  focusedLeaf,
  writeRouteFromLeaf,
  focusPanelFor,
  // Location bar ungroup wiring: the bar module owns the DOM, this
  // module owns the group surgery the bar drop triggers.
  paneTabUnsplitHover,
  paneTabUnsplitDrop,
  // Group rename trio (rail chip double-click).
  startPaneGroupRename,
  paneGroupRenameKey,
  commitPaneGroupRename,
  // Panel rename trio (rail chip double-click, same contract).
  startPanelChipRename,
  panelChipRenameKey,
  commitPanelChipRename,
  // Server sync (shared panes): boot adoption, op dispatch, broadcast
  // adoption. Tests drive these directly; the bundle calls bootFromServer
  // from bindings.js after connectEvents().
  bootFromServer: bootWorkspacePanesFromServer,
  applyRemoteEntry: applyRemoteWorkspacePanesEntry,
  adoptServerEntry: adoptServerPanesEntry,
  panesMode: () => panesMode,
  setPanesModeForTests: (mode) => { panesMode = mode === "server" ? "server" : "local"; },
  // Harness leaves hand-pushed by test seeds bypass the mint, so their
  // ids never reach usedPaneIds and a later mint can collide. Tests
  // register the seeded ids through the same set the mint guards on.
  registerPaneIdForTests: (paneId) => { if (paneId) usedPaneIds.add(String(paneId)); },
  // Op-layer unit hook: tests drive the rejection contract (a refused
  // intent must resync, never run the local twin) without a DOM gesture.
  panesOpWithFallbackForTests: (opPayload, localMutation, opts) => panesOpWithFallback(opPayload, localMutation, opts),
  // The rejection sentinel: callers/tests compare against this instead
  // of false, which a local twin can also legitimately return.
  panesOpRejectedForTests: PANES_OP_REJECTED,
  // Close-aftermath facade for cross-module terminal closes: prunes
  // the id from its leaf, sweeps armed+empty leaves, paints once.
  // The sweep and its guards stay inside this module.
  onTerminalTabClosed,
};
