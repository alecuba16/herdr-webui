// v4 drag mechanics coverage: half-region label drops with the dotted
// preview square, the spring-loaded dwell (arm, outline, forced nest),
// group chips (icon + member count) on split subtrees and flat roots,
// the fan-out rule (two label stacks render ungrouped), label
// strip-drop ungrouping, and tab drags creating a panel at the
// hovered half. The vm DOM stub has no event dispatch, so the tests
// drive the module-level drag entry points directly (same contract as
// paneStripDragOver in the main suite: the inline attributes resolve to
// these exact functions in a classic-script bundle, and the vm context
// exposes top-level function declarations as properties).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const WORKSPACE_PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const workspacePanesScript = new vm.Script(readFileSync(WORKSPACE_PANES_PATH, "utf8"), {
  filename: WORKSPACE_PANES_PATH,
});

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    attributes: {},
    hidden: false,
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
    insertBefore(child, reference) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      const at = reference ? node.children.indexOf(reference) : -1;
      if (at >= 0) node.children.splice(at, 0, child);
      else node.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      if (child.parentNode === node) child.parentNode = null;
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
    contains(node2) {
      let cur = node2;
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
      return { left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 };
    },
    get parentElement() {
      return node.parentNode;
    },
    set innerHTML(value) {
      node.__innerHTML = String(value);
      node.children.length = 0;
    },
    get innerHTML() {
      return node.__innerHTML;
    },
  };
  return node;
}

function buildDom() {
  const container = makeNode("workspacePanes", "workspace-panes");
  const shell = makeNode("terminalShell", "terminal-shell");
  const terminal = makeNode("terminal", "terminal");
  shell.appendChild(terminal);
  container.appendChild(shell);
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
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    body,
  };
  return { container, shell, document };
}

