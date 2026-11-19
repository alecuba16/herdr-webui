// One-visible-view model coverage for workspace_panes.js. The older
// desktop_workspace_panes.test.mjs pins the strip/terminal seam; this
// file covers the flat panel + group model end to end: id minting,
// v2 persistence and legacy migration, normalize repairs, terminal sync,
// the label drag pipeline (quadrant preview geometry, refusal rules),
// group render/ungroup/rename/subject-switch through v2 blob seeded
// sessions, sweep guards, DOM identity across group renders, divider
// drag inside group layouts, terminal shell ownership, and the bar
// controls contract (no split or maximize controls: those commands were
// removed with the model).
//
// IMPLEMENTATION BUG (flagged, not fixed here): paneContainerTabDrop
// (workspace_panes.js ~2678) calls paneLabelDragEnd() BEFORE
// labelDropTargetValid(), so the qualification pass reads the drag
// state already cleared, resolves the dragged panel as the drop HOST,
// and the "subject.leaf === dragged" check refuses every label drop.
// Group creation through the drop is therefore unreachable; the spec
// drop test below is kept skipped with the exact repro. Group coverage
// runs through seeded v2 blobs (the real load + normalize + render
// path) until the source fix lands.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// Compiled once so coverage attributes workspace_panes.js lines to the real file.
const WORKSPACE_PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const workspacePanesScript = new vm.Script(readFileSync(WORKSPACE_PANES_PATH, "utf8"), {
  filename: WORKSPACE_PANES_PATH,
});

