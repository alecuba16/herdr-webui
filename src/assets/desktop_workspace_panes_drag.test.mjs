// One-visible-view model drag coverage: the label rail drag pipeline
// (dragstart state + payload, dragover quadrant preview, drop create or
// grow a group), the auto-join neighbor rule, the ungroup gesture through
// paneTabUnsplitHover/Drop, the rail chip HTML wiring, the preview square
// lifecycle, and the rule that tab drags never split. The vm DOM stub
// has no event dispatch, so the tests drive the module-level drag entry
// points directly (same contract as the main suite: the inline
// attributes resolve to these exact functions in a classic-script
// bundle, and the vm context exposes top-level function declarations as
// properties).
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
    closest(selector) {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      let cur = node;
      while (cur) {
        if (wantClass && cur.className.split(/\s+/).includes(wantClass)) return cur;
        cur = cur.parentNode;
      }
      return null;
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
  return { container, document };
}

// Storage-backed loader (same contract as the split suite): the store
// captures the persisted session entry so drops assert the save too.
function loadPanes(document, stateWs, stored) {
  const storage = {};
  if (stored != null) storage["herdr-web-workspace-panes"] = stored;
  const ctx = {
    document,
    localStorage: {
      getItem(key) { return storage[key] || null; },
      setItem(key, value) { storage[key] = value; },
      removeItem(key) { delete storage[key]; },
    },
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
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  workspacePanesScript.runInContext(vm.createContext(ctx));
  ctx.__storage = storage;
  // Collector model: the boot seed panel starts unbound. Binding it to
  // the harness ws up front keeps the sync's focus-or-mint pass from
  // minting a second panel on the first render (same note as the split
  // suite's loader).
  if (stateWs) {
    const entry = ctx.HerdrWorkspacePanes.paneRoot();
    const seed = entry.panels && entry.panels[0];
    if (seed && !seed.wsId) seed.wsId = stateWs;
  }
  return ctx;
}

// Seed the session with N panels, one tab each, all bound to the harness
// ws. The first seed panel is the module-minted p1; the rest are pushed
// by hand with the same leaf shape. Rows always carry workspace_id (a
// row without it reads as a snapshot race and the sync leaves the id
// homeless, same contract as bootstrapPanes in the split suite).
function seedPanels(ctx, count) {
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  const leaves = [entry.panels[0]];
  entry.panels[0].tabs = ["tab_1"];
  entry.panels[0].active = "tab_1";
  for (let i = 2; i <= count; i += 1) {
    const leaf = { kind: "pane", paneId: `p${i}`, tabs: [`tab_${i}`], active: `tab_${i}`, wsId: ctx.state.ws, groupId: null };
    entry.panels.push(leaf);
    leaves.push(leaf);
  }
  ctx.state.tabs = [];
  for (let i = 1; i <= count; i += 1) ctx.state.tabs.push({ tab_id: `tab_${i}`, workspace_id: ctx.state.ws });
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  return leaves;
}

// The rail node (chrome built by renderLabelRail inside the render pass).
function railOf(document) {
  return document.getElementById("workspacePanes").querySelector(".pane-label-rail");
}

// The deepest .workspace-pane with dataset.paneId (same walk the module's
// findPaneElementById uses; needed because the stub querySelector only
// supports #id and .class).
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

// Drag event factory: the stub DOM never dispatches, the tests drive the
// entry points with these crafted events.
function dragEvent(target, clientX, clientY) {
  return {
    target,
    clientX,
    clientY,
    preventDefault() {},
    dataTransfer: {
      _data: {},
      setData(key, value) { this._data[key] = value; },
      getData(key) { return this._data[key] || ""; },
      dropEffect: null,
      effectAllowed: "",
    },
  };
}

// Fix the pane rect once so the quadrant math sees a 300x100 pane and
// the container a 300x200 host (same geometry as the old suite).
function fixRects(document, paneId) {
  const container = document.getElementById("workspacePanes");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 });
  const paneEl = findPaneEl(document, paneId);
  paneEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  return paneEl;
}

// Hand-built group record for the render/ungroup tests: the notes.md data
// model allows explicit records (the old suite hand-built trees the same
// way), and this keeps those tests independent of the drop wiring.
function buildGroup(ctx, memberIds, layout) {
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  const groupId = "g1";
  entry.groups.push({ groupId, name: null, memberIds: [...memberIds], layout });
  for (const id of memberIds) {
    entry.panels.find((l) => l.paneId === id).groupId = groupId;
  }
  entry.visible = { type: "group", id: groupId };
  panes.renderWorkspacePanes();
  return entry.groups[0];
}

// Local layout copy helper: vm-realm arrays fail the host deepEqual, and
// the layout mints a splitId the spec does not name; strip both so the
// assertions compare shape only.
function stripSplitIds(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(stripSplitIds);
  const out = { kind: node.kind, sizes: [...node.sizes] };
  out.children = node.children.map(stripSplitIds);
  return out;
}

// vm objects fail the host deepStrictEqual (realm prototypes), so the
// drag-kind probes compare by field.
function assertDragKind(kind, expectedKind, expectedId, label) {
  assert.ok(kind, `drag kind present (${label})`);
  assert.equal(kind.kind, expectedKind, `drag kind (${label})`);
  assert.equal(kind.tabId !== undefined ? kind.tabId : kind.paneId, expectedId, `drag id (${label})`);
}

// Quadrant points on the 300x100 pane: column corners need dy <= dx, so
// the horizontal offset sits at fx=0.3 (near-border but wider than the
// vertical offset) and the row corners hug the left/right borders.
const P_LEFT = [5, 10];
const P_RIGHT = [295, 10];
const P_TOP = [90, 5];
const P_BOTTOM = [90, 95];

// ---- 1. label dragstart/end state + payload -------------------------------