function loadPanes(document, stateWs, timers) {
  const ctx = {
    document,
    localStorage: { getItem: () => null, setItem() {} },
    state: { ws: stateWs, tabs: [], allTabs: [], workspacePanes: {} },
    el: (id) => document.getElementById(id),
    workspaceShellKey: (id) => `ws|${id}`,
    escapeHtml: (v) => String(v),
    escapeAttr: (v) => String(v),
    panelVisibleLabel: () => "panel",
    panelRenameInitialLabel: () => "panel",
    tabTitle: () => "panel",
    tabHoverTitle: () => "",
    titleWithWebuiShortcut: (t) => t,
    workspacePath: () => "/repo",
    selectedOrDefaultWorkspace: () => ({ workspace_id: "ws-1" }),
    panesByTabIndex: () => new Map(),
    go: () => {},
    // v4 dwell clock: dragovers arm it in every test, so the default is
    // a never-firing stub (no stray host timers, the dwell stays inert);
    // the dwell tests inject dwellTimers() for a deterministic fire.
    setTimeout: (timers && timers.setTimeout) || (() => 0),
    clearTimeout: (timers && timers.clearTimeout) || (() => {}),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  workspacePanesScript.runInContext(vm.createContext(ctx));
  const seed = ctx.HerdrWorkspacePanes.paneRoot();
  if (stateWs && seed && seed.kind === "pane" && !seed.wsId) seed.wsId = stateWs;
  return ctx;
}

// A flat three-panel tree: root row of leaves [A, B, C]. Tabs bind each
// leaf to the harness ws so chips render (>1 panel).
function bootFlatThreePanels(ctx, count) {
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  for (let i = 1; i < count; i += 1) panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  ctx.state.tabs = [];
  for (const [i, leaf] of leaves.entries()) {
    const tabId = `tab_${i + 1}`;
    ctx.state.tabs.push({ tab_id: tabId, workspace_id: ctx.state.ws });
    leaf.tabs = [tabId];
    leaf.active = tabId;
    leaf.wsId = ctx.state.ws;
  }
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  return leaves;
}

// Controllable dwell clock for the vm realm: loadPanes injects these
// into the context, and the dwell tests fire the window on demand
// instead of sleeping the 2s window per case.
function dwellTimers() {
  let pending = null;
  return {
    setTimeout(fn, ms) { pending = { fn, ms }; return 1; },
    clearTimeout() { pending = null; },
    armed: () => !!pending,
    windowMs: () => (pending ? pending.ms : null),
    fire() { if (!pending) return; const fn = pending.fn; pending = null; fn(); },
  };
}

function chipHtmlFor(ctx, leaf) {
  const html = ctx.panePanelChipHtml(leaf);
  return html;
}

test("flat root split renders one group chip counting every panel", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  assert.equal(leaves.length, 3, "three panels stand");
  const panes = ctx.HerdrWorkspacePanes;
  panes.focusPanelFor(leaves[2].paneId);
  panes.renderWorkspacePanes();
  const activeHtml = chipHtmlFor(ctx, leaves[2]);
  assert.ok(activeHtml.includes("pane-panel-group-chip"), "focused leaf carries the root group chip");
  assert.ok(activeHtml.includes("\u25A3 3"), "group chip counts every root panel");
  assert.ok(activeHtml.includes(`data-pane-id="${leaves[2].paneId}"`), "chip names the focused panel");
  for (const leaf of [leaves[0], leaves[1]]) {
    const html = chipHtmlFor(ctx, leaf);
    assert.ok(html.includes("pane-panel-chip"), "chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "non-focused leaves keep standalone chips");
    assert.ok(html.includes(`data-pane-id="${leaf.paneId}"`), "chip names its own panel");
  }
});

// Fan-out rule fixtures: flat roots whose panels stack the given
// terminal-label counts. [3, 1] is a collector plus one split view (no
// group: one view is the collector back together), [3, 1, 1] adds the
// second view a group needs, [2, 2] is two collectors side by side.
function bootFlatLeavesWithCounts(ctx, counts) {
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.panesStateFor();
  ctx.state.tabs = [];
  const leaves = [];
  let index = 0;
  entry.root = {
    kind: "row",
    sizes: counts.map(() => 1),
    children: counts.map((count, i) => {
      const tabs = [];
      for (let j = 0; j < count; j += 1) {
        index += 1;
        const tabId = `tab_${index}`;
        ctx.state.tabs.push({ tab_id: tabId, workspace_id: ctx.state.ws });
        tabs.push(tabId);
      }
      const leaf = { kind: "pane", paneId: `fc_${i}`, tabs, active: tabs[0] || null, wsId: ctx.state.ws };
      leaves.push(leaf);
      return leaf;
    }),
  };
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  return leaves;
}

test("collector plus one split view renders ungrouped: no fan-out to count", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatLeavesWithCounts(ctx, [3, 1]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.focusPanelFor(leaves[1].paneId);
  panes.renderWorkspacePanes();
  for (const leaf of leaves) {
    const html = chipHtmlFor(ctx, leaf);
    assert.ok(html.includes("pane-panel-chip"), "standalone chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "a lone view beside its collector is not a group");
  }
});

test("collector plus two split views stays grouped, chip counts the views", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatLeavesWithCounts(ctx, [3, 1, 1]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.focusPanelFor(leaves[1].paneId);
  panes.renderWorkspacePanes();
  const viewHtml = chipHtmlFor(ctx, leaves[1]);
  assert.ok(viewHtml.includes("pane-panel-group-chip"), "focused split view carries the group chip");
  assert.ok(viewHtml.includes("\u25A3 2"), "chip counts the two views, not the collector");
  const collectorHtml = chipHtmlFor(ctx, leaves[0]);
  assert.ok(collectorHtml.includes("pane-panel-chip"), "collector chip renders");
  assert.ok(!collectorHtml.includes("pane-panel-group-chip"), "non-focused collector keeps a standalone chip");
  const otherViewHtml = chipHtmlFor(ctx, leaves[2]);
  assert.ok(!otherViewHtml.includes("pane-panel-group-chip"), "non-focused view keeps a standalone chip");
});

test("two label stacks render ungrouped, no group chip anywhere", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatLeavesWithCounts(ctx, [2, 2]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.focusPanelFor(leaves[0].paneId);
  panes.renderWorkspacePanes();
  for (const leaf of leaves) {
    const html = chipHtmlFor(ctx, leaf);
    assert.ok(html.includes("pane-panel-chip"), "standalone chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "a stacked panel never carries the group chip");
  }
});

test("nested split with two stacks keeps every member ungrouped", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.panesStateFor();
  const memberA = { kind: "pane", paneId: "na", tabs: ["tab_1", "tab_2"], active: "tab_1", wsId: "ws-1" };
  const memberB = { kind: "pane", paneId: "nb", tabs: ["tab_3", "tab_4"], active: "tab_3", wsId: "ws-1" };
  const standalone = { kind: "pane", paneId: "ns", tabs: ["tab_5"], active: "tab_5", wsId: "ws-1" };
  const holder = { kind: "column", sizes: [1, 1], children: [memberA, memberB] };
  entry.root = { kind: "row", sizes: [1, 1], children: [holder, standalone] };
  ctx.state.tabs = ["tab_1", "tab_2", "tab_3", "tab_4", "tab_5"].map((id) => ({ tab_id: id, workspace_id: "ws-1" }));
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  panes.focusPanelFor("na");
  panes.renderWorkspacePanes();
  for (const leaf of panes.paneLeaves(panes.paneRoot())) {
    const html = chipHtmlFor(ctx, leaf);
    assert.ok(html.includes("pane-panel-chip"), "standalone chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "no member groups while two members stack labels");
  }
});

test("single-panel tree renders no chip", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const leaf = panes.paneLeaves(panes.paneRoot())[0];
  assert.equal(chipHtmlFor(ctx, leaf), "", "one panel names itself, no chip");
});

test("group subtree renders the group chip on the focused member and member chips elsewhere", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  // Build [G(a,b), S] by hand: split right from the seed, then nest a
  // column split inside the first slot.
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  // Seed leaf -> wrap into a column group of two.
  const seed = panes.paneLeaves(root)[0];
  const groupInner = {
    kind: "column",
    sizes: [1, 1],
    children: [seed, { kind: "pane", paneId: "grp_member", tabs: [], active: null, wsId: "ws-1" }],
  };
  ctx.HerdrWorkspacePanes.panesStateFor().root = {
    kind: "row",
    sizes: [1, 1],
    children: [groupInner, { kind: "pane", paneId: "standalone", tabs: [], active: null, wsId: "ws-1" }],
  };
  const panes2 = ctx.HerdrWorkspacePanes;
  const newRoot = panes2.paneRoot();
  const leaves = panes2.paneLeaves(newRoot);
  assert.equal(leaves.length, 3, "two group members plus one standalone");
  ctx.state.tabs = leaves.map((leaf, i) => ({ tab_id: `tab_${i + 1}`, workspace_id: "ws-1" }));
  leaves.forEach((leaf, i) => {
    leaf.tabs = [`tab_${i + 1}`];
    leaf.active = `tab_${i + 1}`;
  });
  ctx.state.tab = "tab_1";
  panes2.renderWorkspacePanes();
  // Focus the first group member: its strip carries the group chip.
  panes2.focusPanelFor(leaves[0].paneId);
  panes2.renderWorkspacePanes();
  const focusedHtml = chipHtmlFor(ctx, leaves[0]);
  assert.ok(focusedHtml.includes("pane-panel-group-chip"), "focused member shows the group chip");
  assert.ok(focusedHtml.includes("▣ 2"), "group chip counts its members");
  const memberHtml = chipHtmlFor(ctx, leaves[1]);
  assert.ok(!memberHtml.includes("pane-panel-group-chip"), "other member keeps a standalone chip");
  assert.ok(memberHtml.includes("pane-panel-chip"), "member chip renders for drag-out");
  const standaloneHtml = chipHtmlFor(ctx, leaves[2]);
  assert.ok(!standaloneHtml.includes("pane-panel-group-chip"), "standalone panel never group-chipped");
});

test("maximize mode parks the group chip and the maximized member goes standalone", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  const memberA = { kind: "pane", paneId: "ga", tabs: ["tab_1"], active: "tab_1", wsId: "ws-1" };
  const memberB = { kind: "pane", paneId: "gb", tabs: ["tab_2"], active: "tab_2", wsId: "ws-1" };
  const standalone = { kind: "pane", paneId: "sx", tabs: ["tab_3"], active: "tab_3", wsId: "ws-1" };
  const group = { kind: "column", sizes: [1, 1], children: [memberA, memberB], activePaneId: "ga" };
  entry.root = { kind: "row", sizes: [1, 1], children: [group, standalone] };
  ctx.state.tabs = [
    { tab_id: "tab_1", workspace_id: "ws-1" },
    { tab_id: "tab_2", workspace_id: "ws-1" },
    { tab_id: "tab_3", workspace_id: "ws-1" },
  ];
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  panes.focusPanelFor("ga");
  panes.renderWorkspacePanes();
  assert.ok(chipHtmlFor(ctx, memberA).includes("pane-panel-group-chip"), "visible group carries its chip");
  panes.maximizeActivePane();
  const html = chipHtmlFor(ctx, memberA);
  assert.ok(!html.includes("pane-panel-group-chip"), "maximized member falls back to a standalone chip");
  assert.ok(html.includes("pane-panel-chip"), "standalone chip renders on the maximized member");
  assert.ok(html.includes(`data-pane-id="ga"`), "chip names the maximized panel");
});