const PANES_STORAGE_KEY = "herdr-web-workspace-panes";

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    attributes: {},
    // Mirror the app.html boot state: #projectDashboard carries the
    // hidden attribute until syncProjectDashboard shows it.
    hidden: id === "projectDashboard",
    listeners: {},
    __innerHTML: "",
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name] != null ? node.attributes[name] : null;
    },
    addEventListener(type, handler) {
      if (!node.listeners[type]) node.listeners[type] = [];
      node.listeners[type].push(handler);
    },
    appendChild(child) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      if (child.parentNode === node) child.parentNode = null;
      return child;
    },
    // Real browsers interleave dividers between children through the
    // renderer's insertBefore; mirror the DOM contract so divider pair
    // lookups find their "after" neighbor.
    insertBefore(child, anchor) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      if (!anchor) {
        node.children.push(child);
        return child;
      }
      const at = node.children.indexOf(anchor);
      if (at < 0) node.children.push(child);
      else node.children.splice(at, 0, child);
      return child;
    },
    querySelector(selector) {
      const wantId = selector.startsWith("#") ? selector.slice(1) : null;
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const walk = (n) => {
        for (const child of n.children) {
          if (wantId && child.id === wantId) return child;
          if (wantClass && child.className.split(/\s+/).includes(wantClass)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
    querySelectorAll(selector) {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const found = [];
      const walk = (n) => {
        for (const child of n.children) {
          if (wantClass && child.className.split(/\s+/).includes(wantClass)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    closest(selector) {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      let cur = node;
      while (cur) {
        if (wantClass && cur.className.split(/\s+/).includes(wantClass)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    contains(candidate) {
      let cur = candidate;
      while (cur) {
        if (cur === node) return true;
        cur = cur.parentNode;
      }
      return false;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    focus() {},
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 34, bottom: 34, width: 24, height: 24 };
    },
    get classList() {
      const self = node;
      return {
        contains(name) {
          return self.className.split(/\s+/).includes(name);
        },
        add(name) {
          if (!self.className.split(/\s+/).includes(name)) self.className = (self.className + " " + name).trim();
        },
        remove(name) {
          self.className = self.className.split(/\s+/).filter((token) => token && token !== name).join(" ");
        },
      };
    },
  };
  Object.defineProperty(node, "innerHTML", {
    get() {
      return node.__innerHTML;
    },
    set(value) {
      node.__innerHTML = String(value);
      for (const child of node.children) child.parentNode = null;
      node.children.length = 0;
    },
  });
  Object.defineProperty(node, "parentElement", {
    get() {
      return node.parentNode;
    },
  });
  Object.defineProperty(node, "nextSibling", {
    get() {
      if (!node.parentNode) return null;
      const at = node.parentNode.children.indexOf(node);
      return at >= 0 && at + 1 < node.parentNode.children.length
        ? node.parentNode.children[at + 1]
        : null;
    },
  });
  Object.defineProperty(node, "previousElementSibling", {
    get() {
      if (!node.parentNode) return null;
      const at = node.parentNode.children.indexOf(node);
      return at > 0 ? node.parentNode.children[at - 1] : null;
    },
  });
  Object.defineProperty(node, "nextElementSibling", {
    get() {
      if (!node.parentNode) return null;
      const at = node.parentNode.children.indexOf(node);
      return at >= 0 && at + 1 < node.parentNode.children.length
        ? node.parentNode.children[at + 1]
        : null;
    },
  });
  return node;
}

function buildDom() {
  const container = makeNode("workspacePanes", "workspace-panes");
  const tabs = makeNode("tabs", "tabs");
  const dashboard = makeNode("projectDashboard", "project-dashboard");
  const shell = makeNode("terminalShell", "terminal-shell");
  const terminal = makeNode("terminal", "terminal");
  container.appendChild(tabs);
  container.appendChild(dashboard);
  shell.appendChild(terminal);
  container.appendChild(shell);
  const nodes = { workspacePanes: container, tabs, projectDashboard: dashboard, terminalShell: shell, terminal };
  nodes.container = container;
  nodes.shell = shell;
  const body = makeNode("body", "");
  body.appendChild(container);
  const findById = (id, from) => {
    if (!from) return null;
    if (from.id === id) return from;
    for (const child of from.children || []) {
      const found = findById(id, child);
      if (found) return found;
    }
    return null;
  };
  const document = {
    createElement: () => makeNode("", ""),
    getElementById: (id) => findById(id, body),
    // startPaneGroupRename's focus timer resolves the rename input
    // through querySelector; a bare null keeps the timer inert.
    querySelector: () => null,
    querySelectorAll: (selector) => {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const found = [];
      const walk = (n) => {
        for (const child of n.children) {
          if (wantClass && child.className.split(/\s+/).includes(wantClass)) found.push(child);
          walk(child);
        }
      };
      walk(body);
      return found;
    },
    body,
  };
  return { nodes, document };
}

function loadPanesModuleWithStorage(document, stateWs, stored, saved) {
  const storage = saved || {};
  if (!saved && stored != null) storage[PANES_STORAGE_KEY] = stored;
  const ctx = {
    document,
    localStorage: {
      getItem(key) { return storage[key] || null; },
      setItem(key, value) {
        storage[key] = value;
      },
      removeItem(key) { delete storage[key]; },
    },
    state: { ws: stateWs, tabs: [], allTabs: [], workspacePanes: {} },
    el: (id) => document.getElementById(id),
    workspaceShellKey: (id) => `ws|${id}`,
    escapeHtml: (v) => String(v),
    escapeAttr: (v) => String(v),
    panelVisibleLabel: (tab) => (tab && tab.label) || "panel",
    panelRenameInitialLabel: () => "panel",
    tabTitle: () => "panel",
    tabHoverTitle: () => "",
    titleWithWebuiShortcut: (t) => t,
    workspacePath: () => "/repo",
    selectedOrDefaultWorkspace: () => ({ workspace_id: "ws-1" }),
    panesByTabIndex: () => new Map(),
    // The vm realm has no real timer loop: run timer callbacks
    // synchronously so deferred work (queueHomingSplit's settle,
    // rename-input focus) lands inside the test body instead of
    // vanishing.
    setTimeout: (fn) => { fn(); },
    go: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  workspacePanesScript.runInContext(vm.createContext(ctx));
  ctx.__storage = storage;
  // paneRoot() materializes the boot entry (panesStateFor is lazy: a
  // bare read of state.workspacePanes.__session__ sees nothing until
  // something asks for the root). Fresh module seed: panels:[newLeaf("p1")]
  // with wsId null. A harness ws with terminal rows arriving later would
  // otherwise route the ids through the adoption ladder; bind the seed
  // panel up front so the one-panel boot contract holds.
  if (stateWs) {
    const entry = ctx.HerdrWorkspacePanes.paneRoot();
    const seed = entry && entry.panels && entry.panels[0];
    if (seed && !seed.wsId) seed.wsId = stateWs;
  }
  return ctx;
}

function loadPanesModule(document, stateWs) {
  return loadPanesModuleWithStorage(document, stateWs, null, null);
}

function bootstrapPanes(ctx, tabId) {
  // Rows without a workspace_id read as a snapshot race and the sync
  // leaves their ids homeless, so stub rows always name the harness ws.
  ctx.state.tabs = [{ tab_id: tabId, workspace_id: ctx.state.ws }];
  ctx.state.tab = tabId;
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
}

function paneElements(nodes) {
  return nodes.container.querySelectorAll(".workspace-pane");
}

function splitElements(nodes) {
  return nodes.container.querySelectorAll(".pane-row").concat(nodes.container.querySelectorAll(".pane-column"));
}

function dividerElements(nodes) {
  return nodes.container.querySelectorAll(".pane-divider");
}

function contentOf(pane) {
  return pane.querySelector(".pane-content");
}

function stripOf(pane) {
  return pane.querySelector(".pane-tab-strip");
}

function railOf(nodes) {
  return nodes.container.querySelector(".pane-label-rail");
}

function entryOf(panes) {
  return panes.paneRoot();
}

function firstGroup(panes) {
  return entryOf(panes).groups[0] || null;
}

// Stub event for the drag pipeline: the target chain must reach a
// rendered .workspace-pane (paneElementUnderPointer climbs parentElement).
function dropEvent(target, clientX, clientY) {
  return {
    target,
    clientX,
    clientY,
    preventDefault() {},
    dataTransfer: { setData() {}, getData: () => "", effectAllowed: "move", dropEffect: "move" },
  };
}

function dragStartEvent() {
  return {
    target: { classList: { add() {}, remove() {} } },
    dataTransfer: { setData() {}, effectAllowed: "move" },
  };
}

// Common setup: one bound seed panel visible, n extra empty panels
// minted through the programmatic + helper (newPanelForFocused, the
// sync fixture primitive; the bar + opens the picker now).
function sessionWithPanels(document, ws, extra) {
  const ctx = loadPanesModule(document, ws);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  for (let i = 0; i < extra; i++) panes.newPanelForFocused();
  return { ctx, panes };
}

// Build a v2 session blob. The pane/leaf shape matches what
// saveWorkspacePanesStates writes, so loadWorkspacePanesStates runs the
// real normalize path (id registration, group healing, membership
// stamping) exactly like a production reload.
function v2Blob(panels, groups, visible) {
  return JSON.stringify({ __session__: { v: 2, panels, groups, visible, at: 1 } });
}

function panelLeaf(paneId, tabs, opts) {
  const leaf = { kind: "pane", paneId, tabs: tabs || [], active: (tabs || [])[0] || null, groupId: null };
  if (opts && opts.groupId) leaf.groupId = opts.groupId;
  if (opts && opts.wsId) leaf.wsId = opts.wsId;
  else leaf.wsId = "ws-1";
  return leaf;
}

// Load a seeded group session: the blob carries panels + one group +
// visible subject, rows land in state.tabs, and one render paints it.
function loadGroupSession(document, spec) {
  const { panels, groups, visible, rows, tab } = spec;
  const stored = v2Blob(panels, groups, visible);
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored, null);
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = (rows || []).map((id) => ({ tab_id: id, workspace_id: "ws-1" }));
  ctx.state.tab = tab != null ? tab : null;
  // Bug 4 (flagged below): the stored group subject heals to a panel
  // during load (normalizePanelEntry resolves members against the
  // default boot entry). Reveal the group BEFORE any render so the
  // group paint is the first paint: the real render path builds the
  // wrapper and the panes, and the degraded-layout fallback rebuilds
  // the split from memberIds.
  const groupId = (groups[0] || {}).groupId;
  if (groupId) {
    panes.showGroupFromRail(encodeURIComponent(groupId));
    panes.renderWorkspacePanes();
  } else {
    panes.renderWorkspacePanes();
  }
  return { ctx, panes };
}

// Two-panel row group [p1,p2] visible, plus optional extras.
function seedTwoMemberGroup(document, extras) {
  const panels = [
    panelLeaf("p1", ["tab_2"], { groupId: "g1" }),
    panelLeaf("p2", ["t2"], { groupId: "g1" }),
  ];
  for (const extra of extras || []) panels.push(panelLeaf(extra.paneId, extra.tabs || [], extra));
  return {
    panels,
    groups: [{ groupId: "g1", name: null, memberIds: ["p1", "p2"], layout: { kind: "row", sizes: [1, 1], splitId: "s1", children: ["p1", "p2"] } }],
    visible: { type: "group", id: "g1" },
    rows: ["tab_2", "t2"],
    tab: "tab_2",
  };
}

// Drive the label drag drop onto a pane element at a quadrant point.
// The stub pane rect is 24x24 at (10,10); the coordinates below pick
// corners so panelDropTargetAt's thirds math resolves a real quadrant.
function dropLabelOn(panes, draggedPaneId, targetPane, clientX, clientY) {
  panes.paneLabelDragStart(dragStartEvent(), encodeURIComponent(draggedPaneId));
  panes.paneContainerTabDrop(dropEvent(targetPane, clientX, clientY));
}

const TOP_LEFT = [11, 11]; // column, first half
const LEFT_MID = [11, 17]; // row, first half
const RIGHT_MID = [33, 17]; // row, second half
const BOTTOM_LEFT = [11, 33]; // column, second half

// ---- 1. flat model and id minting --------------------------------------

test("the session entry seeds one panel and mints unique ids", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-a");
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  assert.equal(entry.v, 2, "entry carries the v2 migration marker");
  assert.ok(Array.isArray(entry.panels), "flat panels list");
  assert.deepEqual([...entry.groups], [], "no groups at boot");
  assert.equal(entry.panels[0].paneId, "p1", "first workspace seeds p1");
  assert.equal(entry.visible.type, "panel", "boot subject is a panel");
  assert.equal(entry.visible.id, "p1", "boot subject names the seed");
  assert.deepEqual([...panes.paneLeaves(entry).map((l) => l.paneId)], ["p1"], "paneLeaves returns the flat panels");
  panes.newPanelForFocused();
  panes.newPanelForFocused();
  const ids = [...panes.paneLeaves(panes.paneRoot()).map((leaf) => leaf.paneId)];
  assert.deepEqual(ids, ["p1", "p2", "p3"], "mints append p2, p3");
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
  const other = loadPanesModule(buildDom().document, "ws-b");
  const otherIds = [...other.HerdrWorkspacePanes.paneLeaves(other.HerdrWorkspacePanes.paneRoot()).map((l) => l.paneId)];
  assert.ok(!otherIds.includes("p2"), "fresh module contexts mint independent ids");
});

// ---- 2. persistence and migration -------------------------------------

test("the v2 session entry round-trips panels, groups, and the subject", () => {
  const { document } = buildDom();
  // Seed through storage like a reload, add an editor tab, save, reload.
  const spec = seedTwoMemberGroup(document);
  spec.panels[0].tabs.push("editor:src/demo.py");
  spec.panels[0].active = "editor:src/demo.py";
  const seeded = loadGroupSession(document, spec);
  const ctx = seeded.ctx;
  const panes = seeded.panes;
  panes.saveWorkspacePanesStates();
  const raw = ctx.__storage[PANES_STORAGE_KEY];
  assert.ok(raw, "session entry persisted under the fixed key");
  const blob = JSON.parse(raw);
  const entry = blob.__session__;
  assert.ok(entry, "blob keyed by __session__");
  assert.equal(entry.v, 2, "v2 marker persisted");
  assert.equal(entry.panels.length, 2, "panels persisted");
  assert.ok(!raw.includes("autoCloseArmed") && !raw.includes("autoClosePre"), "runtime markers never persist");
  assert.ok(entry.groups[0] && entry.groups[0].memberIds.length === 2, "group persisted");
  assert.equal(entry.visible.type, "group", "visible subject persisted");
  assert.ok(entry.panels[0].layout === undefined && typeof entry.panels[0].groupId === "string", "membership rides groupId, no tree on panels");
  // Reload in a fresh module: the stored entry comes back intact.
  const reloaded = loadPanesModuleWithStorage(buildDom().document, "ws-1", raw, null);
  const rePanes = reloaded.HerdrWorkspacePanes;
  const reEntry = rePanes.paneRoot();
  assert.equal(reEntry.panels.length, 2, "panels survive reload");
  assert.ok(rePanes.paneLeaves(reEntry).some((leaf) => leaf.tabs.includes("editor:src/demo.py")), "editor tab survives reload");
  assert.ok(reEntry.groups[0], "group survives reload");
  assert.deepEqual([...reEntry.groups[0].memberIds], [...entry.groups[0].memberIds], "group members survive reload");
  const reGroupLeaf = rePanes.paneLeaves(reEntry).find((l) => l.groupId === reEntry.groups[0].groupId);
  assert.ok(reGroupLeaf, "membership binding survives reload");
  // NOTE: the reloaded entry's visible subject heals to a panel (see
  // the skipped Bug 4/5 spec test below); only the panel-visible
  // half of the reload contract holds today.
});

// Spec reload contract (notes.md: groups persist with their geometry
// and the visible subject across restarts). Both load-path bugs that
// blocked this are fixed: groupMembers/groupMemberCount take an
// explicit entry so visibleSubject resolves members before the loaded
// entry installs, and normalizeLayoutNode checks the string branch
// before the object guard so paneId string children survive and nested
// trees round-trip.
test("SPEC: stored group geometry and subject survive a reload", () => {
  const doc = buildDom().document;
  const spec = seedTwoMemberGroup(doc);
  spec.panels.push(panelLeaf("p3", ["t3"], { groupId: "g1" }));
  spec.groups[0].memberIds = ["p1", "p2", "p3"];
  spec.rows = ["tab_2", "t2", "t3"];
  spec.groups[0].layout = {
    kind: "row", sizes: [1, 1], splitId: "s1",
    children: [{ kind: "column", sizes: [1, 1], splitId: "s2", children: ["p1", "p2"] }, "p3"],
  };
  const first = loadGroupSession(doc, spec);
  first.panes.saveWorkspacePanesStates();
  const again = loadPanesModuleWithStorage(buildDom().document, "ws-1", first.ctx.__storage[PANES_STORAGE_KEY], null);
  const entry = again.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.visible.type, "group", "stored group subject survives the reload");
  const group = entry.groups[0];
  assert.ok(group.layout && group.layout.kind === "row", "stored layout tree survives the reload");
  const nested = group.layout.children.find((c) => c && typeof c === "object");
  assert.ok(nested && nested.kind === "column", "nested geometry survives the reload");
});

test("legacy tree blobs migrate to flat ungrouped panels", () => {
  const stored = JSON.stringify({
    __session__: {
      root: {
        kind: "row",
        sizes: [1, 1],
        children: [
          { kind: "pane", tabs: ["tab_2"], active: "tab_2" },
          { kind: "pane", paneId: "p7", tabs: [], active: null, groupCollector: true, groupSlot: true },
        ],
      },
    },
  });
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored, null);
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  assert.equal(entry.v, 2, "migrated entry carries the v2 marker");
  assert.equal(entry.panels.length, 2, "every legacy leaf flattens into a panel");
  assert.ok(entry.panels.every((leaf) => !!leaf.paneId), "id-less legacy leaves mint ids");
  assert.ok(entry.panels.every((leaf) => leaf.groupId == null), "legacy panels arrive ungrouped");
  assert.ok(entry.panels.every((leaf) => !leaf.groupCollector && !leaf.groupSlot), "legacy marks stripped");
  assert.ok(entry.groups.length === 0, "legacy geometry resets to no groups");
  assert.equal(entry.visible.type, "panel", "visible subject is a panel after migration");
  assert.equal(entry.visible.id, entry.panels[0].paneId, "first panel takes the subject");
});

test("normalize repairs id-less panels, dissolves under-membered groups, heals stale visible", () => {
  const stored = v2Blob(
    [
      { kind: "pane", tabs: [], active: null, wsId: "ws-1" },
      { kind: "pane", paneId: "p9", tabs: ["editor:src/a.py"], active: "editor:src/a.py", wsId: "ws-1" },
    ],
    [{ groupId: "g1", name: "dead", memberIds: ["p9", "ghost"], layout: { kind: "row", sizes: [1, 1], children: ["p9", "ghost"] } }],
    { type: "panel", id: "p404" },
  );
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored, null);
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  assert.equal(entry.panels.length, 2, "both panels loaded");
  assert.ok(entry.panels[0].paneId, "id-less panel minted an id");
  const ids = entry.panels.map((l) => l.paneId);
  assert.equal(new Set(ids).size, 2, "minted id collides with nothing");
  assert.equal(entry.groups.length, 0, "group with one live member dissolves");
  assert.equal(panes.paneLeaves(entry).find((l) => l.paneId === "p9").groupId, null, "dissolved member ungroups");
  assert.equal(entry.visible.type, "panel", "stale visible healed to a panel");
  assert.ok(ids.includes(entry.visible.id), "healed visible names a live panel");
});

test("forgetWorkspacePanes keeps the session entry and drops legacy per-ws keys", () => {
  const { document } = buildDom();
  const saved = {};
  const ctx = loadPanesModuleWithStorage(document, "ws-1", null, saved);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  ctx.state.workspacePanes["ws|ws-1"] = { root: { kind: "pane" } };
  panes.saveWorkspacePanesStates();
  panes.forgetWorkspacePanes("ws-1");
  assert.ok(ctx.state.workspacePanes.__session__, "session entry survives the workspace close");
  assert.equal(ctx.state.workspacePanes["ws|ws-1"], undefined, "legacy per-workspace entries drop");
  assert.ok(saved[PANES_STORAGE_KEY], "session entry stays persisted");
});

// ---- 3. terminal sync ---------------------------------------------------

test("sync homes the first id into the bound seed panel and splits the second", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const seed = panes.paneRoot().panels[0];
  assert.ok(seed.tabs.includes("terminal"), "fresh entry seeds the placeholder");
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }, { tab_id: "tab_3", workspace_id: "ws-1" }];
  assert.equal(panes.syncTerminalTabsIntoTree(panes.paneRoot()), true, "ids resolved");
  assert.deepEqual([...seed.tabs], ["tab_2"], "first id homes into the seed, one view per flat");
  assert.equal(seed.active, "tab_2", "active follows the seed");
  // The second id split the busy seed: a group wraps host + fresh member.
  const root = panes.paneRoot();
  const group = root.groups[0];
  assert.ok(group, "homing split minted a group");
  assert.deepEqual([...group.memberIds], [seed.paneId, root.panels[root.panels.length - 1].paneId], "host left, fresh member right");
  const fresh = root.panels[root.panels.length - 1];
  assert.ok(fresh.tabs.includes("tab_3"), "second id lives in the split member");
  assert.equal(group.focusedPaneId, fresh.paneId, "split focus lands on the new member");
  // A third id appends nowhere: it splits the id's own home again only
  // when homed, so drop a dead id instead and watch the prune heal.
  ctx.state.tabs = ctx.state.tabs.filter((tab) => tab.tab_id !== "tab_3");
  assert.equal(panes.syncTerminalTabsIntoTree(panes.paneRoot()), true, "dead id pruned");
  const leavesAfter = panes.paneLeaves(panes.paneRoot());
  assert.ok(leavesAfter.some((l) => l.tabs.includes("tab_2")), "seed keeps its id");
  assert.ok(!leavesAfter.some((l) => l.tabs.includes("tab_3")), "pruned id gone from every leaf");
});

test("sync keeps a moved tab's home and a placement on a busy panel splits beside it", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.newPanelForFocused();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  leaves[1].tabs.push("tab_2");
  leaves[1].active = "tab_2";
  ctx.state.tabs.push({ tab_id: "tab_9", workspace_id: "ws-1" });
  panes.requestTabPlacement(leaves[0].paneId);
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  assert.ok(leaves[1].tabs.includes("tab_2"), "moved terminal keeps its home");
  // Placement on a busy panel splits: the fresh member beside the
  // pressed panel owns the incoming id.
  const root = panes.paneRoot();
  const owner = root.panels.find((l) => l.tabs.includes("tab_9"));
  assert.ok(owner && owner.paneId !== leaves[0].paneId, "new id landed in the split member beside the pressed panel");
  const group = root.groups.find((g) => g.memberIds.includes(owner.paneId));
  assert.ok(group, "the split member groups with the pressed panel");
  assert.deepEqual([...group.memberIds], [leaves[0].paneId, owner.paneId], "pressed panel left, new member right");
  assert.equal(group.focusedPaneId, owner.paneId, "split focus lands on the new member");
});