test("label dragstart arms the drag state, sets the payload, marks the chip", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  assert.equal(ctx.paneLabelDragKind(), null, "no drag state before start");
  // The chip must live in the DOM tree: paneLabelDragEnd clears the
  // dragging class through document.querySelectorAll(".pane-label-dragging"),
  // so a detached node would never get scrubbed. A real classList object
  // records the class for the assertions.
  const chip = makeNode("chip_p2", "pane-label-chip");
  // classList writes through to className: paneLabelDragEnd finds the
  // chip through document.querySelectorAll(".pane-label-dragging"),
  // which matches on className, so a detached classList would hide it.
  chip.classList = {
    add(n) { chip.className += ` ${n}`; },
    remove(n) { chip.className = chip.className.split(/\s+/).filter((c) => c && c !== n).join(" "); },
  };
  document.getElementById("workspacePanes").appendChild(chip);
  const event = dragEvent(chip, 0, 0);
  panes.paneLabelDragStart(event, encodeURIComponent("p2"));
  assertDragKind(ctx.paneLabelDragKind(), "label", "p2", "dragstart arms the label state");
  assert.equal(event.dataTransfer.getData("text/herdr-pane-label"), "p2", "payload carries the paneId");
  assert.equal(event.dataTransfer.effectAllowed, "move", "payload allows move");
  assert.ok(chip.className.split(/\s+/).includes("pane-label-dragging"), "chip carries the dragging class");
  // A paneId that resolves to no panel changes nothing (the rail only
  // renders real chips, a foreign payload must not fake or clear a
  // drag: the early return leaves the armed state alone).
  panes.paneLabelDragStart(dragEvent(chip, 0, 0), encodeURIComponent("nope"));
  assertDragKind(ctx.paneLabelDragKind(), "label", "p2", "unknown paneId leaves the armed state");
  panes.paneLabelDragEnd();
  assert.equal(ctx.paneLabelDragKind(), null, "dragend clears the drag state");
  assert.ok(!chip.className.split(/\s+/).includes("pane-label-dragging"), "dragend removes the dragging class");
});

test("activeDragKind answers label first, tab second", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const chip = makeNode("chip_p2", "pane-label-chip");
  panes.paneLabelDragStart(dragEvent(chip, 0, 0), encodeURIComponent("p2"));
  assertDragKind(ctx.activeDragKind(), "label", "p2", "label drag answers label");
  panes.paneLabelDragEnd();
  const tabEvent = { target: { dataset: { tabId: "tab_1" } }, dataTransfer: { _data: {}, setData(k, v) { this._data[k] = v; }, getData(k) { return this._data[k] || ""; }, effectAllowed: "" } };
  ctx.paneTabDragStart(tabEvent);
  assertDragKind(ctx.activeDragKind(), "tab", "tab_1", "tab dragstart answers tab");
  assert.equal(tabEvent.dataTransfer.getData("text/herdr-pane-tab"), "tab_1", "tab drag sets the tab payload");
  assert.equal(tabEvent.dataTransfer.effectAllowed, "move", "tab payload allows move");
  ctx.paneTabDragEnd();
  assert.equal(ctx.activeDragKind(), null, "dragend leaves no drag kind");
});

test("label dragend clears a painted preview square", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_RIGHT), encodeURIComponent("p2"));
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_RIGHT));
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview overlay created");
  assert.equal(preview.style.display, "block", "preview visible during dragover");
  // Abandoning a label drag (no drop) must clear the square, else the
  // dotted indicator sticks over the last hovered half.
  panes.paneLabelDragEnd();
  assert.equal(preview.style.display, "none", "label dragend hides the preview");
});

// ---- 2. dragover preview quadrant geometry --------------------------------

// Quadrant geometry trace (panelDropTargetAt): fx/fy thirds, near-border
// zones only; dy <= dx stacks (column), else sides (row). Row first is
// the LEFT half, column first is the TOP half. Dead center (both middle
// thirds) refuses and clears a stale square.
test("dragover paints the quadrant half for all four corners", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  const cases = [
    // [point, expectLeft, expectTop, expectWidth, expectHeight, note]
    [P_LEFT, "0px", "0px", "150px", "100px", "left corner: row first half"],
    [P_RIGHT, "150px", "0px", "150px", "100px", "right corner: row second half"],
    [P_TOP, "0px", "0px", "300px", "50px", "top corner: column first half"],
    [P_BOTTOM, "0px", "50px", "300px", "50px", "bottom corner: column second half"],
  ];
  for (const [[x, y], left, top, width, height, note] of cases) {
    panes.paneLabelDragStart(dragEvent(paneEl, x, y), encodeURIComponent("p2"));
    const event = dragEvent(paneEl, x, y);
    let canceled = false;
    event.preventDefault = () => { canceled = true; };
    panes.paneContainerTabDragOver(event);
    const preview = document.getElementById("panelDropPreview");
    assert.ok(preview, `preview exists (${note})`);
    assert.equal(preview.style.display, "block", `preview visible (${note})`);
    assert.equal(preview.style.left, left, `half left (${note})`);
    assert.equal(preview.style.top, top, `half top (${note})`);
    assert.equal(preview.style.width, width, `half width (${note})`);
    assert.equal(preview.style.height, height, `half height (${note})`);
    assert.ok(canceled, `dragover cancels so Chrome can deliver the drop (${note})`);
    assert.equal(event.dataTransfer.dropEffect, "move", `dropEffect move (${note})`);
    assert.equal(preview.className, "panel-drop-preview", `preview class (${note})`);
    panes.paneLabelDragEnd();
  }
});

test("dead-center dragover refuses: no cancel, stale square clears", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p2"));
  // Corner pass paints the square first.
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "corner pass paints the square");
  // (150,50) sits inside every middle third: no corner owns it, the
  // dragover must not cancel and must clear the stale square (a stuck
  // square was the live-CDP bug the old suite pinned too).
  let canceled = false;
  const dead = dragEvent(paneEl, 150, 50);
  dead.preventDefault = () => { canceled = true; };
  panes.paneContainerTabDragOver(dead);
  assert.equal(canceled, false, "dead-center dragover does not cancel");
  assert.equal(preview.style.display, "none", "dead-center dragover clears the stale square");
  // A mid-edge point (150,10) is in the top third vertically but the
  // middle third horizontally: still no corner, still dead.
  panes.paneContainerTabDragOver(dragEvent(paneEl, 150, 10));
  assert.equal(preview.style.display, "none", "mid-edge dragover stays refused");
  panes.paneLabelDragEnd();
});