function findPaneEl(document, paneId) {
  const container = document.getElementById("workspacePanes");
  const walk = (n) => {
    for (const child of n.children || []) {
      if (child.dataset && child.dataset.paneId === paneId) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(container);
}

// Strip-drop ungroup drive: the drag stub's makeNode has no closest(),
// so paneStripDrop cannot resolve its strip from a bare target. The
// split suite patches closest onto the nodes; here the group-membership
// contract is the point, so the drive stays on the real move primitive
// with the strip's pane id, which is exactly what paneStripDrop calls.
test("label strip-drop out of a group ungroups it beside the group", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  const memberA = { kind: "pane", paneId: "ga", tabs: ["tab_1"], active: "tab_1", wsId: "ws-1" };
  const memberB = { kind: "pane", paneId: "gb", tabs: ["tab_2"], active: "tab_2", wsId: "ws-1" };
  const standalone = { kind: "pane", paneId: "sx", tabs: ["tab_3"], active: "tab_3", wsId: "ws-1" };
  const group = { kind: "column", sizes: [1, 1], children: [memberA, memberB] };
  entry.root = { kind: "row", sizes: [1, 1], children: [group, standalone] };
  ctx.state.tabs = [
    { tab_id: "tab_1", workspace_id: "ws-1" },
    { tab_id: "tab_2", workspace_id: "ws-1" },
    { tab_id: "tab_3", workspace_id: "ws-1" },
  ];
  ctx.state.tab = "tab_3";
  panes.renderWorkspacePanes();
  // Drag gb's label onto the standalone's strip: a cross-pane strip
  // drop arms the emptied source, then the sweep folds it on the next
  // render. movePaneTabTo(skipRender) + the arm + the render is the
  // exact paneStripDrop sequence, driven directly because the drag
  // stub has no closest() for strip resolution.
  assert.ok(panes.movePaneTabTo("tab_2", "sx", null, { skipRender: true }));
  const source = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.paneId === "gb");
  assert.ok(source, "group member stood before the move");
  assert.equal(source.tabs.length, 0, "the strip move emptied the source member");
  source.autoCloseArmed = true;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  const leavesAfter = panes.paneLeaves(root);
  const holder = leavesAfter.find((leaf) => leaf.tabs.includes("tab_2"));
  assert.ok(holder, "dragged label lives in the tree");
  assert.equal(holder.paneId, "sx", "label landed in the standalone panel");
  assert.ok(!leavesAfter.some((leaf) => leaf.paneId === "gb"), "emptied group member folded");
  // The group split died with its last member: the tree is a flat row
  // again. The drop stacked the target to 2 labels, so the root holds
  // one view beside one stack: no group, every chip standalone.
  assert.equal(root.kind, "row", "root stays a row");
  const order = flatChildrenOrder(root, panes);
  assert.deepEqual(order, ["ga", "sx"], "survivors stand as flat root panels");
  for (const paneId of ["ga", "sx"]) {
    const html = chipHtmlFor(ctx, leavesAfter.find((leaf) => leaf.paneId === paneId));
    assert.ok(html.includes("pane-panel-chip"), "standalone chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "one view beside one stack is not a group");
  }
});

test("dragging a view's label home folds the last view into the collector", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  const collector = { kind: "pane", paneId: "ga", tabs: ["tab_1", "tab_2"], active: "tab_1", wsId: "ws-1" };
  const viewA = { kind: "pane", paneId: "gb", tabs: ["tab_3"], active: "tab_3", wsId: "ws-1" };
  const viewB = { kind: "pane", paneId: "gc", tabs: ["tab_4"], active: "tab_4", wsId: "ws-1" };
  entry.root = { kind: "row", sizes: [1, 1, 1], children: [collector, viewA, viewB] };
  ctx.state.tabs = ["tab_1", "tab_2", "tab_3", "tab_4"].map((id) => ({ tab_id: id, workspace_id: "ws-1" }));
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  panes.focusPanelFor("gb");
  panes.renderWorkspacePanes();
  assert.ok(chipHtmlFor(ctx, viewA).includes("\u25A3 2"), "group chip counts both views before the decay");
  // Drag gc's label onto the collector's strip: the real gesture stamps
  // the pre-state, and the drop's own render folds the last view home.
  const paneEl = findPaneEl(document, "ga");
  assert.ok(paneEl, "collector pane rendered");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_4" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneStripDrop({ target: { closest: (selector) => (selector === ".workspace-pane" ? paneEl : null) }, preventDefault() {} });
  const root = panes.paneRoot();
  const leavesAfter = panes.paneLeaves(root);
  assert.equal(leavesAfter.length, 1, "decayed group collapsed to the collector panel");
  assert.equal(root.kind, "pane", "single-panel tree keeps the flat leaf contract");
  assert.equal(leavesAfter[0].paneId, "ga", "the collector survives");
  const tabs = [...leavesAfter[0].tabs];
  assert.ok(tabs.includes("tab_3"), "the last view's label folded into the collector");
  assert.ok(tabs.includes("tab_4"), "the dragged label landed in the collector");
  assert.equal(panes.activePane().paneId, "ga", "focus lands on the collector");
});

