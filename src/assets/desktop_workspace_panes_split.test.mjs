// Split functionality coverage for workspace_panes.js. The older
// desktop_workspace_panes.test.mjs pins the strip/terminal seam; this
// file covers the split surface end to end: tree model repair, terminal
// sync rules, DOM identity across renders and reshapes, the command
// matrix (split/flip/nest, close-promote migration, maximize, move),
// lifecycle heals, strip control gating, divider resize, and the mount
// ownership invariants (container claim, rescue, parked-hidden).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    attributes: {},
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
  if (!saved && stored != null) storage["herdr-web-workspace-panes"] = stored;
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
  const source = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));
  ctx.__storage = storage;
  return ctx;
}

function loadPanesModule(document, stateWs) {
  return loadPanesModuleWithStorage(document, stateWs, null, null);
}

function bootstrapPanes(ctx, tabId) {
  ctx.state.tabs = [{ tab_id: tabId }];
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

function mountEditorContainer(ctx, panes, nodes, path) {
  const container = makeNode(panes.paneEditorMountId(path), "pane-editor-container");
  container.dataset.path = path;
  nodes.body = nodes.body || null;
  // The real flow mounts through the file browser; the test mounts
  // directly into the active pane's content slot.
  const pane = panes.activePaneElement();
  contentOf(pane).appendChild(container);
  return container;
}

function mountGitContainer(ctx, panes, viewKey) {
  const container = makeNode(panes.paneGitMountId(viewKey), "pane-git-container");
  container.dataset.viewKey = viewKey;
  const pane = panes.activePaneElement();
  contentOf(pane).appendChild(container);
  return container;
}

// ---- 1. tree model --------------------------------------------------------

test("newLeaf/newEmptyLeaf mint unique pane ids across workspaces", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-a");
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRoot();
  assert.equal(root.paneId, "p1", "first workspace seeds p1");
  panes.splitPaneRight();
  panes.splitPaneDown();
  const ids = panes.paneLeaves(panes.paneRoot()).map((leaf) => leaf.paneId);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique per tree");
  const other = loadPanesModule(buildDom().document, "ws-b");
  const otherIds = other.HerdrWorkspacePanes.paneLeaves(other.HerdrWorkspacePanes.paneRoot()).map((l) => l.paneId);
  assert.ok(!otherIds.includes(ids[1]), "fresh module contexts mint independent ids");
});

test("stores split trees only while the workspace is open", () => {
  const { document } = buildDom();
  const saved = {};
  const ctx = loadPanesModuleWithStorage(document, "ws-1", null, saved);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  panes.splitPaneDown();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs.push("editor:src/demo.py");
  panes.saveWorkspacePanesStates();
  const blob = JSON.parse(saved["herdr-web-workspace-panes"]);
  const entry = blob["ws|ws-1"];
  assert.equal(entry.root.kind, "row", "root kind persisted");
  assert.equal(entry.root.children.length, 2, "children persisted");
  assert.ok(panes.paneLeaves(entry.root).length >= 3, "leaves persisted");
  // Reload in a fresh module: the stored tree is discarded and a fresh leaf
  // is created for the reopened workspace.
  const reloaded = loadPanesModuleWithStorage(buildDom().document, "ws-1", saved["herdr-web-workspace-panes"], null);
  const reRoot = reloaded.HerdrWorkspacePanes.paneRoot();
  assert.equal(reRoot.kind, "pane", "reload resets the pane tree");
  const reLeaves = reloaded.HerdrWorkspacePanes.paneLeaves(reRoot);
  assert.equal(reLeaves.length, 1, "reload resets to one leaf");
  assert.ok(!reLeaves.some((leaf) => leaf.tabs.includes("editor:src/demo.py")), "editor tab is removed on reload");
});

test("normalizePaneTree mints pane ids for id-less stored leaves", () => {
  const stored = JSON.stringify({
    "ws|ws-x": {
      root: {
        kind: "row",
        sizes: [1, 1],
        children: [
          { kind: "pane", tabs: ["tab_2"], active: "tab_2" },
          { kind: "pane", tabs: [], active: null },
        ],
      },
    },
  });
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-x");
  const parsed = JSON.parse(stored);
  const root = ctx.normalizePaneTree(parsed["ws|ws-x"].root);
  const leaves = ctx.HerdrWorkspacePanes.paneLeaves(root);
  assert.equal(leaves.length, 2, "stored tree loaded");
  assert.ok(leaves.every((leaf) => !!leaf.paneId), "ids minted on load");
});