test("dragover on a strip skips: no preview paints", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  const strip = paneEl.querySelector(".pane-tab-strip");
  assert.ok(strip, "visible pane carries its strip");
  panes.paneLabelDragStart(dragEvent(strip, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDragOver(dragEvent(strip, ...P_LEFT));
  assert.equal(document.getElementById("panelDropPreview"), null, "strip hover never paints the split square");
  panes.paneLabelDragEnd();
});

test("preview square is a singleton across dragovers", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_LEFT));
  const first = document.getElementById("panelDropPreview");
  assert.ok(first, "preview created on first dragover");
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_BOTTOM));
  const after = document.getElementById("panelDropPreview");
  assert.equal(after, first, "later dragovers reuse the same overlay node");
  const container = document.getElementById("workspacePanes");
  const count = [...container.children].filter((child) => child.id === "panelDropPreview").length;
  assert.equal(count, 1, "exactly one preview node lives in the container");
  panes.paneLabelDragEnd();
});

test("dragenter wiring positions the preview so fast releases still drop", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  // Chrome fires drop only when the current target's last dragenter or
  // dragover was canceled. A quick release right after crossing an
  // element boundary sees dragenter with no dragover yet. Drive the
  // container's wired dragenter handler directly: the vm stub has no
  // event dispatch.
  const container = document.getElementById("workspacePanes");
  const handlers = container.listeners.dragenter || [];
  assert.equal(handlers.length, 1, "container wired one dragenter handler");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p2"));
  handlers[0](dragEvent(paneEl, ...P_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "preview exists during the label drag");
  assert.equal(preview.style.display, "block", "dragenter alone positions the preview square");
  assert.equal(preview.style.left, "0px", "left half painted");
  panes.paneLabelDragEnd();
  assert.equal(preview.style.display, "none", "dragend still clears");
});

test("dragleave out of the container clears the painted square", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  const container = document.getElementById("workspacePanes");
  const leaveHandlers = container.listeners.dragleave || [];
  assert.equal(leaveHandlers.length, 1, "container wired one dragleave handler");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview.style.display, "block", "square painted before the leave");
  // relatedTarget outside the collector clears; the drag stays alive
  // (dragend has not run) but the chrome is gone.
  leaveHandlers[0]({ relatedTarget: null });
  assert.equal(preview.style.display, "none", "dragleave clears the square");
  panes.paneLabelDragEnd();
});

test("tab drags never split: content hovers keep the preview hidden", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_2" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  // The tab drag over pane content clears the preview (the group
  // gesture owns geometry; a release over dead space drops clean).
  panes.paneContainerTabDragOver(dragEvent(paneEl, ...P_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.equal(preview ? preview.style.display : undefined, undefined, "tab drag never paints the split square");
  // A tab drop outside any strip ends the drag cleanly: no group, no
  // split, nothing moves (member strips own every tab drop).
  const groupsBefore = panes.paneRoot().groups.length;
  panes.paneContainerTabDrop(dragEvent(paneEl, ...P_LEFT));
  assert.equal(panes.paneRoot().groups.length, groupsBefore, "tab drop created no group");
  assert.equal(ctx.activeDragKind(), null, "tab drop ended the drag");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 3, "no panel minted or dropped");
});

// ---- 3. drop creates a group ----------------------------------------------

// IMPLEMENTATION BUG (flagged, assertion kept per notes.md): the drop
// handler calls paneLabelDragEnd() BEFORE labelDropTargetValid(), which
// clears paneDragLabelPaneId; the validity check then falls back to
// target.paneId (the drop HOST panel), sees subject.leaf === dragged and
// refuses. Every label drop that should create a group is refused, so
// this gesture-level test fails until workspace_panes.js moves the
// paneLabelDragEnd() call after the validity gate. Repro: seed 3 panels,
// paneLabelDragStart(event, encodeURIComponent("p2")), then
// paneContainerTabDrop on p1's left quadrant: no group, visible stays
// {panel,p1}. The drop-path geometry is covered by the direct
// createGroupFromDrop test below while the wiring bug stands.
test("label drop creates a group at the release quadrant (BUG: drop refused)", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDrop(dragEvent(paneEl, ...P_LEFT));
  const group = panes.paneRoot().groups[0];
  assert.ok(group, "group created");
  assert.equal(group.layout.kind, "row", "left corner is a row axis");
  assert.deepEqual([...group.layout.children], ["p2", "p3"], "dragged first, neighbor second");
  const root = panes.paneRoot();
  assert.equal(root.visible.type, "group", "the new group is the visible subject");
  assert.equal(root.activePaneId, "p2", "focus lands on the dragged panel");
  const p1 = root.panels.find((l) => l.paneId === "p1");
  assert.equal(p1.groupId, null, "host panel stayed ungrouped (spec point 2)");
});

// Same bug, second face: the payload-only drop path. Kept as one
// assertion block, flagged the same way.
test("payload-only drop creates the group without dragstart (BUG: drop refused)", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  const event = dragEvent(paneEl, ...P_LEFT);
  event.dataTransfer.setData("text/herdr-pane-label", "p2");
  panes.paneContainerTabDrop(event);
  const group = panes.paneRoot().groups[0];
  assert.ok(group, "group created from the payload alone");
  assert.deepEqual([...group.memberIds], ["p2", "p3"], "payload drop joined the neighbor");
});

