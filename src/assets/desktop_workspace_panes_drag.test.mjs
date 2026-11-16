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

test("flat multi-panel tree renders one standalone chip per strip, no group chip", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const leaves = bootFlatThreePanels(ctx, 3);
  assert.equal(leaves.length, 3, "three panels stand");
  for (const leaf of leaves) {
    const html = chipHtmlFor(ctx, leaf);
    assert.ok(html.includes("pane-panel-chip"), "chip renders");
    assert.ok(!html.includes("pane-panel-group-chip"), "flat tree has no group chip");
    assert.ok(html.includes(`data-pane-id="${leaf.paneId}"`), "chip names its own panel");
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
    clientX: 18,
    clientY: 12,
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
    clientX: 200,
    clientY: 40,
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
    clientX: 18,
    clientY: 12,
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
    clientX: 18,
    clientY: 12,
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
    clientX: 18,
    clientY: 12,
    preventDefault() {},
  });
  const root = panes.paneRoot();
  const leavesAfter = panes.paneLeaves(root);
  assert.equal(leavesAfter.length, 3, "drop minted a fresh panel");
  const holder = leavesAfter.find((leaf) => leaf.tabs.includes("tab_2"));
  assert.ok(holder, "dragged tab lives in the tree");
  assert.notEqual(holder.paneId, leaves[1].paneId, "the tab moved to a NEW panel");
  assert.deepEqual([...leaves[1].tabs], [], "source leaf emptied");
});