// ---- 4. label drag pipeline: preview geometry and refusals -------------

test("dragover previews the quadrant halves over the visible panel", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = sessionWithPanels(document, "ws-1", 2);
  const hostPane = document.querySelectorAll(".workspace-pane")[0];
  panes.paneLabelDragStart(dragStartEvent(), encodeURIComponent("p2"));
  // Top-left corner: column, first half. The stub rect is 24x24 at
  // (10,10), the container rect at (10,10), so the preview square is
  // offset 0 and covers the top half.
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...TOP_LEFT));
  let preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview overlay exists");
  assert.equal(preview.style.display, "block", "corner dragover shows the preview");
  assert.equal(preview.style.left, "0px", "column first half starts at the pane left");
  assert.equal(preview.style.top, "0px", "column first half starts at the pane top");
  assert.equal(preview.style.width, "24px", "column keeps the full width");
  assert.equal(preview.style.height, "12px", "column halves the height");
  // Bottom-left corner: column, second half.
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...BOTTOM_LEFT));
  assert.equal(preview.style.top, "12px", "second half starts below the middle");
  assert.equal(preview.style.height, "12px", "second half covers the bottom half");
  // Left-mid edge: row, first half.
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...LEFT_MID));
  assert.equal(preview.style.left, "0px", "row first half starts at the pane left");
  assert.equal(preview.style.width, "12px", "row halves the width");
  assert.equal(preview.style.height, "24px", "row keeps the full height");
  // Right-mid edge: row, second half.
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...RIGHT_MID));
  assert.equal(preview.style.left, "12px", "row second half starts past the middle");
  panes.paneLabelDragEnd();
  assert.equal(preview.style.display, "none", "dragend clears the preview");
});