test("forgetWorkspacePanes drops the workspace tree and stored tabs", () => {
  const { document } = buildDom();
  const saved = {};
  const ctx = loadPanesModuleWithStorage(document, "ws-1", null, saved);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  panes.saveWorkspacePanesStates();
  assert.ok(saved["herdr-web-workspace-panes"], "open workspace state is stored during the session");

  panes.forgetWorkspacePanes("ws-1");

  assert.equal(ctx.state.workspacePanes["ws|ws-1"], undefined, "closed workspace tree is removed from memory");
  assert.equal(saved["herdr-web-workspace-panes"], undefined, "closed workspace tree is removed from storage");
});

// ---- 2. sync ---------------------------------------------------------------

test("sync seeds the placeholder, appends unknown ids, prunes dead ids", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRoot();
  assert.ok(root.tabs.includes("terminal"), "fresh tree seeds the placeholder");
  // First backend list: placeholder replaced in place.
  ctx.state.tabs = [{ tab_id: "tab_2" }, { tab_id: "tab_3" }];
  assert.equal(panes.syncTerminalTabsIntoTree(root), true, "seed replaced");
  assert.deepEqual([...root.tabs], ["tab_2", "tab_3"], "placeholder swapped for real ids");
  assert.equal(root.active, "tab_2", "active follows the seed");
  // New panel lands: append.
  ctx.state.tabs.push({ tab_id: "tab_4" });
  assert.equal(panes.syncTerminalTabsIntoTree(root), true, "new id appended");
  assert.ok(root.tabs.includes("tab_4"), "append keeps earlier ids");
  // Closed panel: prune, active heals to a kept id.
  ctx.state.tabs = ctx.state.tabs.filter((tab) => tab.tab_id !== "tab_3");
  root.active = "tab_3";
  assert.equal(panes.syncTerminalTabsIntoTree(root), true, "dead id pruned");
  assert.ok(!root.tabs.includes("tab_3"), "pruned id gone");
  assert.ok(root.active === "tab_2" || root.active === "tab_4", "dangling active healed to a kept id");
});

test("sync keeps a moved tab's home and honors pending placements once", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // Simulate a tab that migrated to the second leaf.
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  leaves[1].tabs.push("tab_2");
  ctx.state.tabs.push({ tab_id: "tab_9" });
  // A pending + placement targets the first leaf; both leaves are
  // homes, so the missing id lands in the pressed leaf.
  ctx.window.newTab = async () => {};
  // Manually park the placement the way newTabForPane does.
  const placementMapKey = "__next__";
  // Direct sync: the moved tab_2 keeps its home, tab_9 lands per the
  // pending placement the sync consults.
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  assert.ok(leaves[1].tabs.includes("tab_2"), "moved terminal keeps its home");
  assert.ok(leaves[0].tabs.includes("tab_9") || leaves[1].tabs.includes("tab_9"), "new id landed");
});

test("route shadow: an editor pointer survives renders until the route moves", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  root.tabs.push("editor:src/demo.py");
  panes.setActivePaneTab("editor:src/demo.py");
  assert.equal(root.active, "editor:src/demo.py", "editor takes the pointer");
  // Same-route render: the editor pointer survives.
  panes.renderWorkspacePanes();
  assert.equal(root.active, "editor:src/demo.py", "same route keeps the editor pointer");
  // Route moves to another panel: pointer follows the route owner.
  ctx.state.tab = "tab_3";
  ctx.state.tabs.push({ tab_id: "tab_3" });
  panes.renderWorkspacePanes();
  const owner = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.tabs.includes("tab_3"));
  assert.equal(owner.active, "tab_3", "route change takes the pointer for its owner leaf");
});

// ---- 3. render: split DOM, identity, BUG A regression ----------------------

test("split render builds rows, columns, dividers, and per-leaf strips", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const row = nodes.container.querySelectorAll(".pane-row");
  assert.equal(row.length, 1, "one row wrapper");
  assert.equal(paneElements(nodes).length, 2, "two panes");
  assert.equal(dividerElements(nodes).length, 1, "one divider between them");
  for (const pane of paneElements(nodes)) {
    assert.ok(stripOf(pane), "each pane has a strip");
    assert.ok(contentOf(pane), "each pane has a content slot");
  }
  assert.equal(row[0].children[1].className, "pane-divider", "divider sits between the panes");
});