// The drop-path geometry, driven through the same primitive the (buggy)
// drop handler calls after its validity gate: createGroupFromDrop. Same
// axis/first flags the drop resolved from the quadrant, same neighbor
// rule, same membership writes. This pins the notes.md geometry while
// the wiring bug stands.
test("createGroupFromDrop builds the group layout per quadrant", () => {
  const quadrants = [
    // [axis, first, expectChildren, note]
    ["row", true, ["p2", "p3"], "left corner: row, dragged first"],
    ["row", false, ["p3", "p2"], "right corner: row, neighbor first"],
    ["column", true, ["p2", "p3"], "top corner: column, dragged first"],
    ["column", false, ["p3", "p2"], "bottom corner: column, neighbor first"],
  ];
  for (const [axis, first, children, note] of quadrants) {
    const { document } = buildDom();
    const ctx = loadPanes(document, "ws-1");
    seedPanels(ctx, 3);
    const panes = ctx.HerdrWorkspacePanes;
    const entry = panes.paneRoot();
    const dragged = entry.panels.find((l) => l.paneId === "p2");
    assert.equal(ctx.createGroupFromDrop(dragged, axis, first), true, `drop accepted (${note})`);
    const group = entry.groups[0];
    assert.ok(group, `group created (${note})`);
    assert.equal(group.name, null, `fresh group has no custom name (${note})`);
    assert.equal(group.layout.kind, axis, `axis (${note})`);
    assert.deepEqual([...group.layout.children], children, `children order (${note})`);
    // memberIds is ALWAYS [dragged, neighbor]: the anchor order the drop
    // captured, independent of the layout's visual order.
    assert.deepEqual([...group.memberIds], ["p2", "p3"], `memberIds carry dragged then neighbor (${note})`);
    assert.deepEqual([...group.layout.sizes], [1, 1], `halves share equally (${note})`);
    const p2 = entry.panels.find((l) => l.paneId === "p2");
    const p3 = entry.panels.find((l) => l.paneId === "p3");
    assert.equal(p2.groupId, group.groupId, `dragged panel joined (${note})`);
    assert.equal(p3.groupId, group.groupId, `neighbor auto-joined (${note})`);
    assert.equal(entry.visible.type, "group", `group is the visible subject (${note})`);
    assert.equal(entry.activePaneId, "p2", `focus lands on the dragged panel (${note})`);
  }
});

test("auto-join picks the right neighbor: right default, left setting, last-left", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const entry = panes.paneRoot();
  const p1 = entry.panels.find((l) => l.paneId === "p1");
  const p2 = entry.panels.find((l) => l.paneId === "p2");
  const p3 = entry.panels.find((l) => l.paneId === "p3");
  const p4 = entry.panels.find((l) => l.paneId === "p4");
  // Default (bare vm ctx, no options object): the rail neighbor at the
  // dragged panel's RIGHT fills the other half (spec point 3).
  assert.equal(ctx.autoJoinNeighborFor(p2).paneId, "p3", "default joins the right neighbor");
  assert.equal(ctx.autoJoinNeighborFor(p1).paneId, "p2", "first label joins the one at its right");
  // The dragged-LAST rule: no right neighbor exists, the left one fills.
  assert.equal(ctx.autoJoinNeighborFor(p4).paneId, "p3", "dragged-last joins its left neighbor");
  // Grouped panels fold behind their chip and never count (notes: only
  // ungrouped labels join).
  p3.groupId = "gx";
  assert.equal(ctx.autoJoinNeighborFor(p2).paneId, "p4", "grouped neighbor skipped");
  p3.groupId = null;
  // The settings choice flips the side (options.paneGroupAutoJoin "left").
  const ctxLeft = loadPanes(buildDom().document, "ws-1");
  seedPanels(ctxLeft, 4);
  ctxLeft.options = { paneGroupAutoJoin: "left" };
  const entryLeft = ctxLeft.HerdrWorkspacePanes.paneRoot();
  const p3Left = entryLeft.panels.find((l) => l.paneId === "p3");
  const p2Left = entryLeft.panels.find((l) => l.paneId === "p2");
  assert.equal(ctxLeft.autoJoinNeighborFor(p3Left).paneId, "p2", "left setting joins the left neighbor");
  // A grouped panel itself resolves no neighbor (it is not a rail label).
  p2Left.groupId = "gy";
  assert.equal(ctxLeft.autoJoinNeighborFor(p2Left), null, "grouped dragged panel has no rail neighbor");
});

test("no-neighbor drop is refused: single panel session never groups", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 1);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  // Only one panel exists: dragging its own label onto itself is both
  // self-drop and no-neighbor, both refused (notes: refuse the drop, no
  // group of one, no preview).
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p1"));
  let canceled = false;
  const event = dragEvent(paneEl, ...P_LEFT);
  event.preventDefault = () => { canceled = true; };
  panes.paneContainerTabDragOver(event);
  assert.equal(canceled, false, "dragover does not cancel with no neighbor");
  assert.equal(document.getElementById("panelDropPreview"), null, "no preview paints without a neighbor");
  panes.paneContainerTabDrop(dragEvent(paneEl, ...P_LEFT));
  assert.equal(panes.paneRoot().groups.length, 0, "drop created no group");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "nothing moved");
});

test("dragging the visible panel's own label onto itself is refused", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const paneEl = fixRects(document, "p1");
  // p1 is the visible subject; its own label dragged onto its own view
  // has no meaning (dragged === subject leaf, labelDropTargetValid
  // refuses).
  panes.paneLabelDragStart(dragEvent(paneEl, ...P_LEFT), encodeURIComponent("p1"));
  panes.paneContainerTabDrop(dragEvent(paneEl, ...P_LEFT));
  assert.equal(panes.paneRoot().groups.length, 0, "self drop created no group");
  const visible = panes.paneRoot().visible;
  assert.equal(visible.type, "panel", "visible pointer untouched");
  assert.equal(visible.id, "p1", "visible still names the host panel");
});