test("closing a view out of a decaying group folds the last view into the collector", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  // Tree order puts the surviving view FIRST: without the close-path
  // redirect the closed view's label would migrate to that sibling,
  // stacking it to a second collector, and the group would die with
  // zero views (no fold, tree stays two collectors). The redirect
  // hands the label to the collector, so the fold collapses all the
  // way to one panel here.
  const viewA = { kind: "pane", paneId: "gb", tabs: ["tab_3"], active: "tab_3", wsId: "ws-1" };
  const collector = { kind: "pane", paneId: "ga", tabs: ["tab_1", "tab_2"], active: "tab_1", wsId: "ws-1" };
  const viewB = { kind: "pane", paneId: "gc", tabs: ["tab_4"], active: "tab_4", wsId: "ws-1" };
  entry.root = { kind: "row", sizes: [1, 1, 1], children: [viewA, collector, viewB] };
  ctx.state.tabs = ["tab_1", "tab_2", "tab_3", "tab_4"].map((id) => ({ tab_id: id, workspace_id: "ws-1" }));
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  assert.equal(await panes.closePaneFor("gc"), true, "close accepted");
  const root = panes.paneRoot();
  const leavesAfter = panes.paneLeaves(root);
  assert.equal(leavesAfter.length, 1, "the group folded into a single collector panel");
  assert.equal(root.kind, "pane", "single-panel tree keeps the flat leaf contract");
  assert.equal(leavesAfter[0].paneId, "ga", "the collector survives");
  const tabs = [...leavesAfter[0].tabs];
  assert.ok(tabs.includes("tab_3") && tabs.includes("tab_4"), "both views' labels folded into the collector");
  assert.equal(panes.activePane().paneId, "ga", "focus lands on the collector");
});

