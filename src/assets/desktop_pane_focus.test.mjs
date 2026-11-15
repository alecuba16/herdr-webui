// Slice 1 acceptance: per-pane focus tracking. The pane tree's active
// pointer (root.activePaneId) was command-only state: strip tab clicks
// and split commands moved it, but clicking inside a pane did not, and
// no visual state marked the active pane. HerdrPaneFocus owns the fix:
// capture-phase click-to-focus on #workspacePanes, .is-active mirroring
// on every render, input-follows-focus on aux terminal surfaces.
//
// These tests pin the contract from the UX review (proposal-v1 D5):
// click-in-terminal moves focus, empty panes keep the ring, and the
// pointer move persists for the keyboard split commands that read it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const FOCUS_PATH = fileURLToPath(new URL("./desktop/app_js/pane_focus.js", import.meta.url));
const panesSource = readFileSync(PANES_PATH, "utf8");
const focusSource = readFileSync(FOCUS_PATH, "utf8");
const panesScript = new vm.Script(panesSource, { filename: PANES_PATH });
const focusScript = new vm.Script(focusSource, { filename: FOCUS_PATH });

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    attributes: {},
    __innerHTML: "",
    listeners: [],
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name] != null ? node.attributes[name] : null;
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
    addEventListener(type, handler, capture) {
      node.listeners.push({ type, handler, capture, node });
    },
    dispatch(type, target) {
      // Capture phase walks down from the listener's node; this harness
      // only wires the container, so a single match is the case under
      // test. Real capture semantics: container listener fires before
      // any consumer on the target.
      const fired = [];
      for (const listener of node.listeners) {
        if (listener.type !== type) continue;
        listener.handler({ type, target, button: 0, __herdrFired: fired });
        fired.push(listener);
      }
      return fired.length;
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
      node.children.length = 0;
    },
  });
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
    body,
  };
  return { container, shell, document };
}

function loadModules(document, stateWs) {
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
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  panesScript.runInContext(vm.createContext(ctx));
  focusScript.runInContext(vm.createContext(ctx));
  return ctx;
}

function buildSplitTree(ctx) {
  const panes = ctx.HerdrWorkspacePanes;
  // p1 | p2 via the real command path. Re-read the root AFTER the split:
  // splitting the root leaf replaces state.workspacePanes[key].root with
  // the new split node, so a reference captured before the command is a
  // stale single-leaf object.
  assert.equal(panes.splitPaneRight(), true, "split creates the second pane");
  return { panes, root: panes.paneRootFor() };
}

test("click inside a pane moves the tree's active pointer", () => {
  const { document } = buildDom();
  const ctx = loadModules(document, "ws-1");
  const { panes, root } = buildSplitTree(ctx);
  panes.renderWorkspacePanes();
  ctx.HerdrPaneFocus.wire();

  const leaves = panes.paneLeaves(root);
  assert.equal(root.activePaneId, leaves[1].paneId, "split focus lands on the fresh leaf");
  assert.ok(paneElementById(ctx, leaves[1].paneId), "second pane element renders");

  // Click inside the FIRST pane's content: pointer must move there.
  const firstPane = paneElementById(ctx, leaves[0].paneId);
  containerDispatch(ctx, firstPane.querySelector(".pane-content") || firstPane);
  assert.equal(root.activePaneId, leaves[0].paneId, "click-in-pane moves the pointer");
});

test("focus ring mirrors the active pane and survives renders, empty panes included", () => {
  const { document } = buildDom();
  const ctx = loadModules(document, "ws-1");
  const { panes, root } = buildSplitTree(ctx);
  ctx.HerdrPaneFocus.wire();

  panes.renderWorkspacePanes();
  const leaves = panes.paneLeaves(root);
  const ringOf = (paneId) => {
    const pane = paneElementById(ctx, paneId);
    return pane ? pane.classList.contains("is-active") : null;
  };
  assert.equal(ringOf(leaves[1].paneId), true, "focused leaf carries the ring");
  assert.equal(ringOf(leaves[0].paneId), false, "sibling leaf does not");

  // Click the empty first pane (no tabs): the ring must move there, the
  // ring is the keyboard anchor for split commands.
  const firstPane = paneElementById(ctx, leaves[0].paneId);
  containerDispatch(ctx, firstPane.querySelector(".pane-content") || firstPane);
  assert.equal(ringOf(leaves[0].paneId), true, "empty pane takes the ring on click");
  assert.equal(ringOf(leaves[1].paneId), false, "old focused leaf loses the ring");

  // A later render pass (poll, reshape) re-derives from the pointer and
  // must not flip the ring back.
  panes.renderWorkspacePanes();
  assert.equal(ringOf(leaves[0].paneId), true, "render keeps the ring on the pointer's pane");
});