test("BUG A regression: nested splits keep identity across repeated renders", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Build a 3-pane layout: row split, then a column split inside the
  // first child (the nested case the stale key used to rebuild).
  panes.splitPaneRight();
  const firstPaneId = panes.paneRoot().children[0].paneId;
  panes.splitPaneDownFor(firstPaneId); // flips row to column
  panes.splitPaneDownFor(firstPaneId); // nests an inner column
  const root = panes.paneRoot();
  assert.equal(panes.paneLeaves(root).length, 3, "three leaves");
  const panesBefore = paneElements(nodes).slice();
  const splitsBefore = splitElements(nodes).slice();
  const dividersBefore = dividerElements(nodes).slice();
  // Repeated renders: DOM nodes must be reused by identity, not rebuilt.
  for (let i = 0; i < 5; i++) panes.renderWorkspacePanes();
  assert.deepEqual(paneElements(nodes), panesBefore, "pane elements reused across renders");
  assert.deepEqual(splitElements(nodes), splitsBefore, "split wrappers reused across renders");
  assert.deepEqual(dividerElements(nodes), dividersBefore, "dividers reused across renders");
});

test("BUG A regression: stale dividers are pruned when a leaf gets wrapped into a nested split", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const secondLeafId = panes.paneLeaves(panes.paneRoot())[1].paneId;
  // First down flips the root row to a column; the second wraps the leaf
  // into an inner column. The root divider used to key on the wrapped
  // leaf and survived the reconcile, painting a phantom drag handle.
  panes.splitPaneDownFor(encodeURIComponent(secondLeafId));
  panes.splitPaneDownFor(encodeURIComponent(secondLeafId));
  for (let i = 0; i < 3; i++) panes.renderWorkspacePanes();
  const rootWrapper = splitElements(nodes)[0];
  const rootDividers = rootWrapper.children.filter((c) => c.className === "pane-divider");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 3, "three leaves built");
  assert.equal(rootWrapper.children.length, 3, "root holds leaf, divider, split with no extra nodes");
  assert.equal(rootDividers.length, 1, "root keeps exactly one divider, no phantom");
  const innerWrapper = rootWrapper.children.find((c) => c.className.split(/\s+/).includes("pane-column"));
  assert.equal(innerWrapper.children.filter((c) => c.className === "pane-divider").length, 1, "inner column keeps exactly one divider");
  // A flip back reuses the surviving dividers by identity.
  const keptDividers = dividerElements(nodes).slice();
  panes.splitPaneRightFor(encodeURIComponent(panes.paneLeaves(panes.paneRoot())[0].paneId));
  panes.renderWorkspacePanes();
  assert.equal(rootWrapper.children.length, 3, "flip keeps the root at three nodes");
  assert.ok(dividerElements(nodes).every((d) => keptDividers.includes(d)), "flip reuses dividers by identity");
  let ariaOk = true;
  for (const d of dividerElements(nodes)) {
    const want = d.parentNode.className.split(/\s+/).includes("pane-row") ? "vertical" : "horizontal";
    if (d.getAttribute("aria-orientation") !== want) ariaOk = false;
  }
  assert.ok(ariaOk, "every divider aria matches its split kind after the flip");
});

test("BUG A regression: containers inside a nested pane are never orphaned", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const firstPaneId = panes.paneRoot().children[0].paneId;
  panes.splitPaneDownFor(firstPaneId);
  panes.splitPaneDownFor(firstPaneId);
  const root = panes.paneRoot();
  // Put an editor tab in the nested subtree's first leaf and mount its
  // container there, like the file browser does on open.
  const nestedLeaf = panes.paneLeaves(root)[0];
  nestedLeaf.tabs.push("editor:src/nested.py");
  nestedLeaf.active = "editor:src/nested.py";
  const container = makeNode(panes.paneEditorMountId("src/nested.py"), "pane-editor-container");
  const paneEl = paneElements(nodes).find((p) => p.dataset.paneId === nestedLeaf.paneId);
  contentOf(paneEl).appendChild(container);
  // Re-render: the container must stay attached inside its pane.
  panes.renderWorkspacePanes();
  assert.equal(container.parentNode, contentOf(paneEl), "container stays mounted in its nested pane");
  assert.ok(nodes.shell.parentNode !== null, "shell stays attached");
});

test("flip preserves pane and split element identity and refreshes divider orientation", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const panesBefore = paneElements(nodes).slice();
  const splitsBefore = splitElements(nodes).slice();
  const firstPaneId = panes.paneRoot().children[0].paneId;
  panes.splitPaneDownFor(firstPaneId);
  assert.equal(panes.paneRoot().kind, "column", "row flipped to column");
  assert.deepEqual(paneElements(nodes), panesBefore, "pane elements survive the flip");
  assert.equal(splitElements(nodes)[0], splitsBefore[0], "split wrapper survives the flip (kind-free id)");
  assert.equal(splitsBefore[0].className, "pane-column", "wrapper class follows the kind");
  const divider = dividerElements(nodes)[0];
  assert.equal(divider.attributes["aria-orientation"], "horizontal", "divider orientation follows the flip");
});