test("drop state persists through storage with the v2 session shape", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  // Drive the same create + persist sequence the drop handler runs
  // (createGroupFromDrop saves through setVisibleSubject).
  const entry = panes.paneRoot();
  const dragged = entry.panels.find((l) => l.paneId === "p2");
  assert.equal(ctx.createGroupFromDrop(dragged, "row", true), true, "group created");
  const raw = ctx.__storage["herdr-web-workspace-panes"];
  assert.ok(raw, "drop saved the store");
  const blob = JSON.parse(raw);
  assert.ok(blob.__session__, "blob holds the one session entry");
  assert.equal(blob.__session__.v, 2, "entry carries the v2 marker");
  assert.equal(blob.__session__.groups.length, 1, "group persisted");
  assert.equal(blob.__session__.visible.type, "group", "visible pointer persisted");
  assert.equal(blob.__session__.visible.id, "g1", "visible names the group");
  // Runtime-only markers strip out of the blob (the save replacer).
  assert.equal(JSON.stringify(blob).includes("autoCloseArmed"), false, "runtime arms never persist");
});

// ---- 4. growth drops: third member joins the visible group ----------------

// IMPLEMENTATION BUG (flagged, assertion kept per notes.md): the same
// paneLabelDragEnd-before-validity ordering breaks growth drops too. On
// a visible group the fallback resolves dragged = target.paneId (a group
// MEMBER, groupId set), and the group-subject rule refuses members. So
// no ungrouped panel can ever grow a visible group through the gesture.
// Repro: visible group [p2,p3], drag p4's label onto p2's half: refused,
// memberIds stay [p2,p3]. The growth geometry is covered through
// growVisibleGroupWith/layoutWithPanelAt below while the bug stands.
test("label drop grows the visible group at the release quadrant (BUG: drop refused)", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const p2El = fixRects(document, "p2");
  panes.paneLabelDragStart(dragEvent(p2El, ...P_LEFT), encodeURIComponent("p4"));
  panes.paneContainerTabDrop(dragEvent(p2El, ...P_LEFT));
  const group = panes.paneRoot().groups[0];
  assert.deepEqual([...group.memberIds], ["p2", "p3", "p4"], "memberIds grew");
  const p4 = panes.paneRoot().panels.find((l) => l.paneId === "p4");
  assert.equal(p4.groupId, group.groupId, "growth stamped the membership");
});

test("growVisibleGroupWith extends a same-axis host split flat", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const entry = panes.paneRoot();
  const p4 = entry.panels.find((l) => l.paneId === "p4");
  // Row drop on the p2 host (dropHostPaneId defaults to the layout's
  // first pane when unset): the parent row matches the axis, so the
  // row extends with p4 before p2.
  assert.equal(ctx.growVisibleGroupWith(p4, "row", true), true, "growth accepted");
  assert.deepEqual([...group.memberIds], ["p2", "p3", "p4"], "memberIds grew");
  assert.equal(p4.groupId, group.groupId, "membership stamped");
  const layout = stripSplitIds(group.layout);
  assert.equal(layout.kind, "row", "root stays a row");
  assert.deepEqual([...layout.children], ["p4", "p2", "p3"], "same-axis host extends beside the host");
  assert.deepEqual([...layout.sizes], [0.5, 0.5, 1], "the host's share splits in half");
});

test("growVisibleGroupWith nests an other-kind split under the host", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const entry = panes.paneRoot();
  const p4 = entry.panels.find((l) => l.paneId === "p4");
  // Column drop on the p2 host: the row parent does not match the column
  // axis, so p2's slot wraps into a nested column [p4, p2].
  assert.equal(ctx.growVisibleGroupWith(p4, "column", true), true, "growth accepted");
  const layout = stripSplitIds(group.layout);
  assert.equal(layout.kind, "row", "root stays the row group");
  const nested = layout.children.find((child) => child && typeof child === "object");
  assert.ok(nested, "p2's slot wrapped into a nested node");
  assert.equal(nested.kind, "column", "other-kind host nests a column");
  assert.deepEqual([...nested.children], ["p4", "p2"], "column first holds the new member above the host");
  const flat = layout.children.filter((child) => typeof child === "string");
  assert.deepEqual(flat, ["p3"], "the untouched sibling keeps its root slot");
});

test("fourth member extends the nested layout through the same rules", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 5);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const entry = panes.paneRoot();
  const p4 = entry.panels.find((l) => l.paneId === "p4");
  const p5 = entry.panels.find((l) => l.paneId === "p5");
  // Nest p4 under p2 (column inside the row slot).
  assert.equal(ctx.growVisibleGroupWith(p4, "column", true), true, "first growth accepted");
  // Grow again on the row axis with the default host (the layout's
  // first paneId, p4): p4 sits inside the nested column, so the row
  // nests under p4 there, NOT at the root.
  assert.equal(ctx.growVisibleGroupWith(p5, "row", false), true, "second growth accepted");
  assert.deepEqual([...group.memberIds], ["p2", "p3", "p4", "p5"], "four members stand");
  const layout = stripSplitIds(group.layout);
  assert.equal(layout.kind, "row", "root stays the row group");
  const flat = layout.children.filter((child) => typeof child === "string");
  assert.deepEqual(flat, ["p3"], "the untouched sibling keeps its root slot");
  const column = layout.children.find((child) => child && typeof child === "object" && child.kind === "column");
  assert.ok(column, "the first nest kept its column");
  const innerRow = column.children.find((child) => child && typeof child === "object");
  assert.ok(innerRow, "p4's slot wrapped into the second nest");
  assert.equal(innerRow.kind, "row", "other-kind second nest is a row");
  assert.deepEqual([...innerRow.children], ["p4", "p5"], "row second holds the new member after the host");
});