function flatChildrenOrder(root, panes) {
  // Copy into a host-realm array: the vm realm's Array prototype fails
  // the host's deepStrictEqual even with identical contents.
  const order = root.children
    .flatMap((c) => (c.kind === "pane" ? [c.paneId] : panes.paneLeaves(c).map((l) => l.paneId)));
  return [...order];
}

function hostArray(list) {
  return [...list];
}

test("dragover positions the dotted preview square and dragend clears it", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  ctx.paneTabDragStart({ target: { dataset: { tabId: leaves[1].tabs[0] } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 290,
    clientY: 15,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview overlay created");
  assert.equal(preview.className, "panel-drop-preview", "preview carries the v3 class");
  assert.equal(preview.style.display, "block", "preview visible during dragover");
  assert.equal(preview.style.left, "150px", "right half of the pane");
  assert.equal(preview.style.width, "150px", "half the pane width");
  ctx.paneTabDragEnd();
  assert.equal(preview.style.display, "none", "dragend hides the preview");
});

test("tab drop on a pane half creates a fresh panel holding the dragged tab", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = findPaneEl(document, leaves[0].paneId);
  assert.ok(paneEl, "drop target pane rendered");
  // The strip wiring calls paneTabDragStart; drive it, then the
  // container-level tab drop.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_2" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  const leavesAfter = panes.paneLeaves(root);
  // v3.2: the drag emptied the source leaf (armed), so the sweep folds
  // it on the same render: the fresh panel takes the tab, the tree
  // keeps two panels (the untouched sibling + the fresh one).
  assert.equal(leavesAfter.length, 2, "drop minted a fresh panel and folded the emptied source");
  const holder = leavesAfter.find((leaf) => leaf.tabs.includes("tab_2"));
  assert.ok(holder, "dragged tab lives in the tree");
  assert.notEqual(holder.paneId, leaves[1].paneId, "the tab moved to a NEW panel");
  assert.ok(!leavesAfter.some((leaf) => leaf.paneId === leaves[1].paneId), "emptied source left the tree");
});

test("tab drop on its own pane half splits that pane instead of refusing", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const rootBefore = panes.paneRoot();
  const source = panes.paneLeaves(rootBefore)[0];
  const paneEl = findPaneEl(document, source.paneId);
  assert.ok(paneEl, "source pane rendered");
  // Drop tab_1 on the right half of ITS OWN pane: previously a hard refusal
  // (targetLeaf === source return), now the pane splits and the tab moves.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const leavesAfter = panes.paneLeaves(panes.paneRoot());
  // v3.2: the own-pane half drop is a split gesture: the fresh half
  // takes the tab and the emptied remaining half STANDS like a fresh
  // split, so the tree grows by one panel.
  assert.equal(leavesAfter.length, 3, "own-pane drop minted a fresh panel");
  const holder = leavesAfter.find((leaf) => leaf.tabs.includes("tab_1"));
  assert.ok(holder, "dragged tab lives in the tree");
  assert.notEqual(holder.paneId, source.paneId, "the tab moved to the new half panel");
  assert.ok(leavesAfter.some((leaf) => leaf.paneId === source.paneId && !leaf.tabs.length), "emptied half stands as a fresh split");
});