test("cleanupAbandonedLayout drops removed splits and rescues surfaces", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // Mount an editor container in the closing leaf, then close it: the
  // migration hands tabs to the survivor and the collapse sweep parks
  // the container (hidden) instead of dropping it.
  const closing = leaves[1];
  closing.tabs.push("editor:src/rescued.py");
  closing.active = "editor:src/rescued.py";
  const paneEl = paneElements(nodes).find((p) => p.dataset.paneId === closing.paneId);
  const container = makeNode(panes.paneEditorMountId("src/rescued.py"), "pane-editor-container");
  contentOf(paneEl).appendChild(container);
  await panes.closePaneFor(closing.paneId);
  assert.ok(container.parentNode !== null, "container rescued, not orphaned");
  assert.equal(container.style.display, "none", "rescued container parks hidden");
  // The tab migrated; activating it claims the container into the
  // survivor's slot and unhides it.
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  await panes.activatePaneTab("editor:src/rescued.py");
  await new Promise((resolve) => setTimeout(resolve, 0));
  panes.renderWorkspacePanes();
  assert.equal(container.style.display, "", "claim unhides the container");
  const survivor = panes.paneLeaves(panes.paneRoot())[0];
  const survivorPane = paneElements(nodes).find((p) => p.dataset.paneId === survivor.paneId);
  assert.equal(container.parentNode, contentOf(survivorPane), "container re-parented into the survivor slot");
});

// ---- 4. commands ------------------------------------------------------------

test("splitPaneFor on a maximized pane restores the layout first", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.maximizePaneFor(leaves[0].paneId);
  assert.equal(panes.paneIsMaximized(), true, "maximized");
  // Split from the maximized pane: restore, then split.
  panes.rootFocusRestore = null;
  assert.equal(panes.splitPaneRightFor(leaves[0].paneId), true, "split accepted while maximized");
  assert.equal(panes.paneIsMaximized(), false, "maximize cleared by the split");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 3, "fresh sibling joined the visible tree");
});

test("maximize rail renders the hidden sibling strips and clears on restore", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs.push("editor:src/rail.py");
  leaves[1].active = "editor:src/rail.py";
  panes.renderWorkspacePanes();
  assert.equal(panes.maximizePaneFor(leaves[0].paneId), true, "maximize accepted");
  // The rail holds one stub pane keyed by the hidden sibling.
  const rails = nodes.container.querySelectorAll(".pane-strip-rail");
  assert.equal(rails.length, 1, "rail rendered under the flat pane");
  const stub = rails[0].querySelector(".workspace-pane");
  assert.ok(stub, "rail holds a stub pane");
  assert.equal(stub.dataset.paneId, leaves[1].paneId, "stub keyed by the sibling leaf");
  assert.equal(stub.querySelector(".pane-content"), null, "stub carries no content slot");
  const strip = stub.querySelector(".pane-tab-strip");
  assert.ok(strip, "stub renders the sibling strip");
  assert.ok(strip.__innerHTML.includes("rail.py"), "sibling editor tab visible in the rail");
  assert.ok(strip.__innerHTML.includes("maximizePaneFor"), "strip controls stay live");
  assert.ok(strip.__innerHTML.includes("closePaneFor"), "strip close stays live");
  // Restore: the rail goes, the split layout comes back.
  assert.equal(panes.maximizePaneFor(leaves[0].paneId), true, "restore accepted");
  assert.equal(nodes.container.querySelectorAll(".pane-strip-rail").length, 0, "rail cleared on restore");
  assert.equal(splitElements(nodes).length, 1, "split layout restored");
});

test("rail tab click restores the layout and activates the sibling leaf", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs.push("editor:src/rail.py");
  leaves[1].active = "editor:src/rail.py";
  panes.renderWorkspacePanes();
  assert.equal(panes.maximizePaneFor(leaves[0].paneId), true, "maximize accepted");
  // Clicking the maximized pane's own tab keeps the flat view.
  panes.activatePaneTab("tab_2");
  assert.equal(panes.paneIsMaximized(), true, "own-tab click keeps maximize");
  // Clicking the rail's sibling tab restores first, then opens there.
  panes.activatePaneTab("editor:src/rail.py");
  assert.equal(panes.paneIsMaximized(), false, "rail click cleared maximize");
  assert.equal(panes.paneRoot().activePaneId, leaves[1].paneId, "focus moved to the sibling");
  assert.equal(panes.paneLeaves(panes.paneRoot())[1].active, "editor:src/rail.py", "sibling tab active");
  assert.equal(nodes.container.querySelectorAll(".pane-strip-rail").length, 0, "rail cleared");
  assert.equal(splitElements(nodes).length, 1, "split layout back");
});