test("grouped panel drop on its own visible group is refused", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const layoutBefore = JSON.stringify(stripSplitIds(group.layout));
  const membersBefore = [...group.memberIds];
  const p2El = fixRects(document, "p2");
  // p2 is already a member; its label drop back on the group is never a
  // re-position (the member drag out is the ungroup gesture, notes point
  // 8). The refusal holds today with or without the wiring bug.
  panes.paneLabelDragStart(dragEvent(p2El, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDrop(dragEvent(p2El, ...P_LEFT));
  assert.deepEqual([...group.memberIds], membersBefore, "memberIds untouched");
  assert.equal(JSON.stringify(stripSplitIds(group.layout)), layoutBefore, "layout untouched");
  assert.equal(group.memberIds.filter((id) => id === "p2").length, 1, "p2 not duplicated");
});

test("growth refuses a dragged member even at the primitive level", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const entry = panes.paneRoot();
  const p2 = entry.panels.find((l) => l.paneId === "p2");
  // A member can never grow its own group again (members never
  // re-position; their drag out is the ungroup gesture).
  assert.equal(ctx.growVisibleGroupWith(p2, "row", true), false, "member growth refused");
  assert.deepEqual([...group.memberIds], ["p2", "p3"], "memberIds untouched");
});

// ---- 5. ungroup gesture: paneTabUnsplitHover/Drop -------------------------

test("ungroup hover qualifies only grouped member tabs", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  // No drag in flight: a bare event with only the payload qualifies.
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "tab_2" } }), true,
    "grouped member tab qualifies through the payload");
  // The HOST panel's tab (p1, ungrouped) never qualifies.
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "tab_1" } }), false,
    "ungrouped panel tab never qualifies");
  // No payload, no drag: refused.
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "" } }), false,
    "no drag and no payload refuses");
});

test("ungroup drop removes the member and keeps the group standing", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  // Three members so the drop keeps a real group behind.
  const group = buildGroup(ctx, ["p2", "p3", "p1"],
    { kind: "row", sizes: [1, 1, 1], children: ["p2", "p3", "p1"] });
  // Drag p2's tab (the member label) to the location bar and drop.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_2" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "tab_2" } }), true, "hover qualifies mid-drag");
  assert.equal(panes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "tab_2" } }), true, "drop accepted");
  const root = panes.paneRoot();
  const p2 = root.panels.find((l) => l.paneId === "p2");
  assert.equal(p2.groupId, null, "ungrouped panel back on the rail");
  assert.deepEqual([...group.memberIds], ["p3", "p1"], "survivors keep the group");
  // The layout lost p2: the split under 2 members keeps both survivors.
  const layout = stripSplitIds(group.layout);
  assert.deepEqual([...layout.children], ["p3", "p1"], "layout dropped the removed member");
  assert.equal(root.visible.type, "group", "group stays visible");
  assert.equal(ctx.activeDragKind(), null, "drop ended the tab drag");
  // The bar drop stores its state change too.
  assert.ok(ctx.__storage["herdr-web-workspace-panes"], "ungroup persisted");
});

test("ungroup under two members dissolves the group and collapses the layout", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  // One tab drag takes p3 out: the group falls to one member, dissolves,
  // and the survivor ungroups with it (memberLayoutWithout collapse).
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_3" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  assert.equal(panes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "tab_3" } }), true, "drop accepted");
  const root = panes.paneRoot();
  assert.equal(root.groups.length, 0, "group dissolved under two members");
  const p2 = root.panels.find((l) => l.paneId === "p2");
  const p3 = root.panels.find((l) => l.paneId === "p3");
  assert.equal(p2.groupId, null, "survivor ungrouped with the dissolve");
  assert.equal(p3.groupId, null, "removed member ungrouped");
  // Visible heals through visibleSubject: a dissolved group hands the
  // subject to a panel.
  assert.equal(root.visible.type, "panel", "subject healed to a panel");
});

test("ungroup drop refuses ungrouped tabs and keeps the drag alive", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  // No group exists yet: the bar drop refuses.
  ctx.paneTabDragStart({ target: { dataset: { tabId: "tab_2" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  assert.equal(panes.paneTabUnsplitHover({ dataTransfer: { getData: () => "tab_2" } }), false, "no group, no qualification");
  assert.equal(panes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "tab_2" } }), false, "drop refused");
  assert.equal(panes.paneRoot().groups.length, 0, "nothing changed");
  assertDragKind(ctx.activeDragKind(), "tab", "tab_2", "refused drop keeps the drag alive");
  ctx.paneTabDragEnd();
});

// ---- 6. rail chip HTML wiring ----------------------------------------------

test("rail chips carry the drag and press wiring in their HTML", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const rail = railOf(document);
  assert.ok(rail, "rail renders with multiple subjects");
  const html = rail.__innerHTML;
  // Panel chip: draggable, paneId, press, dragstart, dragend.
  assert.ok(html.includes('class="pane-label-chip"'), "panel chip class renders");
  assert.ok(html.includes('draggable="true"'), "panel chip is draggable");
  assert.ok(html.includes('data-pane-id="p2"'), "chip names its panel");
  assert.ok(html.includes(`ondragstart="paneLabelDragStart(event,'${encodeURIComponent("p2")}')"`), "chip wires paneLabelDragStart");
  assert.ok(html.includes('ondragend="paneLabelDragEnd()"'), "chip wires paneLabelDragEnd");
  assert.ok(html.includes(`onclick="event.preventDefault();showPanelFromRail('${encodeURIComponent("p2")}')"`), "chip wires showPanelFromRail");
  assert.ok(html.includes('aria-selected="false"'), "non-visible chip is not selected");
  // The visible panel's own chip carries the active state (notes: the
  // rail shows ALL panels not inside the visible group, the visible
  // one selected).
  assert.ok(html.includes('class="pane-label-chip active"'), "visible panel chip carries active");
  assert.ok(html.includes('aria-selected="true"'), "visible chip is selected (tablist pattern)");
});