test("tab drop on a single-panel tree splits that panel instead of refusing", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const leaf = panes.paneLeaves(panes.paneRoot())[0];
  ctx.state.tabs = [{ tab_id: "tab_1", workspace_id: ctx.state.ws }];
  leaf.tabs = ["tab_1"];
  leaf.active = "tab_1";
  leaf.wsId = ctx.state.ws;
  panes.renderWorkspacePanes();
  const paneEl = findPaneEl(document, leaf.paneId);
  assert.ok(paneEl, "single pane rendered");
  // The most common first gesture on a fresh tree: drag the only tab to a
  // half. Previously paneLeaves < 2 returned; now it splits.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // Chrome only fires drop when the last dragenter/dragover canceled, so
  // the dragover guard must accept the single-panel own-pane hover too
  // or the browser never delivers the drop that would split.
  let canceled = false;
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() { canceled = true; },
    dataTransfer: { dropEffect: null },
  });
  assert.ok(canceled, "dragover cancels on the single-panel own-pane hover");
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const leavesAfter = panes.paneLeaves(panes.paneRoot());
  // v3.2: single-panel own-pane drop is the split gesture too: the
  // fresh half holds the tab and the emptied original half stands.
  assert.equal(leavesAfter.length, 2, "single-panel drop split the tree");
  const holder = leavesAfter.find((l) => l.tabs.includes("tab_1"));
  assert.ok(holder, "dragged tab lives in the fresh half");
  assert.notEqual(holder.paneId, leaf.paneId, "the tab moved to the new half panel");
});

test("dragenter positions the preview square so fast releases still drop", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, panes.paneLeaves(panes.paneRoot())[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  // Chrome fires drop only when the current target's last dragenter or
  // dragover was canceled. A quick release after crossing an element
  // boundary sees dragenter with NO dragover yet; the dragenter path must
  // cancel too or those drops vanish. Drive the wiring's dragenter
  // handlers directly: the vm stub has no event dispatch.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  const dragenterHandlers = container.listeners.dragenter || [];
  // v4: one dragenter handler (the tab drag owns the whole payload; the
  // chip-drag handler is gone).
  assert.equal(dragenterHandlers.length, 1, "container wired one dragenter handler");
  for (const handler of dragenterHandlers) {
    handler({
      target: paneEl,
      clientX: 290,
      clientY: 15,
      preventDefault() {},
      dataTransfer: { dropEffect: null },
    });
  }
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview exists during the tab drag");
  assert.equal(preview.style.display, "block", "dragenter alone positions the preview square");
  ctx.paneTabDragEnd();
  assert.equal(preview.style.display, "none", "dragend still clears");
});