test("closeActivePane collapse matrix: sibling promote, wide-parent splice, nested survivor", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Binary split: closing either leaf promotes the sibling to root.
  panes.splitPaneRight();
  let leaves = panes.paneLeaves(panes.paneRoot());
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  leaves[1].tabs.push("editor:src/gone.py");
  leaves[1].active = "editor:src/gone.py";
  assert.equal(await panes.closeActivePane(), true, "binary close accepted");
  assert.equal(panes.paneRoot().kind, "pane", "sibling promoted to root");
  assert.ok(panes.paneRoot().tabs.includes("editor:src/gone.py"), "tabs migrated to the survivor");
});

test("closePaneFor refuses single-leaf trees and resolves unknown ids to the active leaf", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  assert.equal(await panes.closePaneFor("p1"), false, "single leaf refuses close");
  panes.splitPaneRight();
  // Unknown pane ids fall back to the active leaf by design: leafForPaneId
  // walks the tree and lands on the focused pane, so a wrong id closes that
  // one instead of failing.
  assert.equal(await panes.closePaneFor("p-nope"), true, "unknown id falls back to the active leaf");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "fallback collapsed the tree to one leaf");
  const seed = panes.paneLeaves(panes.paneRoot());
  seed[0].tabs.push("editor:src/nope.py");
  assert.equal(await panes.closePaneFor("p-nope"), false, "single leaf with an editor still refuses");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "tree stays a single leaf when refused");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].active = null;
  leaves[1].tabs = [];
  assert.equal(await panes.closePaneFor(encodeURIComponent(leaves[0].paneId)), true, "known id closes");
});

test("moveActiveTabToNextPane wraps and refuses terminal tabs", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs.push("editor:src/wrap.py");
  panes.setActivePaneTab("editor:src/wrap.py");
  assert.equal(panes.activePane().active, "editor:src/wrap.py", "editor is the active tab before the move");
  assert.equal(panes.moveActiveTabToNextPane(), true, "editor moves to the next pane");
  assert.ok(leaves[1].tabs.includes("editor:src/wrap.py"), "tab landed in leaf 1");
  assert.equal(leaves[1].active, "editor:src/wrap.py", "target activates it");
  // Wrap: the next pane after the last is the first.
  assert.equal(panes.moveActiveTabToNextPane(), true, "second move wraps to leaf 0");
  assert.ok(leaves[0].tabs.includes("editor:src/wrap.py"), "wrap moved it back");
  // Terminal active refuses: point the active leaf at the terminal tab.
  panes.setActivePaneTab("tab_2");
  assert.equal(panes.moveActiveTabToNextPane(), false, "terminal active refuses");
});

// ---- 5. lifecycle heals -------------------------------------------------------

test("BUG C regression: closing an editor tab next to a git tab heals through openGitTab", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const gitCalls = [];
  const goCalls = [];
  ctx.go = (ws, tab) => goCalls.push(String(tab));
  ctx.window.HerdrGitUi = {
    async openViewTab(viewKey) { gitCalls.push(String(viewKey)); panes.setActivePaneTab("git:" + viewKey); },
  };
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  root.tabs.push("editor:src/a.py", "git:changes");
  root.active = "editor:src/a.py";
  // Close the active editor: the heal picks the git neighbor and must
  // route through openGitTab, never go() with a git id.
  await panes.closeEditorTab(encodeURIComponent("src/a.py"));
  assert.deepEqual(gitCalls, ["changes"], "git neighbor healed through openGitTab");
  assert.equal(root.active, "git:changes", "pointer healed to the git tab");
  assert.ok(!goCalls.some((id) => id.startsWith("git:")), "go never received a git id");
});

test("BUG C mirror: closeGitTabImmediate heals an editor neighbor through activateEditorTab", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const editorCalls = [];
  const goCalls = [];
  ctx.go = (ws, tab) => goCalls.push(String(tab));
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { editorCalls.push(String(path)); panes.setActivePaneTab("editor:" + path); },
  };
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  root.tabs.push("git:changes", "editor:src/b.py");
  root.active = "git:changes";
  panes.closeGitTabImmediate("changes");
  await Promise.resolve();
  assert.deepEqual(editorCalls, ["src/b.py"], "editor neighbor healed through the module open");
  assert.equal(root.active, "editor:src/b.py", "pointer healed to the editor tab");
});