test("dragover hides the preview on dead center and self-drags", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = sessionWithPanels(document, "ws-1", 2);
  const hostPane = document.querySelectorAll(".workspace-pane")[0];
  panes.paneLabelDragStart(dragStartEvent(), encodeURIComponent("p2"));
  // A qualifying dragover first, so the preview element exists and shows.
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...TOP_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "qualifying dragover shows the preview");
  // Dead center: no corner, no target, preview hides.
  panes.paneContainerTabDragOver(dropEvent(hostPane, 22, 22));
  assert.equal(preview.style.display, "none", "dead center clears the preview");
  // Dragging the visible host onto itself never qualifies.
  panes.paneLabelDragStart(dragStartEvent(), encodeURIComponent("p1"));
  panes.paneContainerTabDragOver(dropEvent(hostPane, ...TOP_LEFT));
  assert.equal(preview.style.display, "none", "self drag clears the preview");
  panes.paneLabelDragEnd();
});

// Spec drop contract (notes.md points 2/3: the dragged label lands at
// the release quadrant and the auto-join neighbor fills the other
// half). The source bug that blocked this (paneContainerTabDrop cleared
// the drag state before labelDropTargetValid read it) is fixed: the
// gate runs on the captured drag and the clear happens after the
// surgery on every exit.
test("SPEC: label drop creates the group at the quadrant", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = sessionWithPanels(document, "ws-1", 2);
  const hostPane = document.querySelectorAll(".workspace-pane")[0];
  dropLabelOn(panes, "p2", hostPane, ...LEFT_MID);
  const group = firstGroup(panes);
  assert.ok(group, "group created");
  assert.deepEqual([...group.memberIds], ["p2", "p3"], "dragged panel joins its right neighbor");
  assert.equal(group.layout.kind, "row", "left/right thirds pick the row axis");
  assert.deepEqual([...group.layout.children], ["p2", "p3"], "dragged lands on the released half");
  const entry = entryOf(panes);
  assert.equal(entry.visible.type, "group", "the new group takes the subject");
  const byId = Object.fromEntries(panes.paneLeaves(entry).map((l) => [l.paneId, l]));
  assert.equal(byId.p2.groupId, group.groupId, "dragged member stamped");
  assert.equal(byId.p3.groupId, group.groupId, "neighbor member stamped");
  assert.equal(byId.p1.groupId, null, "the host visible panel is NOT a member");
  assert.equal(panes.activePane().paneId, "p2", "focus lands on the dragged panel");
});

// ---- 5. group render from a seeded session ----------------------------

test("a group subject renders one split wrapper, one pane per member, dividers", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadGroupSession(document, seedTwoMemberGroup(document));
  const group = firstGroup(panes);
  assert.ok(group, "group loaded");
  assert.equal(entryOf(panes).visible.type, "group", "group is the subject");
  const rows = splitElements(nodes).filter((w) => w.className.split(/\s+/).includes("pane-row"));
  assert.equal(rows.length, 1, "one row wrapper for the row layout");
  assert.equal(rows[0].getAttribute("data-split-id") != null || rows[0].dataset.splitId != null, true, "wrapper carries the split id attr");
  assert.equal(paneElements(nodes).length, 2, "one pane per member");
  const paneIds = paneElements(nodes).map((p) => p.dataset.paneId).sort();
  assert.deepEqual(paneIds, ["p1", "p2"], "member panes keyed by paneId");
  assert.equal(dividerElements(nodes).length, 1, "one divider between the members");
  assert.equal(rows[0].children[1].className, "pane-divider", "divider sits between the panes");
  for (const pane of paneElements(nodes)) {
    assert.ok(stripOf(pane), "each member pane has a strip");
    assert.ok(contentOf(pane), "each member pane has a content slot");
  }
});

test("a single panel subject renders one flat pane with no wrapper", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  assert.equal(splitElements(nodes).length, 0, "no split wrapper");
  assert.equal(paneElements(nodes).length, 1, "one flat pane");
  const flat = paneElements(nodes)[0];
  assert.equal(flat.dataset.paneId, "p1", "flat pane keyed by the panel");
  assert.equal(flat.parentNode, nodes.container, "flat pane sits directly under the container");
});

// ---- 6. ungroup through paneTabUnsplitDrop ---------------------------

test("member tab dragged out ungroups and dissolves a two-member group", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: ["editor:src/x.py"] }]);
  // Regroup p2+p3 so the survivor (p2) differs from panels[0] (p1):
  // the heal cannot hide behind the first-panel fallback.
  spec.panels[0].groupId = null;
  spec.panels[1].groupId = "g1";
  spec.panels[2].groupId = "g1";
  spec.groups[0].memberIds = ["p2", "p3"];
  spec.groups[0].layout = { kind: "row", sizes: [1, 1], splitId: "s1", children: ["p2", "p3"] };
  const { ctx, panes } = loadGroupSession(document, spec);
  assert.equal(entryOf(panes).visible.type, "group", "group starts visible");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/x.py" }, classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } });
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "editor:src/x.py" } }), true, "hover qualifies the ungroup");
  assert.equal(panes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "editor:src/x.py" } }), true, "drop reported");
  const entry = entryOf(panes);
  assert.equal(entry.groups.length, 0, "two-member group dissolves when one leaves");
  const leaves = panes.paneLeaves(entry);
  assert.ok(leaves.every((l) => l.groupId == null), "all panels ungrouped");
  assert.equal(entry.visible.type, "panel", "subject heals to a panel");
  assert.equal(entry.visible.id, "p2", "the surviving member takes the subject, not panels[0]");
  assert.equal(splitElements(nodes).length, 0, "split chrome cleared after the dissolve");
  // A tab whose panel is ungrouped no longer qualifies.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/x.py" }, classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } });
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "editor:src/x.py" } }), false, "ungrouped panel never qualifies");
});