test("rail renders the group chip beside member chips", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const rail = railOf(document);
  assert.ok(rail, "rail still renders");
  const html = rail.__innerHTML;
  // Ephemeral contract retired: ALL panels keep their chips (members
  // included); the group chip is the split view's own entry, rendered
  // last, and PERSISTS when the subject moves away.
  assert.ok(html.includes('data-pane-id="p2"'), "member chip p2 stays in the rail");
  assert.ok(html.includes('data-pane-id="p3"'), "member chip p3 stays in the rail");
  assert.ok(html.includes('data-pane-id="p1"'), "host panel keeps its rail label");
  // The render pass also paints the group layout: both member panes
  // exist in the split wrapper.
  assert.ok(findPaneEl(document, "p2"), "member pane p2 rendered");
  assert.ok(findPaneEl(document, "p3"), "member pane p3 rendered");
  assert.ok(!findPaneEl(document, "p1"), "non-member pane left the container");
  // Persistence: the group chip renders even when the subject names a
  // flat panel (hidden group keeps its rail chip).
  panes.showPanelFromRail(encodeURIComponent("p1"));
  const flatHtml = railOf(document).__innerHTML;
  assert.ok(flatHtml.includes("pane-panel-group-chip"), "hidden group chip persists on a panel subject");
  assert.ok(flatHtml.includes(`showGroupFromRail('${encodeURIComponent(group.groupId)}')`), "hidden group chip still wires the reopen");
  // Group chip: default "Group N views" name, never draggable, press and
  // dblclick rename wired.
  assert.ok(html.includes("pane-panel-group-chip"), "group chip class renders");
  assert.ok(html.includes("Group 2 views"), "group chip carries the default count name");
  assert.ok(html.includes('draggable="false"'), "group chip never drags");
  assert.ok(html.includes(`onclick="event.preventDefault();showGroupFromRail('${encodeURIComponent(group.groupId)}')"`), "group chip wires showGroupFromRail");
  assert.ok(html.includes(`ondblclick="startPaneGroupRename('${encodeURIComponent(group.groupId)}')"`), "group chip wires the rename");
  assert.ok(html.includes('class="pane-label-chip pane-panel-group-chip active"'), "visible group chip is active");
});

test("grouped member chips refuse the grouping drag", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 3);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  let prevented = false;
  const event = {
    dataTransfer: { setData() {}, effectAllowed: "uninitialized" },
    target: null,
    preventDefault() { prevented = true; },
  };
  panes.paneLabelDragStart(event, encodeURIComponent("p2"));
  assert.equal(prevented, true, "grouped member dragstart refused");
  assert.equal(ctx.paneLabelDragKind(), null, "no grouping payload in flight");
});

test("single ungrouped panel renders no rail", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 1);
  const rail = railOf(document);
  assert.equal(rail, null, "one subject renders no rail chrome");
});

// ---- 6b. strip chip contract (split-only) ------------------------------
// The flat strip carries no chip: the rail already names every
// independent panel, and a chip there read the same identity twice
// (chip + tab). Inside the visible split each member strip keeps its
// chip: it names the member and carries the re-position / rail-exit
// drag.

test("flat panel strip renders no chip", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const leaf = panes.paneRoot().panels.find((p) => p.paneId === "p1");
  assert.equal(
    panes.panePanelChipHtml(leaf).includes("pane-panel-chip"),
    false,
    "an independent panel's strip carries no chip",
  );
});

test("visible-group member strip renders the chip with the member drag", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const leaf = panes.paneRoot().panels.find((p) => p.paneId === "p2");
  const html = panes.panePanelChipHtml(leaf);
  assert.ok(html.includes("pane-panel-chip"), "a visible-group member strip carries the chip");
  assert.ok(html.includes("paneMemberDragStart"), "the member chip carries the drag wiring");
});

test("dissolved member strip loses its chip with the group", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  panes.showPanelFromRail(encodeURIComponent("p4"));
  const leaf = panes.paneRoot().panels.find((p) => p.paneId === "p2");
  assert.equal(
    panes.panePanelChipHtml(leaf).includes("pane-panel-chip"),
    false,
    "a dissolved group member is independent again: no chip",
  );
});

// ---- 7. member chip drag (re-position inside the split, rail exit) -----
// The strip chip of a visible-group member drags: onto another
// member's corner zone it re-positions inside the group layout, onto
// the rail it ungroups. Independent panels keep a click-only chip.

test("member dragstart arms the drag state only for a visible-group member", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const chip = makeNode("chip_p2", "pane-panel-chip");
  chip.classList = {
    add(n) { chip.className += ` ${n}`; },
    remove(n) { chip.className = chip.className.split(/\s+/).filter((c) => c && c !== n).join(" "); },
  };
  const event = dragEvent(chip, 0, 0);
  panes.paneMemberDragStart(event, encodeURIComponent("p2"));
  assertDragKind(ctx.paneMemberDragKind(), "member", "p2", "dragstart arms the member state");
  assert.equal(event.dataTransfer.getData("text/herdr-pane-member"), "p2", "payload carries the paneId");
  assert.equal(event.dataTransfer.effectAllowed, "move", "payload allows move");
  // An ungrouped panel never arms the member drag: p4 sits outside the
  // group, so the chip stays click-only. The refused start leaves the
  // armed state alone (same contract as the label pipeline: a foreign
  // payload must not clear a live drag).
  const event2 = dragEvent(chip, 0, 0);
  const prevented = { value: false };
  event2.preventDefault = () => { prevented.value = true; };
  panes.paneMemberDragStart(event2, encodeURIComponent("p4"));
  assert.ok(prevented.value, "the refused start cancels the drag event");
  assertDragKind(ctx.paneMemberDragKind(), "member", "p2", "the armed drag survives the refused start");
  panes.paneMemberDragEnd();
  assert.equal(ctx.paneMemberDragKind(), null, "dragend clears the drag state");
});