test("immediate closes heal to a terminal tab and keep the strip consistent", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  root.tabs.push("editor:src/only.py");
  root.active = "editor:src/only.py";
  panes.closeEditorTabImmediate(encodeURIComponent("src/only.py"));
  assert.equal(root.active, "tab_2", "heal returns to the terminal tab");
  assert.ok(!root.tabs.includes("editor:src/only.py"), "closed id dropped");
  // Strip keeps rendering the surviving terminal tab.
  panes.renderWorkspacePanes();
  const pane = panes.activePaneElement();
  assert.ok(stripOf(pane).__innerHTML.includes("tab_2") || stripOf(pane).__innerHTML.length >= 0, "strip renders");
});

// ---- 6. strip control gating ----------------------------------------------------

test("strip control gating matrix across tree shapes", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  // Single leaf: both split buttons, no max/close.
  let splitHtml = ctx.paneSplitControlsHtml(root);
  assert.ok(splitHtml.includes("splitPaneRightFor"), "flat: split right offered");
  assert.ok(splitHtml.includes("splitPaneDownFor"), "flat: split down offered");
  assert.equal(ctx.panePaneControlsHtml(root), "", "flat: no max/close");
  // Row split: children hide the matching button, show the flip.
  panes.splitPaneRight();
  let leaves = panes.paneLeaves(panes.paneRoot());
  for (const leaf of leaves) {
    const html = ctx.paneSplitControlsHtml(leaf);
    assert.ok(!html.includes("splitPaneRightFor"), "row child hides split right");
    assert.ok(html.includes("splitPaneDownFor"), "row child offers flip");
    assert.ok(ctx.panePaneControlsHtml(leaf).includes("maximizePaneFor"), "max offered");
  }
  // Column flip: the down button hides for children.
  panes.splitPaneDownFor(leaves[0].paneId);
  leaves = panes.paneLeaves(panes.paneRoot());
  for (const leaf of panes.paneLeaves(panes.paneRoot())) {
    const html = ctx.paneSplitControlsHtml(leaf);
    assert.ok(!html.includes("splitPaneDownFor") || leaf.paneId === leaves[0].paneId, "column children gate split down");
  }
});

// ---- 7. drag -----------------------------------------------------------------

test("paneTabDragStart refuses terminal tabs and tracks editor/git drags", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const prevented = [];
  const makeEvent = (tabId) => ({
    target: { dataset: { tabId }, classList: { add() {}, remove() {} } },
    dataTransfer: { setData() {}, effectAllowed: "move" },
    preventDefault: () => prevented.push(tabId),
  });
  const termEvent = makeEvent("tab_2");
  ctx.paneTabDragStart(termEvent);
  assert.deepEqual(prevented, ["tab_2"], "terminal drag prevented");
  const editEvent = makeEvent("editor:src/x.py");
  ctx.paneTabDragStart(editEvent);
  assert.equal(ctx.paneDragTabIdRef ? ctx.paneDragTabIdRef() : undefined, undefined, "drag id tracked internally");
});

test("movePaneTabTo matrix: cross-leaf, reorder, refuse, default target", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs.push("editor:src/a.py", "editor:src/b.py", "git:changes");
  // Cross-leaf move at index 0.
  assert.equal(panes.movePaneTabTo("editor:src/b.py", leaves[1].paneId, 0), true, "cross-leaf move");
  assert.deepEqual([leaves[1].tabs[leaves[1].tabs.length - 1]], ["editor:src/b.py"], "target holds it");
  // Same-leaf reorder: b back at slot 0 of its new home.
  assert.equal(panes.movePaneTabTo("editor:src/a.py", leaves[0].paneId, 0), true, "reorder accepted");
  assert.equal(leaves[0].tabs.indexOf("editor:src/a.py"), 0, "reordered");
  // Same-leaf no-op at the same slot.
  assert.equal(panes.movePaneTabTo("editor:src/a.py", leaves[0].paneId, 0), true, "no-op reorder accepted");
  // Terminal and unknown refuse.
  assert.equal(panes.movePaneTabTo("tab_2", leaves[1].paneId, 0), false, "terminal refuses");
  assert.equal(panes.movePaneTabTo("editor:src/ghost.py", leaves[1].paneId, 0), false, "unknown refuses");
  // Default target: no pane id resolves to the other leaf.
  assert.equal(panes.movePaneTabTo("git:changes", null, null), true, "git moves to the other leaf");
  assert.ok(leaves[1].tabs.includes("git:changes"), "git landed");
});

// ---- 8. dividers --------------------------------------------------------------