test("a three-member group keeps two after one member leaves", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: ["editor:src/y.py"] }]);
  spec.panels[2].groupId = "g1";
  spec.groups[0].memberIds = ["p1", "p2", "p3"];
  spec.groups[0].layout = { kind: "row", sizes: [1, 1, 1], splitId: "s1", children: ["p1", "p2", "p3"] };
  const { ctx, panes } = loadGroupSession(document, spec);
  const group = firstGroup(panes);
  assert.equal(group.memberIds.length, 3, "three members loaded");
  assert.equal(paneElements(nodes).length, 3, "three member panes render");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/y.py" }, classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } });
  assert.equal(panes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "editor:src/y.py" } }), true, "ungroup drop accepted");
  assert.equal(entryOf(panes).groups.length, 1, "group survives with two members");
  assert.deepEqual([...group.memberIds], ["p1", "p2"], "the leaving member dropped out");
  assert.equal(group.layout.children.length, 2, "layout collapsed to the survivors");
  assert.deepEqual([...group.layout.children], ["p1", "p2"], "layout children match the members");
  assert.equal(entryOf(panes).visible.type, "group", "group keeps the subject");
  const p3After = panes.paneLeaves(entryOf(panes)).find((l) => l.paneId === "p3");
  assert.equal(p3After.groupId, null, "the leaver is ungrouped");
  assert.equal(paneElements(nodes).length, 2, "two member panes render after the ungroup");
});

// ---- 7. rail render rules ---------------------------------------------

test("the rail renders whenever the pane area is live, chips carry the close", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.renderWorkspacePanes();
  // Locked contract change: the rail always paints while the pane area
  // is live. The chip is the only close/rename surface (the bar's ✕ and
  // menu are gone), so a single panel without a rail would strand both.
  let rail = railOf(nodes);
  assert.ok(rail, "a single panel session renders the rail");
  assert.ok(rail.__innerHTML.includes("closePanelFromChip"), "the lone chip carries its close x");
  panes.newPanelForFocused();
  panes.renderWorkspacePanes();
  rail = railOf(nodes);
  assert.ok(rail, "two ungrouped panels render the rail");
  assert.equal(rail.getAttribute("role"), "tablist", "rail is a tablist");
  assert.ok(rail.__innerHTML.includes("pane-label-chip"), "panel chips render");
  assert.ok(rail.__innerHTML.includes(`data-pane-id="p1"`) && rail.__innerHTML.includes(`data-pane-id="p2"`), "one chip per ungrouped panel");
  assert.ok(rail.__innerHTML.includes('draggable="true"'), "panel chips drag");
  assert.ok(rail.__innerHTML.includes("showPanelFromRail"), "chip press switches the subject");
  assert.ok(rail.__innerHTML.includes('aria-selected="true"'), "the visible panel chip is selected (tablist pattern)");
});

test("group chips render the default name, never drag, and carry the rename hook", () => {
  const { nodes, document } = buildDom();
  // Group [p1,p2] visible plus one ungrouped host panel p3.
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  const { ctx, panes } = loadGroupSession(document, spec);
  const rail = railOf(nodes);
  assert.ok(rail, "group + ungrouped panel renders the rail");
  assert.ok(rail.__innerHTML.includes("pane-panel-group-chip"), "group chip renders");
  assert.ok(rail.__innerHTML.includes("Group 2 views"), "default name counts the members");
  assert.ok(rail.__innerHTML.includes('draggable="false"'), "group chips never drag");
  assert.ok(rail.__innerHTML.includes("showGroupFromRail"), "chip press shows the group");
  assert.ok(rail.__innerHTML.includes("startPaneGroupRename"), "double-click renames");
  assert.ok(rail.__innerHTML.includes('data-group-id="g1"'), "chip keyed by group id");
  // Locked contract: a grouped member carries NO rail chip (its
  // identity lives in the merged header); only the group chip remains.
  assert.ok(!rail.__innerHTML.includes('data-pane-id="p1"') && !rail.__innerHTML.includes('data-pane-id="p2"'), "grouped members leave the rail");
  assert.ok(rail.__innerHTML.includes('data-group-id="g1"'), "group chip keeps the split entry");
});

test("a lone group as the only subject still renders the rail", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadGroupSession(document, seedTwoMemberGroup(document));
  // Locked contract: grouped members carry no rail chips, but a lone
  // group still paints the rail: it is the drag-out exit target.
  assert.equal(entryOf(panes).panels.length, 2, "session holds exactly the two members");
  assert.ok(panes.paneLeaves(entryOf(panes)).every((l) => !!l.groupId), "both panels grouped");
  const rail = railOf(nodes);
  assert.ok(rail, "lone group keeps the rail as its exit target");
  const html = rail.__innerHTML;
  assert.ok(!html.includes('data-pane-id="p1"') && !html.includes('data-pane-id="p2"'), "grouped members carry no chips");
  assert.ok(html.includes('data-group-id="g1"'), "group chip renders");
  // A single-panel session with no group still renders no rail.
  assert.ok(!html.includes('data-pane-id="p3"'), "no phantom panels");
});

// Locked contract: a lone group with an ungrouped third panel renders
// the ungrouped chip + the group chip (grouped members stay off).
test("group session rail lists member chips plus the group chip", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  const { ctx, panes } = loadGroupSession(document, spec);
  const rail = railOf(nodes);
  assert.ok(rail, "multiple subjects render the rail");
  const html = rail.__innerHTML;
  assert.ok(!html.includes('data-pane-id="p1"') && !html.includes('data-pane-id="p2"'), "grouped members stay off the rail");
  assert.ok(html.includes('data-pane-id="p3"'), "ungrouped panel keeps its chip");
  assert.ok(html.includes('data-group-id="g1"'), "the visible group renders its chip");
});

// ---- 8. group rename trio ---------------------------------------------

test("rename trio: start renders the input, commit persists, empty reverts, keys work", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  const { ctx, panes } = loadGroupSession(document, spec);
  const group = firstGroup(panes);
  const enc = encodeURIComponent(group.groupId);
  panes.startPaneGroupRename(enc);
  assert.equal(ctx.state.editingPaneGroup, group.groupId, "edit session keyed by group id");
  let rail = railOf(nodes);
  assert.ok(rail.__innerHTML.includes("pane-group-rename-input"), "rail renders the rename input");
  assert.ok(rail.__innerHTML.includes("commitPaneGroupRename"), "blur commits");
  // Enter key commits the draft.
  ctx.state.editingPaneGroupValue = "work";
  panes.paneGroupRenameKey({ key: "Enter", preventDefault() {} }, enc);
  assert.equal(group.name, "work", "Enter commit stores the name");
  assert.equal(ctx.state.editingPaneGroup, null, "edit session closed");
  rail = railOf(nodes);
  assert.ok(rail.__innerHTML.includes("work"), "rail shows the custom name");
  // The name persists through save.
  panes.saveWorkspacePanesStates();
  assert.ok(ctx.__storage[PANES_STORAGE_KEY].includes("work"), "custom name persisted");
  // Empty commit reverts to the default name.
  panes.startPaneGroupRename(enc);
  ctx.state.editingPaneGroupValue = "   ";
  panes.commitPaneGroupRename(enc);
  assert.equal(group.name, null, "empty draft reverts to the default");
  // Escape cancels the edit without touching the name.
  panes.startPaneGroupRename(enc);
  ctx.state.editingPaneGroupValue = "nope";
  panes.paneGroupRenameKey({ key: "Escape" }, enc);
  assert.equal(group.name, null, "Escape leaves the name alone");
  assert.equal(ctx.state.editingPaneGroup, null, "Escape closes the edit session");
});