test("dead-center cross refuses: no preview, no drop, nothing moves", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, panes.paneLeaves(panes.paneRoot())[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  const leavesBefore = panes.paneLeaves(panes.paneRoot()).length;
  ctx.paneTabDragStart({ target: { dataset: { tabId: leaves[2].tabs[0] } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // (150,50) is the middle cross of the 300x100 pane: inside every third,
  // so no corner owns it and nothing must accept.
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview ? preview.style.display : undefined, undefined, "no preview paints in the dead cross");
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
  });
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, leavesBefore, "dead-center drop moved nothing");
  // A mid-edge point (150,10) is in the top third vertically but the
  // middle third horizontally: still no corner, still dead.
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 150,
    clientY: 10,
    preventDefault() {},
  });
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, leavesBefore, "mid-edge drop moved nothing");
  ctx.paneTabDragEnd();
});

test("corner proximity picks the axis by the nearer border", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, panes.paneLeaves(panes.paneRoot())[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // Top-LEFT corner, nearer the top border (dy=0.1 < dx=0.15): a column
  // split with the fresh panel FIRST (above).
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 45,
    clientY: 10,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  let preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview exists in the corner");
  assert.equal(preview.style.top, "0px", "nearer top border paints the top half");
  assert.equal(preview.style.left, "0px", "column split covers the full width");
  assert.equal(preview.style.width, "300px", "column split strip spans the pane width");
  assert.equal(preview.style.height, "50px", "column split strip is half the pane height");
  ctx.paneTabDragEnd();
  assert.equal(preview.style.display, "none", "dragend clears between cases");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // Top-LEFT corner, nearer the left border (dx=0.05 < dy=0.1): a row
  // split with the fresh panel FIRST (left).
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.left, "0px", "nearer left border paints the left half");
  assert.equal(preview.style.top, "0px", "row split covers the full height");
  assert.equal(preview.style.width, "150px", "left half of the pane width");
  assert.equal(preview.style.height, "100px", "row split strip spans the pane height");
  ctx.paneTabDragEnd();
});

test("abandoned tab drag clears the shared preview square on dragend", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_2" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 290,
    clientY: 15,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview exists during the tab drag");
  assert.equal(preview.style.display, "block", "preview visible mid-drag");
  // Abandon the drag (no drop): dragend must clear the square, else the
  // dotted indicator sticks over the last hovered half.
  ctx.paneTabDragEnd();
  assert.equal(preview.style.display, "none", "dragend hides the preview square");
});

test("leaving a corner into the dead cross clears the painted preview", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  bootFlatThreePanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, panes.paneLeaves(panes.paneRoot())[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  // Corner pass paints the square, then the pointer rides into the dead
  // cross mid-drag. The square must clear on the dead dragover, not stick
  // on the last corner half until dragend (live CDP drag found exactly
  // that stuck square).
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_1" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "corner pass paints the square");
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  assert.equal(preview.style.display, "none", "dead-cross dragover clears the stale square");
  ctx.paneTabDragEnd();
});