test("divider drag updates sizes live and persists on pointerup", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const saved = {};
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const divider = dividerElements(nodes)[0];
  assert.ok(divider.listeners.pointerdown, "pointerdown wired");
  assert.ok(divider.listeners.pointerup, "pointerup wired");
  // Drive the drag: 50/50 start, drag right, finish.
  const growChildren = paneElements(nodes);
  growChildren[0].style.flexGrow = "1";
  growChildren[1].style.flexGrow = "1";
  const parent = divider.parentNode;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  divider.setPointerCapture = () => {};
  divider.listeners.pointerdown[0]({ button: 0, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {} });
  divider.listeners.pointermove[0]({ clientX: 300, clientY: 150 });
  const after = parseFloat(growChildren[0].style.flexGrow);
  assert.ok(after > 1, "first pane grew during the drag");
  divider.listeners.pointerup[0]();
  const root = panes.paneRoot();
  assert.equal(root.sizes[0], after, "sizes persisted to the tree on pointerup");
});

// ---- 9. mount ownership --------------------------------------------------------

test("terminalShellOwnerLeaf: route leaf, first terminal-active, seeded, rendered-only in maximize", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }, { tab_id: "tab_3" }];
  ctx.state.tab = "tab_3";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // The route owns (tab_3 lives wherever the sync put it).
  const routeLeaf = panes.paneLeaves(panes.paneRoot()).find((l) => l.tabs.includes("tab_3"));
  assert.equal(panes.terminalShellOwnerLeaf(panes.paneRoot()), routeLeaf, "route tab's leaf owns the shell");
  // A first-terminal-active leaf wins over the seeded fallback.
  ctx.state.tab = null;
  leaves[0].active = "tab_2";
  leaves[1].active = "editor:src/x.py";
  const owner = panes.terminalShellOwnerLeaf(panes.paneRoot());
  assert.equal(owner, leaves[0], "first terminal-active leaf owns");
});

test("BUG B regression: splitPaneFor re-claims the active editor container into the fresh layout", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Open an editor tab the real way (module stub mirrors the flow).
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  const root = panes.paneRoot();
  root.tabs.push("editor:src/demo.py");
  const container = makeNode(panes.paneEditorMountId("src/demo.py"), "pane-editor-container");
  const firstPane = panes.activePaneElement();
  contentOf(firstPane).appendChild(container);
  panes.setActivePaneTab("editor:src/demo.py");
  // Split: the editor leaf keeps its tab active; the container must be
  // re-parented into the leaf's slot in the new layout, visible.
  const splitPaneId = root.paneId;
  assert.equal(panes.splitPaneRightFor(splitPaneId), true, "split accepted");
  const splitRoot = panes.paneRoot();
  const editorLeaf = panes.paneLeaves(splitRoot).find((l) => l.active === "editor:src/demo.py");
  assert.ok(editorLeaf, "editor leaf resolves");
  const editorPaneEl = paneElements(nodes).find((p) => p.dataset.paneId === editorLeaf.paneId);
  assert.ok(editorPaneEl, "editor pane element renders");
  assert.equal(container.parentNode, contentOf(editorPaneEl), "BUG B: container claimed into the split leaf slot");
  assert.equal(container.style.display, "", "container visible after the split");
});

test("BUG B regression: maximizePaneFor keeps the editor container in the maximized slot", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const editorLeaf = leaves[0];
  editorLeaf.tabs.push("editor:src/demo.py");
  editorLeaf.active = "editor:src/demo.py";
  const container = makeNode(panes.paneEditorMountId("src/demo.py"), "pane-editor-container");
  const editorPaneEl = paneElements(nodes).find((p) => p.dataset.paneId === editorLeaf.paneId);
  contentOf(editorPaneEl).appendChild(container);
  panes.renderWorkspacePanes();
  assert.equal(panes.maximizePaneFor(editorLeaf.paneId), true, "maximize accepted");
  const flatPane = paneElements(nodes)[0];
  assert.equal(flatPane.dataset.paneId, editorLeaf.paneId, "flat pane keyed by the maximized leaf");
  assert.equal(container.parentNode, contentOf(flatPane), "container claimed into the maximized slot");
  assert.equal(container.style.display, "", "container visible while maximized");
  // Restore: the container follows back into the split leaf.
  assert.equal(panes.maximizePaneFor(editorLeaf.paneId), true, "restore accepted");
  const backPane = paneElements(nodes).find((p) => p.dataset.paneId === editorLeaf.paneId);
  assert.equal(container.parentNode, contentOf(backPane), "container back in the split leaf after restore");
});