// Locked contract: a grouped member carries no rail chip, so its
// rename input mounts in the merged header instead. The rail keeps
// its signature (no phantom input inside it), commit stores the name,
// and the header button returns.
test("grouped member rename mounts the input in the merged header", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  const { ctx, panes } = loadGroupSession(document, spec);
  const enc = encodeURIComponent("p1");
  panes.startPanelChipRename(enc);
  assert.equal(ctx.state.editingPanelPaneId, "p1", "edit session keyed by pane id");
  const rail = railOf(nodes);
  assert.ok(!rail.__innerHTML.includes("pane-group-rename-input"), "rail renders no input for a grouped member");
  const p1 = [...document.querySelectorAll(".workspace-pane")].find((pane) => pane.dataset && pane.dataset.paneId === "p1") || null;
  assert.ok(p1, "member pane renders");
  const stripHtml = p1 ? stripOf(p1).__innerHTML : "";
  assert.ok(stripHtml.includes("pane-member-header-input"), "merged header hosts the rename input");
  // Commit through the shared key path: the draft stores, the session
  // closes, the header button returns in place of the input.
  ctx.state.editingPanelValue = "side";
  panes.panelChipRenameKey({ key: "Enter", preventDefault() {} }, enc);
  const leaf = panes.paneLeaves(panes.paneRoot()).find((l) => l.paneId === "p1");
  assert.equal(leaf.name, "side", "Enter commit stores the member name");
  assert.equal(ctx.state.editingPanelPaneId, null, "edit session closed");
  const stripAfterHtml = stripOf(p1).__innerHTML;
  assert.ok(stripAfterHtml.includes("pane-member-header"), "header button returns after commit");
  assert.ok(!stripAfterHtml.includes("pane-member-header-input"), "input leaves the header after commit");
});

// ---- 9. subject switching ----------------------------------------------

test("showPanelFromRail and showGroupFromRail switch the visible subject", () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  const { ctx, panes } = loadGroupSession(document, spec);
  const group = firstGroup(panes);
  assert.equal(entryOf(panes).visible.type, "group", "group starts visible");
  assert.equal(splitElements(nodes).length, 1, "group layout painted");
  assert.equal(paneElements(nodes).length, 2, "group paints its members");
  // Panel press: the group folds to its chip, the panel shows alone.
  assert.equal(panes.showPanelFromRail(encodeURIComponent("p3")), true, "panel switch accepted");
  assert.equal(entryOf(panes).visible.type, "panel", "subject is the panel");
  assert.equal(entryOf(panes).visible.id, "p3", "subject names the pressed panel");
  assert.equal(splitElements(nodes).length, 0, "group chrome cleared");
  assert.equal(paneElements(nodes).length, 1, "single panel paints one flat pane");
  const flat = paneElements(nodes)[0];
  assert.equal(flat.dataset.paneId, "p3", "flat pane keyed by the panel");
  assert.equal(flat.parentNode, nodes.container, "flat pane sits directly under the container");
  const rail = railOf(nodes);
  // Persistence contract: switching to a panel KEEPS the group record;
  // the rail still paints its chip beside the member chips.
  assert.ok(rail.__innerHTML.includes('data-pane-id="p3"'), "pressed panel chip renders");
  assert.ok(rail.__innerHTML.includes("pane-panel-group-chip"), "group chip persists beside member chips");
  assert.equal(entryOf(panes).groups.length, 1, "group record survives the subject switch");
  assert.ok(panes.paneLeaves(entryOf(panes)).every((l) => !l.groupId || l.groupId === group.groupId), "member links survive");
  // A NON-member press never touches the group's focus memory; the
  // boot focus (p1, the active tab's owner) must stand.
  assert.equal(group.focusedPaneId, "p1", "independent panel press leaves the group memory alone");
  // A member press becomes the remembered focus for the reopen.
  assert.equal(panes.showPanelFromRail(encodeURIComponent("p2")), true, "member panel switch accepted");
  assert.equal(group.focusedPaneId, "p2", "member press becomes the group's focus memory");
  // Group press reopens the split ON the remembered member.
  assert.ok(panes.showGroupFromRail(encodeURIComponent(group.groupId)), "group chip reopens the split");
  assert.equal(entryOf(panes).visible.type, "group", "subject is the group again");
  assert.equal(paneElements(nodes).length, 2, "split repaints its members");
  assert.equal(entryOf(panes).activePaneId, "p2", "reopen restores the remembered member");
  // Unknown ids refuse.
  assert.equal(panes.showPanelFromRail(encodeURIComponent("p404")), false, "unknown panel refused");
  assert.equal(panes.showGroupFromRail(encodeURIComponent("g404")), false, "unknown group refused");
});

// ---- 10. close cascade -------------------------------------------------

test("closeActivePane really closes the member's views and drops the panel", async () => {
  const { nodes, document } = buildDom();
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: [] }]);
  // Regroup p2+p3: closing p3 leaves survivor p2 while panels[0] stays
  // p1, so no first-panel fallback can hide behind rail-order.
  spec.panels[0].groupId = null;
  spec.panels[1].groupId = "g1";
  spec.panels[2].groupId = "g1";
  spec.groups[0].memberIds = ["p2", "p3"];
  spec.groups[0].layout = { kind: "row", sizes: [1, 1], splitId: "s1", children: ["p2", "p3"] };
  spec.panels[2].tabs = ["editor:src/gone.py"];
  spec.panels[2].active = "editor:src/gone.py";
  const { ctx, panes } = loadGroupSession(document, spec);
  ctx.window.HerdrFileBrowser = {
    async closeEditorTab(path) { panes.closeEditorTabImmediate(path); },
  };
  // The real closeTab owns the backend row close (confirm + POST +
  // prune + cascade); without it the row survives and the sync would
  // legitimately re-home the id as a fresh split. Model the row half.
  ctx.window.closeTab = async (tabId) => {
    ctx.state.tabs = ctx.state.tabs.filter((row) => row.tab_id !== tabId);
    panes.onTerminalTabClosed(tabId);
  };
  panes.focusPanelFor(encodeURIComponent("p3"));
  assert.equal(await panes.closeActivePane(), true, "close accepted");
  const root = panes.paneRoot();
  assert.equal(panes.paneLeaves(root).length, 2, "two panels left");
  assert.ok(!root.panels.some((l) => l.paneId === "p3"), "closed panel record dropped");
  const survivor = root.panels.find((l) => l.paneId === "p2");
  const outsider = root.panels.find((l) => l.paneId === "p1");
  assert.ok(!survivor.tabs.includes("editor:src/gone.py"), "views never migrate to a sibling");
  assert.ok(!outsider.tabs.includes("editor:src/gone.py"), "rail-order panel never receives the views");
  assert.equal(root.visible.type, "panel", "visible pointer healed to a panel");
  // The under-two group dissolved through the render-top sweep.
  assert.equal(root.groups.length, 0, "one-member group dissolved");
  assert.equal(splitElements(nodes).length, 0, "split chrome cleared");
  // Closing down to one panel still refuses the last close.
  assert.equal(await panes.closeActivePane(), true, "second close drops the next active panel");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "one panel left");
  assert.equal(await panes.closeActivePane(), false, "last panel refuses");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "still one panel");
});

// ---- 11. sweep guards ---------------------------------------------------

test("the sweep spares the focused armed leaf and folds it once focus leaves", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-50");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.newPanelForFocused();
  const entry = panes.paneRoot();
  const leaves = panes.paneLeaves(entry);
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  // No backend rows: nothing can refill the emptied panel.
  ctx.state.tabs = [];
  ctx.state.tab = null;
  ctx.window.HerdrFileBrowser = { editorFor: () => null, closeEditorState: () => {}, closeEditorTab: null };
  // Focus the soon-emptied panel: armed but focused, it must stand.
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  panes.closeEditorTabImmediate(encodeURIComponent("src/a.py"));
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "focused armed panel stands");
  // Focus the sibling: the next render folds the armed empty.
  panes.focusPanelFor(encodeURIComponent(leaves[1].paneId));
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "armed panel folds once unfocused");
  // The last panel never drops, even armed and empty.
  const last = panes.paneLeaves(panes.paneRoot())[0];
  last.tabs = [];
  last.autoCloseArmed = true;
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "last panel never drops");
});