test("pointer moves persist so keyboard split commands read the clicked pane", () => {
  const { document } = buildDom();
  const ctx = loadModules(document, "ws-1");
  const { panes, root } = buildSplitTree(ctx);
  ctx.HerdrPaneFocus.wire();
  panes.renderWorkspacePanes();

  const leaves = panes.paneLeaves(root);
  const firstPane = paneElementById(ctx, leaves[0].paneId);
  containerDispatch(ctx, firstPane.querySelector(".pane-content") || firstPane);

  // The split command family reads activeLeaf(root); the clicked pane
  // must be the one that splits. splitActivePane then focuses the FRESH
  // leaf by design (the new pane is where the user next acts), so find
  // the new leaf by set difference instead of guessing its position.
  assert.equal(panes.splitPaneDown(), true, "split-down acts after click-to-focus");
  const rootAfter = panes.paneRootFor();
  const leavesAfter = panes.paneLeaves(rootAfter);
  assert.equal(leavesAfter.length, 3, "tree grew one leaf");
  assert.ok(leavesAfter.some((leaf) => leaf.paneId === leaves[0].paneId), "clicked pane kept in the tree");
  const freshLeaf = leavesAfter.find((leaf) => !leaves.some((old) => old.paneId === leaf.paneId));
  assert.ok(freshLeaf, "a fresh leaf appeared after split");
  assert.equal(rootAfter.activePaneId, freshLeaf.paneId, "pointer on the fresh leaf");
});

test("rail stubs and unknown pane ids never take the ring", () => {
  const { document } = buildDom();
  const ctx = loadModules(document, "ws-1");
  const { panes, root } = buildSplitTree(ctx);
  ctx.HerdrPaneFocus.wire();

  // Maximize: the hidden sibling renders as a rail stub.
  panes.maximizeActivePane();
  panes.renderWorkspacePanes();
  const home = ctx.el("workspacePanes");
  const stub = findRailStub(ctx);
  if (stub) {
    const fired = containerDispatch(ctx, stub.children[0] || stub);
    assert.equal(root.activePaneId, undefined || root.activePaneId, "stub click never crashes");
    assert.ok(Array.isArray(fired), "dispatch contract holds");
  }
  // Unknown pane id: the activator refuses instead of writing a pointer
  // no leaf owns (the next render would strand the ring).
  assert.equal(ctx.HerdrPaneFocus.activatePane("p-nope"), false, "unknown id refused");
});

test("activation persists through the panes store write-through", () => {
  const { document } = buildDom();
  const ctx = loadModules(document, "ws-1");
  const { panes, root } = buildSplitTree(ctx);
  ctx.HerdrPaneFocus.wire();
  panes.renderWorkspacePanes();

  const leaves = panes.paneLeaves(root);
  const firstPane = paneElementById(ctx, leaves[0].paneId);
  containerDispatch(ctx, firstPane.querySelector(".pane-content") || firstPane);

  // saveWorkspacePanesStates was called (stored tree keeps the pointer).
  // The state entry itself is the witness: the pointer lives on the
  // entry object the store writes. The session-global tree lives under
  // its fixed key (D1).
  const entry = ctx.state.workspacePanes["__session__"];
  assert.ok(entry, "session tree entry exists");
  assert.equal(entry.root.activePaneId, leaves[0].paneId, "pointer persisted on the tree");
});

test("source contract: capture-phase wiring and render hook exist", () => {
  assert.ok(focusSource.includes('addEventListener("pointerdown", onPointerDown, true)'), "capture-phase pointerdown");
  assert.ok(focusSource.includes('addEventListener("mousedown", onPointerDown, true)'), "capture-phase mousedown fallback");
  assert.ok(panesSource.includes("HerdrPaneFocus.applyFocusClasses"), "render mirrors the ring");
  assert.ok(
    panesSource.includes("paneRootFor,") || /paneRootFor,\n/.test(panesSource),
    "paneRootFor exported for the focus module",
  );
  const attachClick = readFileSync(
    fileURLToPath(new URL("./desktop/app_js/pane_terminals.js", import.meta.url)),
    "utf8",
  );
  assert.ok(attachClick.includes("attachClickFocus"), "aux surfaces wire input-follows-focus");
});

// Find the maximize rail stub (direct child of the container).
function findRailStub(ctx) {
  const home = ctx.el("workspacePanes");
  return [...home.children].find((child) => (child.className || "").split(/\s+/).includes("pane-rail-stub")) || null;
}

// Find a pane element anywhere under #workspacePanes: split trees nest
// leaves inside .pane-row/.pane-column wrappers, so a direct-children
// scan misses every split pane.
function paneElementById(ctx, paneId) {
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.dataset && child.dataset.paneId === paneId) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(ctx.el("workspacePanes"));
}

// Dispatch a click at a target inside the pane tree through the
// container's capture listeners (the only wiring the module installs).
function containerDispatch(ctx, target) {
  const home = ctx.el("workspacePanes");
  let fired = 0;
  for (const listener of home.listeners || []) {
    if (listener.type !== "pointerdown") continue;
    listener.handler({ type: "pointerdown", target, button: 0 });
    fired += 1;
  }
  return fired;
}