test("dwell arms on corner hover and locks after the window", () => {
  const { document } = buildDom();
  const timers = dwellTimers();
  const ctx = loadPanes(document, "ws-1", timers);
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  ctx.paneTabDragStart({ target: { dataset: { tabId: leaves[2].tabs[0] } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  const dragEvent = (x, y) => ({
    target: paneEl,
    clientX: x,
    clientY: y,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  // Corner hover arms the clock; the outline waits for the window.
  ctx.paneContainerTabDragOver(dragEvent(15, 10));
  assert.ok(timers.armed(), "corner hover arms the dwell clock");
  assert.ok(timers.windowMs() > 0, "the clock runs a real window");
  assert.equal(document.getElementById("paneDwellOutline"), null, "no outline before the window passes");
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "unlocked hover still paints the half preview");
  // Crossing the dead cross mid-pane keeps the same pane armed: the
  // pointer never left the pane, the clock must not restart.
  ctx.paneContainerTabDragOver(dragEvent(150, 50));
  assert.ok(timers.armed(), "dead-cross hover keeps the clock armed");
  // Re-hovering the same pane is a no-op: the window keeps running.
  ctx.paneContainerTabDragOver(dragEvent(15, 10));
  assert.ok(timers.armed(), "re-hover does not restart the clock");
  assert.equal(document.getElementById("paneDwellOutline"), null, "still no outline mid-window");
  timers.fire();
  ctx.paneContainerTabDragOver(dragEvent(15, 10));
  const outline = document.getElementById("paneDwellOutline");
  assert.ok(outline, "outline paints once the dwell locks");
  assert.equal(outline.className, "pane-dwell-outline", "outline carries the dwell class");
  assert.equal(outline.parentNode, paneEl, "outline lives inside the locked pane");
  // Locked: the half preview yields so the two indicators never stack.
  assert.equal(preview.style.display, "none", "half preview hidden while locked");
  ctx.paneTabDragEnd();
  assert.equal(document.getElementById("paneDwellOutline"), null, "dragend clears the outline");
});

test("dwell lock forces the nest landing in the would-extend case", () => {
  const { document } = buildDom();
  const timers = dwellTimers();
  const ctx = loadPanes(document, "ws-1", timers);
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  ctx.paneTabDragStart({ target: { dataset: { tabId: leaves[2].tabs[0] } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  const dragEvent = (x, y) => ({
    target: paneEl,
    clientX: x,
    clientY: y,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  // Capture the dragged id before the move: the source leaf's tabs
  // splice empties during the drop, and re-reading leaves[2].tabs[0]
  // after it would look up undefined.
  const draggedTab = leaves[2].tabs[0];
  // (15,10) hugs the LEFT border: row axis, first half. On the flat
  // root the parent row runs the drop axis, so without the dwell the
  // extend path would mint a flat sibling; locked, the target pane
  // splits INSIDE itself.
  ctx.paneContainerTabDragOver(dragEvent(15, 10));
  timers.fire();
  ctx.paneContainerTabDragOver(dragEvent(15, 10));
  assert.ok(document.getElementById("paneDwellOutline"), "dwell locked the target pane");
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
  });
  assert.equal(document.getElementById("paneDwellOutline"), null, "drop clears the outline");
  const root = panes.paneRoot();
  const targetSlot = root.children.find((child) => child && child.kind !== "pane"
    && panes.paneLeaves(child).some((l) => l.paneId === leaves[0].paneId));
  assert.ok(targetSlot, "target pane nested in its own split");
  assert.equal(targetSlot.kind, "row", "left corner nests a row split inside the target");
  const nested = panes.paneLeaves(targetSlot);
  assert.equal(nested.length, 2, "nested split pairs the target with the fresh half");
  assert.equal(nested[1].paneId, leaves[0].paneId, "original target keeps its slot inside the nest");
  assert.equal(root.children.length, 2, "root keeps the untouched sibling beside the nested split");
  const allLeaves = panes.paneLeaves(root);
  const holder = allLeaves.find((leaf) => leaf.tabs.includes(draggedTab));
  assert.ok(holder, "dragged tab lives in the tree");
  assert.ok(nested.some((leaf) => leaf.paneId === holder.paneId), "dragged tab moved into the fresh half");
  assert.notEqual(holder.paneId, leaves[2].paneId, "the tab left its original panel");
  assert.ok(!allLeaves.some((leaf) => leaf.paneId === leaves[2].paneId), "emptied source folded");
});

test("quick corner drop without dwell keeps the extend landing", () => {
  const { document } = buildDom();
  const timers = dwellTimers();
  const ctx = loadPanes(document, "ws-1", timers);
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  // Capture before the move: the source leaf's tabs splice empties
  // during the drop.
  const draggedTab = leaves[2].tabs[0];
  ctx.paneTabDragStart({ target: { dataset: { tabId: draggedTab } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerTabDragOver({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  assert.ok(timers.armed(), "the clock runs but its window has not passed");
  ctx.paneContainerTabDrop({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  // No dwell: the flat row extends, the fresh panel lands as a direct
  // root child beside the target; the armed emptied source folds.
  assert.equal(root.kind, "row", "root stays a row");
  assert.equal(root.children[0].kind, "pane", "no nested split: plain extend");
  const order = flatChildrenOrder(root, panes);
  assert.equal(order.length, 3, "fresh panel in, emptied source out");
  assert.deepEqual(order.slice(1), [leaves[0].paneId, leaves[1].paneId], "target and middle keep their root slots");
  const holder = panes.paneLeaves(root).find((leaf) => leaf.tabs.includes(draggedTab));
  assert.ok(holder, "dragged tab lives in the tree");
  assert.equal(order[0], holder.paneId, "the fresh panel took the leading root slot");
  assert.notEqual(holder.paneId, leaves[2].paneId, "the tab left its original panel");
});
