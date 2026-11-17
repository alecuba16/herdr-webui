// v3 drag mechanics coverage: half-region chip drops with the dotted
// preview square, group chips (icon + member count) on split subtrees,
// group drags moving the whole subtree, member drag-out ungrouping, and
// tab drags creating a panel at the hovered half. The vm DOM stub has
// no event dispatch, so the tests drive the module-level drag entry
// points directly (same contract as paneStripDragOver in the main
// suite: the inline attributes resolve to these exact functions in a
// classic-script bundle, and the vm context exposes top-level function
// declarations as properties).
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

function loadPanes(document, stateWs) {
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

// A grouped tree: root row [G, S] where G is a column split of two
// leaves (the group) and S is a standalone leaf. Built by hand so the
// membership is unambiguous.
function bootGroupedTree(ctx) {
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
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

test("root group chip drag reorders the member within the flat root", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  panes.focusPanelFor(leaves[2].paneId);
  panes.renderWorkspacePanes();
  // Group chip drag from the focused member: the whole root is the
  // group, so no outside exists and the drop must reorder the member.
  ctx.paneGroupChipDragStart({ target: { dataset: { paneId: leaves[2].paneId } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  const paneEl = findPaneEl(document, leaves[0].paneId);
  assert.ok(paneEl, "target pane rendered");
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  assert.equal(root.kind, "row", "root stays a flat row");
  assert.deepEqual(flatChildrenOrder(root, panes), [leaves[0].paneId, leaves[2].paneId, leaves[1].paneId],
    "root group drag reorders the member beside the target");
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

test("chip drop on a pane half re-docks the dragged leaf beside the target", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const dragged = leaves[2];
  const target = leaves[0];
  ctx.panePanelChipDragStart({ target: { dataset: { paneId: dragged.paneId } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // paneDragPanelId is a let binding in the module scope: vm exposes only
  // var/function on the context, so the drop's behavior is the assertable
  // contract (the drag state itself is not reachable from outside).
  // The pane elements sit inside .pane-row wrappers; walk the tree.
  const paneEl = findPaneEl(document, target.paneId);
  assert.ok(paneEl, "target pane rendered");
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  // The dragged leaf now sits directly right of the target inside the
  // same row split (extend path: target's parent runs the drop axis).
  assert.ok(panes.paneLeaves(root).includes(dragged), "dragged leaf survived");
  assert.deepEqual(flatChildrenOrder(root, panes), [target.paneId, dragged.paneId, leaves[1].paneId],
    "dragged leaf lands between target and the old middle leaf");
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
  ctx.panePanelChipDragStart({ target: { dataset: { paneId: leaves[1].paneId } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerPanelDragOver({
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
  ctx.panePanelChipDragEnd();
  assert.equal(preview.style.display, "none", "dragend hides the preview");
});

test("group chip drag with an outside drop moves the whole group subtree", () => {
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
  // Group chip drag: the chip's data-pane-id is the focused member.
  ctx.paneGroupChipDragStart({ target: { dataset: { paneId: "ga" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  const paneEl = findPaneEl(document, "sx");
  assert.ok(paneEl, "standalone pane rendered");
  // Drop on the standalone's right half: the group moves beside it.
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  assert.equal(root.kind, "row", "root stays a row");
  const ids = hostArray(root.children.map((c) => (c.kind === "pane" ? c.paneId : `split(${panes.paneLeaves(c).length})`)));
  assert.deepEqual(ids, ["sx", "split(2)"], "whole group re-docked after the standalone");
  const groupNode = root.children[1];
  assert.deepEqual(hostArray(panes.paneLeaves(groupNode).map((l) => l.paneId)), ["ga", "gb"], "group membership intact");
});

test("member chip drag-out of the group ungroups it beside the group", () => {
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
  const paneEl = findPaneEl(document, "sx");
  // Member drag (no group flag): the member alone re-docks.
  ctx.panePanelChipDragStart({ target: { dataset: { paneId: "gb" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 21,
    clientY: 20,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  const flatOrder = flatChildrenOrder(root, panes);
  assert.ok(flatOrder.includes("gb"), "ungrouped member survived");
  assert.ok(!flatOrder.includes(undefined), "tree healthy");
  // The group shrank: ga and gb no longer share one split parent.
  const leaves = panes.paneLeaves(root);
  assert.equal(leaves.length, 3, "all three panels still stand");
  const parentIds = leaves.map((leaf) => root.children.indexOf(
    root.children.find((c) => c === leaf || (c.kind !== "pane" && panes.paneLeaves(c).includes(leaf))),
  ));
  const distinct = new Set(parentIds);
  assert.equal(distinct.size, 3, "no two leaves share a split parent anymore");
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
  assert.ok(dragenterHandlers.length >= 2, "container wired dragenter handlers");
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
  // And the chip-drag dragenter handler accepts the payload too.
  ctx.paneTabDragEnd();
  assert.equal(preview.style.display, "none", "dragend still clears");
});

test("dead-center cross refuses: no preview, no drop, nothing moves", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  bootFlatThreePanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, panes.paneLeaves(panes.paneRoot())[0].paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  const leavesBefore = panes.paneLeaves(panes.paneRoot()).length;
  ctx.panePanelChipDragStart({ target: { dataset: { paneId: panes.paneLeaves(panes.paneRoot())[2].paneId } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // (150,50) is the middle cross of the 300x100 pane: inside every third,
  // so no corner owns it and nothing must accept.
  ctx.paneContainerPanelDragOver({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview ? preview.style.display : undefined, undefined, "no preview paints in the dead cross");
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
  });
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, leavesBefore, "dead-center drop moved nothing");
  // A mid-edge point (150,10) is in the top third vertically but the
  // middle third horizontally: still no corner, still dead.
  ctx.paneContainerPanelDrop({
    target: paneEl,
    clientX: 150,
    clientY: 10,
    preventDefault() {},
  });
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, leavesBefore, "mid-edge drop moved nothing");
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
  let preview = document.getElementById("panelDropPreview");
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
  // Same contract on the chip drag path.
  ctx.panePanelChipDragStart({ target: { dataset: { paneId: panes.paneLeaves(panes.paneRoot())[1].paneId } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneContainerPanelDragOver({
    target: paneEl,
    clientX: 15,
    clientY: 10,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "corner pass paints the square (chip)");
  ctx.paneContainerPanelDragOver({
    target: paneEl,
    clientX: 150,
    clientY: 50,
    preventDefault() {},
    dataTransfer: { dropEffect: null },
  });
  assert.equal(preview.style.display, "none", "dead-cross dragover clears the stale square (chip)");
  ctx.panePanelChipDragEnd();
});