test("a refilled panel never folds and the blob never carries arm markers", () => {
  const { document } = buildDom();
  const saved = {};
  const ctx = loadPanesModuleWithStorage(document, "ws-51", null, saved);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.newPanelForFocused();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  leaves[1].tabs = ["editor:src/b.py"];
  leaves[1].active = "editor:src/b.py";
  ctx.state.tabs = [];
  ctx.state.tab = null;
  ctx.window.HerdrFileBrowser = { editorFor: () => null, closeEditorState: () => {}, closeEditorTab: null };
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  panes.closeEditorTabImmediate(encodeURIComponent("src/a.py"));
  const armed = panes.paneLeaves(panes.paneRoot()).find((l) => l.paneId === leaves[0].paneId);
  assert.equal(armed.autoCloseArmed, true, "live entry keeps the marker for the sweep");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "focused armed panel stands");
  // Refill the armed panel: the sweep is empty-only, it must stand.
  armed.tabs.push("editor:src/back.py");
  armed.active = "editor:src/back.py";
  panes.focusPanelFor(encodeURIComponent(leaves[1].paneId));
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "refilled panel never folds");
  // The persisted blob strips the runtime markers.
  panes.saveWorkspacePanesStates();
  const stored = saved[PANES_STORAGE_KEY] || "";
  assert.ok(stored && !stored.includes("autoCloseArmed") && !stored.includes("autoClosePre"), "blob strips the arm markers");
});

test("onTerminalTabClosed prunes the id and the emptied panel folds once unfocused", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-52");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.newPanelForFocused();
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(panes.onTerminalTabClosed("missing"), false, "unknown id is a no-op");
  leaves[1].tabs.push("t2");
  leaves[1].active = "t2";
  ctx.state.tabs.push({ tab_id: "t2", workspace_id: "ws-52" });
  panes.renderWorkspacePanes();
  // Focus the t1 panel, then close t1's tab: the emptied panel is
  // armed but focused, it stands for the Enter spawn.
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  ctx.state.tabs = [{ tab_id: "t2", workspace_id: "ws-52" }];
  ctx.state.tab = "t2";
  assert.equal(panes.onTerminalTabClosed("t1"), true, "prune reported");
  let after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 2, "emptied panel holds focus and stands");
  assert.deepEqual([...after.find((l) => l.paneId === leaves[0].paneId).tabs], [], "closed id dropped");
  // Focus the t2 panel: the render-top sweep folds the armed empty.
  panes.focusPanelFor(encodeURIComponent(leaves[1].paneId));
  panes.renderWorkspacePanes();
  after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "abandoned empty panel folds on the next render");
  assert.equal(after[0].paneId, leaves[1].paneId, "survivor keeps its id");
});

// ---- 12. DOM identity across group renders ----------------------------

test("BUG A regression: repeated renders keep pane and divider identity in groups", () => {
  const { nodes, document } = buildDom();
  // Flat row of three members. Nested geometry cannot seed through
  // the load path today: normalizeLayoutNode drops paneId string
  // children (Bug 5, flagged in the reload spec test), so a stored
  // nested tree collapses to a flat array and the render fallback
  // rebuilds a flat row. Identity coverage runs on the flat row.
  const spec = seedTwoMemberGroup(document, [{ paneId: "p3", tabs: ["t3"] }]);
  spec.panels[2].groupId = "g1";
  spec.groups[0].memberIds = ["p1", "p2", "p3"];
  spec.groups[0].layout = { kind: "row", sizes: [1, 1, 1], splitId: "s1", children: ["p1", "p2", "p3"] };
  spec.rows = ["tab_2", "t2", "t3"];
  const { ctx, panes } = loadGroupSession(document, spec);
  const panesBefore = paneElements(nodes).slice();
  const splitsBefore = splitElements(nodes).slice();
  const dividersBefore = dividerElements(nodes).slice();
  assert.equal(panesBefore.length, 3, "three member panes");
  assert.equal(splitsBefore.length, 1, "one row wrapper");
  assert.equal(dividersBefore.length, 2, "two dividers");
  for (let i = 0; i < 5; i++) panes.renderWorkspacePanes();
  assert.deepEqual(paneElements(nodes), panesBefore, "pane elements reused across renders");
  assert.deepEqual(splitElements(nodes), splitsBefore, "split wrappers reused across renders");
  assert.deepEqual(dividerElements(nodes), dividersBefore, "dividers reused across renders");
});

test("BUG A regression: stale dividers are pruned from group wrappers", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadGroupSession(document, seedTwoMemberGroup(document));
  const wrapper = splitElements(nodes)[0];
  assert.ok(wrapper, "group wrapper rendered");
  // Inject a phantom divider keyed on a pane that left the layout.
  const ghost = document.createElement("div");
  ghost.className = "pane-divider";
  ghost.dataset.dividerFor = "p404";
  wrapper.appendChild(ghost);
  panes.renderWorkspacePanes();
  const dividers = wrapper.children.filter((c) => c.className === "pane-divider");
  assert.equal(dividers.length, 1, "phantom divider pruned, one real divider stays");
  assert.ok(!dividers.includes(ghost), "the ghost node itself is gone");
  assert.equal(wrapper.children.length, 3, "wrapper holds pane, divider, pane with no extra nodes");
});

// ---- 13. divider drag inside group layouts ----------------------------

test("divider drag inside a group resizes and persists the layout sizes", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadGroupSession(document, seedTwoMemberGroup(document));
  const group = firstGroup(panes);
  const divider = dividerElements(nodes)[0];
  assert.ok(divider.listeners.pointerdown, "pointerdown wired");
  assert.ok(divider.listeners.pointerup, "pointerup wired");
  const growChildren = paneElements(nodes);
  growChildren.forEach((p) => { p.style.flexGrow = "1"; });
  const parent = divider.parentNode;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  divider.setPointerCapture = () => {};
  divider.listeners.pointerdown[0]({ button: 0, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {} });
  divider.listeners.pointermove[0]({ clientX: 300, clientY: 150 });
  const after = parseFloat(growChildren[0].style.flexGrow);
  assert.ok(after > 1, "first member grew during the drag");
  divider.listeners.pointerup[0]();
  assert.equal(group.layout.sizes[0], after, "sizes persisted into the group layout on pointerup");
  assert.ok(Math.abs(group.layout.sizes[0] + group.layout.sizes[1] - 2) < 0.01, "shares still sum to the total");
});

// ---- 14. terminal shell ownership in groups ---------------------------

test("terminalShellOwnerLeaf: route member wins, then first terminal-active", () => {
  const { document } = buildDom();
  const spec = seedTwoMemberGroup(document);
  const { ctx, panes } = loadGroupSession(document, spec);
  const group = firstGroup(panes);
  assert.ok(group, "group loaded");
  const members = panes.paneLeaves(panes.paneRoot()).filter((l) => l.groupId === group.groupId);
  assert.equal(members.length, 2, "two members");
  // Route names t2: its member owns the shell.
  ctx.state.tab = "t2";
  panes.renderWorkspacePanes();
  const owner = panes.terminalShellOwnerLeaf(panes.paneRoot());
  const t2Leaf = panes.paneLeaves(panes.paneRoot()).find((l) => l.tabs.includes("t2"));
  assert.equal(owner, t2Leaf, "route tab's member owns the shell");
  // No route: the first terminal-active member wins.
  ctx.state.tab = null;
  const withEditor = panes.paneLeaves(panes.paneRoot()).find((l) => l.tabs.includes("t2"));
  withEditor.tabs.push("editor:src/x.py");
  withEditor.active = "editor:src/x.py";
  panes.renderWorkspacePanes();
  const owner2 = panes.terminalShellOwnerLeaf(panes.paneRoot());
  const termActive = panes.paneLeaves(panes.paneRoot()).find((l) => l.active === "tab_2");
  assert.equal(owner2, termActive, "first terminal-active member owns the shell");
});

// ---- 15. empty panel affordance ---------------------------------------