test("member dragstart on a non-visible group panel is refused", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  // Leave the group subject: the record PERSISTS (rail chip) but the
  // split view is gone, so its member chips must not arm a drag.
  panes.showPanelFromRail(encodeURIComponent("p4"));
  const group = panes.paneRoot().groups[0];
  assert.ok(group, "subject switch kept the group record");
  const chip = makeNode("chip_p2", "pane-panel-chip");
  panes.paneMemberDragStart(dragEvent(chip, 0, 0), encodeURIComponent("p2"));
  assert.equal(ctx.paneMemberDragKind(), null, "a member outside the visible split never arms");
});

test("member drop re-positions the view inside the split at the release quadrant", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const p3El = fixRects(document, "p3");
  panes.paneMemberDragStart(dragEvent(p3El, ...P_LEFT), encodeURIComponent("p2"));
  // Left corner on p3's pane: p2 lands before p3 in the row.
  panes.paneContainerTabDrop(dragEvent(p3El, ...P_LEFT));
  const layout = stripSplitIds(group.layout);
  assert.equal(layout.kind, "row", "the split stays a row");
  assert.deepEqual([...layout.children], ["p2", "p3"], "p2 re-positioned before p3");
  assert.equal(ctx.paneMemberDragKind(), null, "the drop clears the drag state");
  assert.equal(panes.paneRoot().groups.length, 1, "the group survived the move");
  assert.deepEqual([...group.memberIds], ["p2", "p3"], "membership untouched");
});

test("member drop on its own pane is a clean miss, not a surgery", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  const group = buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const p2El = fixRects(document, "p2");
  const before = stripSplitIds(group.layout);
  panes.paneMemberDragStart(dragEvent(p2El, ...P_RIGHT), encodeURIComponent("p2"));
  panes.paneContainerTabDrop(dragEvent(p2El, ...P_RIGHT));
  const layout = stripSplitIds(group.layout);
  assert.deepEqual(layout, before, "the layout never changed");
  assert.equal(ctx.paneMemberDragKind(), null, "the miss clears the drag state");
});

test("member drag previews the quadrant on a sibling member pane", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const p3El = fixRects(document, "p3");
  panes.paneMemberDragStart(dragEvent(p3El, ...P_LEFT), encodeURIComponent("p2"));
  panes.paneContainerTabDragOver(dragEvent(p3El, ...P_LEFT));
  const preview = document.getElementById("panelDropPreview");
  assert.ok(preview, "the quadrant preview paints on the sibling pane");
  // The same hover over the dragged member's own pane paints nothing:
  // the release host must be a different member.
  const p2El = findPaneEl(document, "p2");
  p2El.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 });
  panes.paneContainerTabDragOver(dragEvent(p2El, ...P_RIGHT));
  assert.equal(preview.style.display, "none", "no preview on the dragged pane itself");
  panes.paneMemberDragEnd();
});

test("rail member drop ungroups the member back to an independent panel", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const rail = railOf(document);
  assert.ok(rail, "the rail renders above the group view");
  const railEvent = (kind) => {
    const event = dragEvent(rail, 0, 0);
    event.currentTarget = rail;
    return event;
  };
  panes.paneMemberDragStart(dragEvent(rail, 0, 0), encodeURIComponent("p2"));
  const drop = railEvent();
  panes.paneRailMemberDrop(drop);
  const entry = panes.paneRoot();
  const p2 = entry.panels.find((l) => l.paneId === "p2");
  assert.equal(p2.groupId, null, "the member left the group");
  // Two members minus one dissolves the undersized group (close and
  // ungroup still dissolve; only the subject switch stopped doing it).
  assert.equal(entry.groups.length, 0, "the undersized group dissolved");
  assert.equal(entry.visible.type, "panel", "the subject healed to a panel");
  assert.equal(entry.visible.id, "p3", "the surviving member takes the subject");
  assert.equal(ctx.paneMemberDragKind(), null, "the drop clears the drag state");
});

test("member chip html carries the drag wiring only in a group view", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 4);
  const panes = ctx.HerdrWorkspacePanes;
  // Group view: every member strip chip drags.
  buildGroup(ctx, ["p2", "p3"], { kind: "row", sizes: [1, 1], children: ["p2", "p3"] });
  const p2El = findPaneEl(document, "p2");
  const stripP2 = p2El && p2El.querySelector ? p2El.querySelector(".pane-tab-strip") : null;
  const chipHtmlP2 = stripP2 ? stripP2.__innerHTML : "";
  assert.ok(chipHtmlP2.includes('draggable="true" ondragstart="paneMemberDragStart(event,'), "group-view member chip drags");
  // Panel view (no group): no chip at all, the rail names the panel.
  panes.showPanelFromRail(encodeURIComponent("p1"));
  const p1El = findPaneEl(document, "p1");
  const stripP1 = p1El && p1El.querySelector ? p1El.querySelector(".pane-tab-strip") : null;
  const chipHtmlP1 = stripP1 ? stripP1.__innerHTML : "";
  assert.ok(!chipHtmlP1.includes("paneMemberDragStart"), "standalone panel chip never drags");
  assert.ok(!chipHtmlP1.includes("pane-panel-chip"), "a standalone panel renders no chip");
});

// ---- 8. storage blob shape -------------------------------------------------

test("saved blob holds the v2 session entry and strips runtime markers", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  seedPanels(ctx, 2);
  const panes = ctx.HerdrWorkspacePanes;
  panes.saveWorkspacePanesStates();
  const blob = JSON.parse(ctx.__storage["herdr-web-workspace-panes"]);
  assert.ok(blob.__session__, "blob keyed by the session marker");
  assert.equal(blob.__session__.v, 2, "v2 marker rides the entry");
  assert.equal(blob.__session__.panels.length, 2, "flat panels list persisted");
  assert.equal(blob.__session__.visible.type, "panel", "visible pointer persisted");
  assert.equal(blob.__session__.visible.id, "p1", "visible names the panel");
  // Runtime-only markers strip out of the blob (the save replacer).
  const leaf = blob.__session__.panels[0];
  assert.equal(leaf.autoCloseArmed, undefined, "arms never persist");
  assert.equal(leaf.autoClosePre, undefined, "pre markers never persist");
});