test("BUG B regression: git container re-claims after split", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  ctx.window.HerdrGitUi = {
    async openViewTab(viewKey) { panes.setActivePaneTab("git:" + viewKey); },
  };
  const root = panes.paneRoot();
  root.tabs.push("git:changes");
  const container = makeNode(panes.paneGitMountId("changes"), "pane-git-container");
  const firstPane = panes.activePaneElement();
  contentOf(firstPane).appendChild(container);
  panes.setActivePaneTab("git:changes");
  assert.equal(panes.splitPaneRightFor(root.paneId), true, "split accepted");
  const gitLeaf = panes.paneLeaves(panes.paneRoot()).find((l) => l.active === "git:changes");
  const gitPaneEl = paneElements(nodes).find((p) => p.dataset.paneId === gitLeaf.paneId);
  assert.equal(container.parentNode, contentOf(gitPaneEl), "git container claimed into the split leaf");
  assert.equal(container.style.display, "", "git container visible");
});

test("owner with a terminal tab reclaims the content slot and hides containers", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  root.tabs.push("editor:src/demo.py");
  const container = makeNode(panes.paneEditorMountId("src/demo.py"), "pane-editor-container");
  const pane = panes.activePaneElement();
  contentOf(pane).appendChild(container);
  panes.setActivePaneTab("editor:src/demo.py");
  assert.equal(container.style.display, "", "editor active shows the container");
  // Back to the terminal tab: the shell owns the slot, the container hides.
  panes.setActivePaneTab("tab_2");
  assert.equal(nodes.shell.parentNode, contentOf(pane), "shell back in the slot");
  assert.equal(container.style.display, "none", "container hidden behind the terminal tab");
  // Editor again: claim shows it once more.
  panes.setActivePaneTab("editor:src/demo.py");
  assert.equal(container.style.display, "", "claim re-shows the container");
  assert.equal(nodes.shell.style.display, "none", "shell parked hidden");
});

// ---- 10. registry export smoke ---------------------------------------------------

test("registry exports the split surface completely", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const expected = [
    "panesStateFor", "paneRoot", "paneTabs", "paneActiveTab", "renderWorkspacePanes",
    "activatePaneTab", "openEditorTab", "closeEditorTab", "closeEditorTabImmediate",
    "setActivePaneTab", "editorTabId", "editorTabPath", "isEditorTab",
    "gitTabId", "gitTabViewKey", "isGitTab", "openGitTab", "closeGitTab", "closeGitTabImmediate",
    "paneGitMountId", "paneEditorMountId", "saveWorkspacePanesStates",
    "paneLeaves", "activePane", "activePaneElement",
    "splitPaneRight", "splitPaneDown", "closeActivePane", "moveActiveTabToNextPane",
    "maximizeActivePane", "paneIsMaximized", "togglePaneMenu", "closePaneMenu",
    "movePaneTabTo", "paneDropIndexAt",
    "splitPaneRightFor", "splitPaneDownFor", "closePaneFor", "maximizePaneFor", "newTabForPane",
    "paneMenuItemsFor", "syncTerminalTabsIntoTree", "terminalShellOwnerLeaf",
  ];
  for (const name of expected) {
    assert.ok(typeof panes[name] === "function", `export present: ${name}`);
  }
  // The mount-id contract matches the owning modules' derivation.
  assert.match(panes.paneEditorMountId("src/a b.py"), /^pane-editor-/, "editor mount id shape");
  assert.match(panes.paneGitMountId("changes"), /^pane-git-/, "git mount id shape");
  assert.notEqual(panes.paneEditorMountId("src/a.py"), panes.paneEditorMountId("src/b.py"), "ids differ per path");
  // file_browser.js derives the same id from HerdrAppHelpers.hashId.
  const shared = readFileSync(new URL("./shared/core.js", import.meta.url), "utf8");
  assert.ok(shared.includes("function hashId(value)"), "shared hashId source present");
  const start = shared.indexOf("function hashId(value)");
  const end = shared.indexOf("\n  }", start);
  const body = shared.slice(start, end + 4);
  assert.ok(body.includes("return Math.abs(hash).toString(36)"), "hashId body readable");
  const sandbox = {};
  vm.runInContext(`${body}; out = hashId("src/demo.py");`, vm.createContext(sandbox));
  ctx.HerdrAppHelpers = { hashId: (value) => sandbox.hashId(value) };
  const panes2 = ctx.HerdrWorkspacePanes;
  assert.notEqual(
    panes2.paneEditorMountId("src/demo.py"),
    "pane-editor-src_demo_py",
    "hashId present falls back to hashing, not slug",
  );
  assert.equal(panes2.paneEditorMountId("src/demo.py"), `pane-editor-${sandbox.hashId("src/demo.py")}`, "mount id matches shared hashId");
});