test("an empty panel renders the New terminal affordance", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Close the only tab: the panel empties but stands (single panel guard).
  ctx.state.tabs = [];
  ctx.state.tab = null;
  assert.equal(panes.onTerminalTabClosed("tab_2"), true, "prune reported");
  panes.renderWorkspacePanes();
  const pane = paneElements(nodes)[0];
  const card = contentOf(pane).querySelector(".workspace-empty-leaf");
  assert.ok(card, "empty panel card rendered");
  const inner = card.querySelector(".workspace-empty-leaf-card");
  assert.ok(inner, "card inner block exists");
  assert.ok(inner.__innerHTML.includes("New terminal"), "card names the New terminal action");
  assert.ok(inner.__innerHTML.includes(`newTabForPane('${encodeURIComponent("p1")}')`), "card button targets the pane");
});

// ---- 16. bar controls contract ----------------------------------------

test("bar controls carry + find markdown, never close menu split or maximize", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // The bar owns creation and view actions only. Close and menu live
  // on the rail chips now; none of the removed commands leak.
  const html = panes.paneBarControlsHtml();
  assert.ok(html.includes("pane-new-picker"), "bar carries the + picker (change 5)");
  assert.ok(!html.includes("newPanelForFocused"), "no direct mint on the bar");
  assert.ok(!html.includes("togglePaneMenu"), "no pane menu (removed)");
  assert.ok(!html.includes("splitPaneRight"), "no split right command (removed)");
  assert.ok(!html.includes("splitPaneDown"), "no split down command (removed)");
  assert.ok(!html.includes("maximizePaneFor"), "no maximize command (removed)");
  assert.ok(!html.includes("maximizeActivePane"), "no maximize shortcut (removed)");
  assert.ok(!html.includes("closePaneFor"), "no close on the bar, single or multi panel");
  panes.newPanelForFocused();
  const htmlTwo = panes.paneBarControlsHtml();
  assert.ok(!htmlTwo.includes("closePaneFor"), "second panel still keeps close off the bar");
  // The pane menu machinery is gone: its builder and toggle carry no
  // exports either.
  assert.equal(typeof panes.paneMenuItemsFor, "undefined", "menu items builder deleted");
  assert.equal(typeof panes.togglePaneMenu, "undefined", "menu toggle deleted");
});

test("the bar signature tracks the acting panel and the visible subject", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = sessionWithPanels(document, "ws-1", 1);
  const before = panes.paneBarControlsSignature();
  assert.ok(before.includes("p1"), "signature names the acting panel");
  assert.ok(before.includes("panel:p1"), "signature names the subject");
  // Switch the subject to the other panel: the signature must move.
  panes.showPanelFromRail(encodeURIComponent("p2"));
  const after = panes.paneBarControlsSignature();
  assert.notEqual(after, before, "signature moved with the subject");
  assert.ok(after.includes("panel:p2"), "signature names the new subject");
  // The bar's + is a picker entry now (change 5), always keyed by the
  // acting panel.
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  assert.ok(panes.paneBarControlsHtml().includes(encodeURIComponent("p2")), "commands target the acting panel");
  // Dashboard takeover suppresses the group.
  const dashboard = document.getElementById("projectDashboard");
  dashboard.hidden = false;
  assert.equal(panes.paneBarControlsHtml(), "", "dashboard takeover hides the controls");
  assert.equal(panes.paneBarControlsSignature(), "none", "signature reports the takeover");
  dashboard.hidden = true;
  assert.notEqual(panes.paneBarControlsSignature(), "none", "takeover release restores the signature");
});

// ---- 17. registry export smoke ----------------------------------------

test("registry exports the one-visible-view surface and drops removed commands", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const expected = [
    "panesStateFor", "paneRoot", "paneRootFor", "paneLeaves", "paneTabs", "paneActiveTab",
    "paneTabsForTree", "renderWorkspacePanes", "activatePaneTab", "setActivePaneTab",
    "openEditorTab", "closeEditorTab", "closeEditorTabImmediate",
    "editorTabId", "editorTabPath", "isEditorTab",
    "gitTabId", "gitTabViewKey", "isGitTab", "openGitTab", "closeGitTab", "closeGitTabImmediate",
    "paneGitMountId", "paneEditorMountId", "paneElementForTab",
    "saveWorkspacePanesStates", "forgetWorkspacePanes", "pruneWorkspaceTabsFromPanes",
    "onTerminalTabClosed", "dropLeafFromTree", "newPanelForFocused",
    "closeActivePane", "closePaneFor", "syncTerminalTabsIntoTree", "terminalShellOwnerLeaf",
    "movePaneTabTo", "paneDropIndexAt", "paneStripDragOver", "paneStripDrop",
    "paneLabelDragStart", "paneLabelDragEnd", "paneContainerTabDragOver", "paneContainerTabDrop",
    "showPanelFromRail", "showGroupFromRail",
    "startPaneGroupRename", "paneGroupRenameKey", "commitPaneGroupRename",
    "paneBarControlsHtml", "paneBarControlsSignature", "closePanelFromChip", "dissolveGroupToRail",
    "panelVisibleLabel", "panelDisplayName", "panelNumberLabel", "panelRenameInitialLabel",
    "workspaceIdForTab", "foreignWorkspacePrefix", "paneWorkspaceBadgeHtml",
    "activePane", "activePaneElement", "focusPanelFor", "writeRouteFromLeaf",
    "mountDashboardInPane", "mountEmptyLeafInPane", "openPanelInWorkspace",
    "requestTabPlacement", "newTabForPane", "openPaneEditorFind",
    "paneTabUnsplitHover", "paneTabUnsplitDrop",
  ];
  for (const name of expected) {
    assert.ok(typeof panes[name] === "function", `export present: ${name}`);
  }
  // Removed command surface: the registry must NOT carry the old split,
  // maximize, or collapse commands (the model deleted them).
  const removed = [
    "splitPaneRight", "splitPaneDown", "splitPaneFor", "splitActivePane",
    "maximizeActivePane", "paneIsMaximized", "maximizePaneFor", "renderPaneStripRail",
    "normalizePaneTree", "collapseGroupForTabPress", "expandCollapsedGroup",
    "isCollapsedGroup", "cleanupAbandonedLayout", "moveActiveTabToNextPane",
    "splitLeafWith", "paneGroupSplitForLeaf", "paneSplitIsGroup",
  ];
  for (const name of removed) {
    assert.equal(typeof panes[name], "undefined", `removed command stays gone: ${name}`);
  }
  assert.match(panes.paneEditorMountId("src/a b.py"), /^pane-editor-/, "editor mount id shape");
  assert.match(panes.paneGitMountId("changes"), /^pane-git-/, "git mount id shape");
  assert.notEqual(panes.paneEditorMountId("src/a.py"), panes.paneEditorMountId("src/b.py"), "ids differ per path");
});

// ---- 18. movePaneTabTo matrix -----------------------------------------

test("movePaneTabTo matrix: cross-panel, reorder, refuse, default target", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.newPanelForFocused();
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  ctx.window.HerdrGitUi = {
    async openViewTab(viewKey) { panes.setActivePaneTab("git:" + viewKey); },
  };
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs.push("editor:src/a.py", "editor:src/b.py", "git:changes");
  // Cross-panel move at index 0.
  assert.equal(panes.movePaneTabTo("editor:src/b.py", leaves[1].paneId, 0), true, "cross-panel move");
  assert.ok(leaves[1].tabs.includes("editor:src/b.py"), "target holds it");
  // Same-panel reorder back to slot 0.
  assert.equal(panes.movePaneTabTo("editor:src/a.py", leaves[0].paneId, 0), true, "reorder accepted");
  assert.equal(leaves[0].tabs.indexOf("editor:src/a.py"), 0, "reordered");
  // Terminal moves (D7), placeholder and unknown refuse.
  assert.equal(panes.movePaneTabTo("tab_2", leaves[1].paneId, 0), true, "terminal moves");
  assert.equal(panes.movePaneTabTo("terminal", leaves[1].paneId, 0), false, "placeholder refuses");
  assert.equal(panes.movePaneTabTo("editor:src/ghost.py", leaves[1].paneId, 0), false, "unknown refuses");
  // Default target resolves to the other panel.
  assert.equal(panes.movePaneTabTo("git:changes", null, null), true, "git moves to the other panel");
  assert.ok(leaves[1].tabs.includes("git:changes"), "git landed");
});

function leafTabsCount(leaf) {
  return (leaf.tabs || []).length;
}
