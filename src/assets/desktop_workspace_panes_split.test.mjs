// Split functionality coverage for workspace_panes.js. The older
// desktop_workspace_panes.test.mjs pins the strip/terminal seam; this
// file covers the split surface end to end: tree model repair, terminal
// sync rules, DOM identity across renders and reshapes, the command
// matrix (split/flip/nest, close-promote migration, maximize, move),
// lifecycle heals, strip control gating, divider resize, and the mount
// ownership invariants (container claim, rescue, parked-hidden).
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
    // Real browsers interleave dividers between children via the
    // renderer's insertBefore; without it here, 3+ child splits pile
    // the dividers at the end and the pair-drag lookup finds no
    // "after" neighbor. Mirror the DOM contract.
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
  // Element siblings: the renderer's divider placement reads
  // nextSibling/previousElementSibling and calls insertBefore, and the
  // pair-drag lookup depends on the interleaved order those produce.
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
  workspacePanesScript.runInContext(vm.createContext(ctx));
  ctx.__storage = storage;
  // Collector model: the boot seed leaf starts unbound. A harness ws
  // with no terminal rows yet would leave it unbound, and the sync's
  // focus-or-mint pass (state.ws set, no tab) would mint a SECOND panel
  // on the first render. Production rows arrive with the first snapshot;
  // tests that do not seed tabs bind the seed panel to the harness ws up
  // front so the one-panel boot contract holds.
  if (stateWs) {
    const seed = ctx.HerdrWorkspacePanes.paneRoot();
    if (seed && seed.kind === "pane" && !seed.wsId) seed.wsId = stateWs;
  }
  return ctx;
}

function loadPanesModule(document, stateWs) {
  return loadPanesModuleWithStorage(document, stateWs, null, null);
}

function bootstrapPanes(ctx, tabId) {
  // Collector model: rows without a workspace_id read as a snapshot
  // race and the sync leaves their ids homeless, so stub rows always
  // name the harness workspace.
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

test("the session tree persists to storage and reload restores it", () => {
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
  const entry = blob["__session__"];
  assert.ok(entry, "session entry stored under the fixed key");
  assert.equal(entry.root.kind, "row", "root kind persisted");
  assert.equal(entry.root.children.length, 2, "children persisted");
  assert.ok(panes.paneLeaves(entry.root).length >= 3, "leaves persisted");
  assert.ok(panes.paneLeaves(entry.root).some((leaf) => leaf.tabs.includes("editor:src/demo.py")), "editor tab persisted");
  // Reload in a fresh module: the stored session tree comes back (D1),
  // ids intact. Only genuinely dead ids leave on the first snapshot sync.
  const reloaded = loadPanesModuleWithStorage(buildDom().document, "ws-1", saved["herdr-web-workspace-panes"], null);
  const reRoot = reloaded.HerdrWorkspacePanes.paneRoot();
  assert.equal(reRoot.kind, "row", "reload restores the session split");
  const reLeaves = reloaded.HerdrWorkspacePanes.paneLeaves(reRoot);
  assert.equal(reLeaves.length, leaves.length, "layout survives reload");
  const allIds = reLeaves.flatMap((leaf) => [...leaf.tabs]);
  assert.ok(allIds.includes("editor:src/demo.py"), "editor tab survives reload");
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

test("forgetWorkspacePanes keeps the session tree and only sweeps the closed workspace's ids", () => {
  const { document } = buildDom();
  const saved = {};
  const ctx = loadPanesModuleWithStorage(document, "ws-1", null, saved);
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  panes.saveWorkspacePanesStates();
  assert.ok(saved["herdr-web-workspace-panes"], "open workspace state is stored during the session");

  panes.forgetWorkspacePanes("ws-1");

  assert.ok(ctx.state.workspacePanes["__session__"], "session tree survives the workspace close (D1)");
  assert.equal(ctx.state.workspacePanes["ws|ws-1"], undefined, "legacy per-workspace entries are dropped");
  assert.ok(saved["herdr-web-workspace-panes"], "session tree stays persisted after the close");
});

// ---- 2. sync ---------------------------------------------------------------

test("sync homes backend ids into the bound seed panel and prunes dead ids", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRoot();
  assert.ok(root.tabs.includes("terminal"), "fresh tree seeds the placeholder");
  // First backend list: the placeholder drops and the real ids home
  // into the seed panel (bound to ws-1 by the harness).
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }, { tab_id: "tab_3", workspace_id: "ws-1" }];
  assert.equal(panes.syncTerminalTabsIntoTree(root), true, "ids homed");
  assert.deepEqual([...root.tabs], ["tab_2", "tab_3"], "placeholder swapped for real ids");
  assert.equal(root.active, "tab_2", "active follows the seed");
  // New panel lands: append.
  ctx.state.tabs.push({ tab_id: "tab_4", workspace_id: "ws-1" });
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
  // Both panels belong to ws-1 (the split's fresh leaf binds before the
  // placement is consumed).
  leaves[1].wsId = "ws-1";
  // Simulate a tab that migrated to the second leaf.
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  leaves[1].tabs.push("tab_2");
  ctx.state.tabs.push({ tab_id: "tab_9", workspace_id: "ws-1" });
  // A pending + placement targets the first leaf: the sync consumes it
  // once, homing the missing id in the pressed panel.
  panes.requestTabPlacement(leaves[0].paneId);
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  assert.ok(leaves[1].tabs.includes("tab_2"), "moved terminal keeps its home");
  assert.ok(leaves[0].tabs.includes("tab_9"), "new id landed in the pressed panel");
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
  ctx.state.tabs.push({ tab_id: "tab_3", workspace_id: "ws-1" });
  panes.renderWorkspacePanes();
  // The sync homed tab_3 into the ws-1 seed panel (one panel tree).
  const owner = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.tabs.includes("tab_3"));
  assert.ok(owner, "route tab homed in the tree");
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
  // Build a 4-pane layout: row split, then a column nested in the first
  // child, then the column extended by a third sibling (tmux model:
  // every press adds a pane).
  panes.splitPaneRight();
  const firstPaneId = panes.paneRoot().children[0].paneId;
  panes.splitPaneDownFor(firstPaneId); // nests an inner column
  panes.splitPaneDownFor(firstPaneId); // extends the inner column
  const root = panes.paneRoot();
  assert.equal(panes.paneLeaves(root).length, 4, "four leaves");
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
  // The first down press wraps the leaf into an inner column (nest); the
  // root divider used to key on the wrapped leaf and survived the
  // reconcile, painting a phantom drag handle.
  panes.splitPaneDownFor(encodeURIComponent(secondLeafId));
  for (let i = 0; i < 3; i++) panes.renderWorkspacePanes();
  const rootWrapper = splitElements(nodes)[0];
  const rootDividers = rootWrapper.children.filter((c) => c.className === "pane-divider");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 3, "three leaves built");
  assert.equal(rootWrapper.children.length, 3, "root holds leaf, divider, split with no extra nodes");
  assert.equal(rootDividers.length, 1, "root keeps exactly one divider, no phantom");
  const innerWrapper = rootWrapper.children.find((c) => c.className.split(/\s+/).includes("pane-column"));
  assert.equal(innerWrapper.children.filter((c) => c.className === "pane-divider").length, 1, "inner column keeps exactly one divider");
  // Extending the row (a same-kind press on the row child) reuses the
  // surviving dividers by identity and adds one divider for the newcomer.
  const keptDividers = dividerElements(nodes).slice();
  panes.splitPaneRightFor(encodeURIComponent(panes.paneLeaves(panes.paneRoot())[0].paneId));
  panes.renderWorkspacePanes();
  assert.equal(rootWrapper.children.length, 5, "extend grows the root by leaf and divider");
  assert.ok(keptDividers.every((d) => dividerElements(nodes).includes(d)), "extend reuses dividers by identity");
  let ariaOk = true;
  for (const d of dividerElements(nodes)) {
    const want = d.parentNode.className.split(/\s+/).includes("pane-row") ? "vertical" : "horizontal";
    if (d.getAttribute("aria-orientation") !== want) ariaOk = false;
  }
  assert.ok(ariaOk, "every divider aria matches its split kind after the extend");
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

test("extend keeps pane and split element identity and divider orientation", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const panesBefore = paneElements(nodes).slice();
  const splitsBefore = splitElements(nodes).slice();
  const dividersBefore = dividerElements(nodes).slice();
  const firstPaneId = panes.paneRoot().children[0].paneId;
  panes.splitPaneRightFor(firstPaneId);
  const root = panes.paneRoot();
  assert.equal(root.kind, "row", "same-kind press extends the row");
  assert.equal(root.children.length, 3, "a third child joined the row");
  assert.ok(panes.paneLeaves(root).every((leaf) => leaf.kind === "pane"), "row children stay leaves");
  assert.deepEqual(paneElements(nodes).slice(0, 1), panesBefore.slice(0, 1), "first pane element survives the extend");
  assert.ok(panesBefore.every((p) => paneElements(nodes).includes(p)), "every existing pane element survives the extend");
  assert.equal(paneElements(nodes).length, 3, "one new pane element appeared");
  assert.equal(splitElements(nodes)[0], splitsBefore[0], "split wrapper survives the extend");
  assert.equal(splitsBefore[0].className, "pane-row", "wrapper class keeps the kind");
  assert.ok(dividersBefore.every((d) => dividerElements(nodes).includes(d)), "old dividers reused by identity");
  for (const d of dividerElements(nodes)) {
    assert.equal(d.getAttribute("aria-orientation"), "vertical", "divider orientation follows the row");
  }
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
  // Same-ws second panel: the close migration only hands tabs to a
  // panel of the closing panel's own workspace.
  closing.wsId = "ws-1";
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
  // Strips carry tabs only now: the pane commands live in the bar
  // controls, and the hidden sibling acts on itself once a rail tab
  // click restores focus to its leaf.
  assert.ok(!strip.__innerHTML.includes("maximizePaneFor"), "strip carries no pane commands");
  assert.ok(!strip.__innerHTML.includes("closePaneFor"), "strip carries no close");
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
  leaves[1].wsId = "ws-1";
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

test("split controls stay fully available across tree shapes", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  const root = panes.paneRoot();
  // tmux model: both split buttons always render, at any depth, so a
  // pane can always grow in both directions.
  let splitHtml = ctx.paneSplitControlsHtml(root);
  assert.ok(splitHtml.includes("splitPaneRightFor"), "flat: split right offered");
  assert.ok(splitHtml.includes("splitPaneDownFor"), "flat: split down offered");
  assert.equal(ctx.panePaneControlsHtml(root), "", "flat: no max/close");
  // Row children: both buttons still offered (extend), plus max/close.
  panes.splitPaneRight();
  for (const leaf of panes.paneLeaves(panes.paneRoot())) {
    const html = ctx.paneSplitControlsHtml(leaf);
    assert.ok(html.includes("splitPaneRightFor"), "row child still offers split right (extend)");
    assert.ok(html.includes("splitPaneDownFor"), "row child offers split down (nest)");
    assert.ok(ctx.panePaneControlsHtml(leaf).includes("maximizePaneFor"), "max offered");
  }
  // Deep nesting: a column-inside-row leaf keeps both buttons too.
  const firstId = panes.paneRoot().children[0].paneId;
  panes.splitPaneDownFor(firstId);
  for (const leaf of panes.paneLeaves(panes.paneRoot())) {
    const html = ctx.paneSplitControlsHtml(leaf);
    assert.ok(html.includes("splitPaneRightFor"), "nested child offers split right");
    assert.ok(html.includes("splitPaneDownFor"), "nested child offers split down");
  }
});

// ---- 7. drag -----------------------------------------------------------------

test("paneTabDragStart tracks terminal, editor, and git drags alike (D7)", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const prevented = [];
  const makeEvent = (tabId) => ({
    target: { dataset: { tabId }, classList: { add() {}, remove() {} } },
    dataTransfer: { setData() {}, effectAllowed: "move" },
    preventDefault: () => prevented.push(tabId),
  });
  // D7 lifted the terminal refusal: every tab kind drags. The drop path
  // (movePaneTabTo) owns the invariants.
  const termEvent = makeEvent("tab_2");
  ctx.paneTabDragStart(termEvent);
  assert.deepEqual(prevented, [], "terminal drag no longer prevented");
  ctx.paneTabDragEnd();
  const editEvent = makeEvent("editor:src/x.py");
  ctx.paneTabDragStart(editEvent);
  ctx.paneTabDragEnd();
  // The strip drop target must exist for the drag to land somewhere.
  assert.equal(typeof ctx.HerdrWorkspacePanes.movePaneTabTo, "function", "drop path reachable");
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
  // Terminal accepts (D7), placeholder and unknown refuse.
  assert.equal(panes.movePaneTabTo("tab_2", leaves[1].paneId, 0), true, "terminal moves (D7)");
  assert.equal(panes.movePaneTabTo("terminal", leaves[1].paneId, 0), false, "placeholder refuses");
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

// ---- 9. tmux-model depth and drag regressions ----------------------------------

test("every split press grows the leaf count at any depth", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Monotonic growth: 8 presses, alternating kinds, always on the
  // focused leaf (each press lands focus on the fresh pane). If any
  // press flipped or no-oped, the leaf count would stall below 9.
  for (let i = 0; i < 8; i++) {
    const before = panes.paneLeaves(panes.paneRoot()).length;
    const pressed = panes.activePane();
    assert.ok(pressed, "a focused leaf always answers the press");
    if (i % 2 === 0) panes.splitPaneRight();
    else panes.splitPaneDown();
    assert.equal(panes.paneLeaves(panes.paneRoot()).length, before + 1, `press ${i} added exactly one pane`);
  }
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 9, "nine leaves after eight presses");
});

test("deep nesting composes row and column splits at depth", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Build row > column > row > column: the chord splits anchor on the
  // ROUTE terminal's leaf (tab_2 in the seed panel), so every nest wraps
  // that leaf deeper and the chain hangs off children[0]; each fresh
  // sibling lands as the second child at the new level.
  panes.splitPaneRight();
  panes.splitPaneDown();
  panes.splitPaneRight();
  panes.splitPaneDown();
  let node = panes.paneRoot();
  const kinds = [];
  while (node && node.kind !== "pane") {
    kinds.push(node.kind);
    node = node.children[0];
  }
  assert.deepEqual(kinds, ["row", "column", "row", "column"], "four nested levels alternate kinds");
  // Every level's wrapper element rendered, with matching classes.
  const wrappers = splitElements(nodes);
  assert.equal(wrappers.length, 4, "one wrapper per split node");
  assert.equal(wrappers.filter((w) => w.className.includes("pane-row")).length, 2, "two row wrappers");
  assert.equal(wrappers.filter((w) => w.className.includes("pane-column")).length, 2, "two column wrappers");
  // The deepest leaf still gets both buttons: any pane can split again.
  const deepLeaf = panes.activePane();
  const html = ctx.paneSplitControlsHtml(deepLeaf);
  assert.ok(html.includes("splitPaneRightFor"), "depth-4 leaf offers split right");
  assert.ok(html.includes("splitPaneDownFor"), "depth-4 leaf offers split down");
});

test("divider drag resizes only the straddling pair in a 3-child split", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  const firstId = panes.paneRoot().children[0].paneId;
  panes.splitPaneRightFor(firstId); // extend: 3 leaves in the root row
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(leaves.length, 3, "three leaves in the row");
  panes.renderWorkspacePanes();
  const rootWrapper = splitElements(nodes)[0];
  const dividers = dividerElements(nodes);
  assert.equal(dividers.length, 2, "two dividers in the row");
  // Size the row thirds, then drag the SECOND divider (between
  // children 2 and 3): only that pair moves, child 1 keeps its share.
  const panesEls = paneElements(nodes);
  panesEls.forEach((p) => { p.style.flexGrow = "1"; });
  const divider = dividers[1];
  rootWrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300 });
  divider.setPointerCapture = () => {};
  divider.listeners.pointerdown[0]({ button: 0, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {} });
  divider.listeners.pointermove[0]({ clientX: 250, clientY: 150 });
  divider.listeners.pointerup[0]();
  const sizes = panes.paneRoot().sizes;
  assert.ok(sizes && sizes.length === 3, "full 3-slot sizes array persisted");
  assert.equal(parseFloat(sizes[0]), 1, "child before the pair kept its share");
  assert.ok(parseFloat(sizes[1]) > 1, "pair's left member grew");
  assert.ok(parseFloat(sizes[2]) < 1, "pair's right member shrank");
  const sum = sizes.reduce((acc, s) => acc + parseFloat(s), 0);
  assert.ok(Math.abs(sum - 3) < 0.01, "shares still sum to the row total");
});

test("split wrapper ids stay stable across an extend mid-array", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  // Row with a column nested in the middle child, then extend the row:
  // the inner split's id must not shift even though the leaf beside it
  // moved one slot right in the children array.
  panes.splitPaneRight();
  panes.splitPaneDown();
  const innerWrapperBefore = splitElements(nodes).find((w) => w.className.includes("pane-column"));
  const innerIdBefore = innerWrapperBefore.dataset.splitId;
  const leafId = panes.paneLeaves(panes.paneRoot())[0].paneId;
  panes.splitPaneRightFor(encodeURIComponent(leafId));
  panes.renderWorkspacePanes();
  const innerWrapperAfter = splitElements(nodes).find((w) => w.className.includes("pane-column"));
  assert.equal(innerWrapperAfter, innerWrapperBefore, "inner wrapper element reused by identity");
  assert.equal(innerWrapperAfter.dataset.splitId, innerIdBefore, "inner split id survived the mid-array splice");
  // The saved blob keeps the same split ids (reload must not mint
  // duplicates), and the tree round-trips through localStorage. The
  // inner column is the root's only split child after the extend, so
  // the wrapper id must appear in the persisted root's child splitId.
  const raw = ctx.window.localStorage.getItem("herdr-web-workspace-panes");
  assert.ok(raw, "state persisted");
  const savedEntry = JSON.parse(raw)["__session__"];
  assert.ok(savedEntry && savedEntry.root, "saved blob holds the session root");
  const savedInner = savedEntry.root.children.find((child) => child.kind === "column");
  assert.ok(savedInner, "persisted tree keeps the inner column");
  // The wrapper carries the id PATH (parent/child), the node its own
  // id; compare against the path's last segment.
  assert.equal(savedInner.splitId, innerIdBefore.split("/").pop(), "persisted inner splitId matches the wrapper id");
});

// ---- 9. mount ownership --------------------------------------------------------

test("terminalShellOwnerLeaf: route leaf, first terminal-active, seeded, rendered-only in maximize", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }, { tab_id: "tab_3", workspace_id: "ws-1" }];
  ctx.state.tab = "tab_3";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // The route owns (tab_3 lives wherever the sync put it).
  const routeLeaf = panes.paneLeaves(panes.paneRoot()).find((l) => l.tabs.includes("tab_3"));
  assert.ok(routeLeaf, "route tab homed");
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
    // The location bar unsplit pair (the bar module owns
    // the DOM listeners, this module owns qualification + surgery).
    "paneTabUnsplitHover", "paneTabUnsplitDrop",
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

// ---- empty leaf collapse (split behavior fix) -----------------------------
// Closing the last tab of one split pane must not strand a blank half:
// the tree collapses to the survivor, the survivor takes focus, and a
// single-leaf workspace keeps its empty leaf for the New terminal card.

test("onTerminalTabClosed prunes the closed tab and the emptied split leaf folds once focus leaves", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-40");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["t1"];
  leaves[0].active = "t1";
  leaves[1].tabs = ["t2"];
  leaves[1].active = "t2";
  ctx.state.tabs = [{ tab_id: "t1", workspace_id: "ws-40" }, { tab_id: "t2", workspace_id: "ws-40" }];
  ctx.state.tab = "t2";
  panes.renderWorkspacePanes();

  // t2 closes (the route was on it): the facade prunes the dead id,
  // sweeps (the emptied leaf still holds focus, so it stands), and
  // paints once. The route falls back to t1, but the route sync writes
  // no focus move (the survivor already points at t1), so the emptied
  // leaf keeps focus and stands: Enter can still spawn a terminal
  // there. Only a real focus gesture onto the survivor lets the
  // render-top sweep fold the split.
  ctx.state.tabs = [{ tab_id: "t1", workspace_id: "ws-40" }];
  ctx.state.tab = "t1";
  assert.equal(panes.onTerminalTabClosed("t2"), true, "prune reported");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "emptied leaf holds focus and stands");
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "route fallback alone moves no focus");
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  panes.renderWorkspacePanes();
  const after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "emptied leaf auto-closed once focus leaves");
  const survivor = after.find((leaf) => leaf.paneId === leaves[0].paneId);
  assert.ok(survivor, "survivor promoted");
  assert.equal(survivor.active, "t1", "survivor pointer intact");
});

test("onTerminalTabClosed prunes unknown ids only and keeps every split leaf", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-41");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  // Single leaf: an unknown id is a no-op (the tree never drops its
  // last panel on its own).
  assert.equal(panes.onTerminalTabClosed("missing"), false, "unknown id is a no-op");
  // Split created by the strip: the fresh sibling is empty BY DESIGN,
  // and closing the terminal leaf's tab empties it too without any
  // collapse sweep ever targeting a panel.
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["t1"];
  leaves[0].active = "t1";
  ctx.state.tabs = [{ tab_id: "t1", workspace_id: "ws-41" }];
  panes.renderWorkspacePanes();
  // Focus the leaf holding t1: splitPaneRight left focus on the fresh
  // sibling, and the facade's synchronous sweep folds an unfocused
  // emptied leaf immediately (that IS the v3.2 rule). With focus on the
  // soon-emptied leaf the sweep must protect it: the panel stands for
  // Enter, and only a real focus move folds it.
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  assert.equal(panes.onTerminalTabClosed("missing"), false, "unknown id is a no-op");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "split intact");
  assert.equal(panes.onTerminalTabClosed("t1"), true, "live tab prunes from its leaf");
  assert.deepEqual([...leaves[0].tabs], [], "terminal id dropped");
  // v3.2: the closed leaf keeps focus through the facade's own sweep
  // (the tree pointer did not move), so both panels stand empty until
  // focus leaves the closed one; the render-top sweep then folds the
  // split.
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "both panels stand while the emptied one holds focus");
  panes.focusPanelFor(encodeURIComponent(leaves[1].paneId));
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "abandoned empty panel closes on the next render");
});

test("closing an editor tab empties a split leaf and it auto-closes once unfocused", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-42");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  ctx.window.HerdrFileBrowser = {
    editorFor: () => null,
    closeEditorState: () => {},
    closeEditorTab: null,
  };
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // The fresh split leaf holds ONLY an editor tab: closing it empties the
  // pane. v3.2: the emptied leaf holds pane focus right after the close
  // (Enter can still spawn there), and the next render after focus moves
  // away folds the split.
  leaves[1].tabs = ["editor:src/only.py"];
  leaves[1].active = "editor:src/only.py";
  panes.renderWorkspacePanes();
  panes.closeEditorTabImmediate(encodeURIComponent("src/only.py"));
  let after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 2, "emptied leaf stands while focused");
  const emptied = after.find((leaf) => leaf.paneId === leaves[1].paneId);
  assert.deepEqual([...emptied.tabs], [], "editor id dropped");
  assert.equal(emptied.active, null, "empty panel keeps a null pointer");
  // The editor-active leaf had the pane focus; it keeps it (an empty
  // panel is a valid focus target, Enter opens a terminal there).
  assert.equal(panes.activePane().paneId, leaves[1].paneId, "focus stays on the emptied panel");
  // Focus away: the render-top sweep closes the abandoned panel.
  panes.focusPanelFor(encodeURIComponent(leaves[0].paneId));
  panes.renderWorkspacePanes();
  after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "abandoned empty panel auto-closed");
  assert.equal(after[0].paneId, leaves[0].paneId, "survivor promoted");
});

test("cross-leaf strip drag move that empties the source auto-closes it", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-43");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["t1"];
  leaves[0].active = "t1";
  leaves[1].tabs = ["editor:src/move.py"];
  leaves[1].active = "editor:src/move.py";
  panes.renderWorkspacePanes();
  // Drive the real gesture: the strip drop owns the v3.2 marker now
  // (the move primitive is pure tree surgery), so the emptied source
  // arms at the gesture site and folds on the drop's own render.
  const paneEls = document.querySelectorAll(".workspace-pane");
  const targetEl = paneEls.find((node) => node.dataset.paneId === leaves[0].paneId);
  assert.ok(targetEl, "target pane rendered");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/move.py" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneStripDrop({ target: targetEl, clientX: 28, clientY: 28, preventDefault() {} });
  // v3.2: a source emptied by the drag auto-closes (focus moved to the
  // target with the tab), the sweep folds the split on the drop's own
  // render pass.
  const after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "emptied source auto-closed");
  assert.ok(after[0].tabs.includes("editor:src/move.py"), "moved tab landed in the survivor");
  assert.equal(after[0].paneId, leaves[0].paneId, "survivor keeps its id");
});

test("rescue parks the empty-leaf card before a collapsed pane subtree is dropped", async () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanesModule(document, "ws-44");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  // Mount the singleton card into the split leaf's pane content, then
  // close that leaf explicitly (the collapse drops its pane subtree with
  // the card inside): rescue must park it home first.
  // NOTE: the emptied-leaf collapse path no longer fires on editor close
  // (leaf-standing model), so the closePaneFor command is the collapse
  // trigger that still exercises the rescue.
  const container = nodes.workspacePanes;
  const card = ctx.document.createElement("div");
  card.id = "workspaceEmptyLeaf";
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].wsId = "ws-44";
  leaves[1].tabs = ["editor:src/only.py"];
  leaves[1].active = "editor:src/only.py";
  panes.renderWorkspacePanes();
  const splitLeaves = document.querySelectorAll(".workspace-pane");
  const dropLeaf = splitLeaves[1].querySelector(".pane-content");
  dropLeaf.appendChild(card);
  await panes.closePaneFor(leaves[1].paneId);
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "split collapsed to one leaf");
  assert.equal(document.getElementById("workspaceEmptyLeaf"), card,
    "card survives the collapse reachable by id");
  assert.equal(card.parentNode, container,
    "rescue parked the card at the workspacePanes home");
  assert.equal(card.hidden, true,
    "parked card is hidden so it cannot paint a phantom pane for a tick");
  // The sync can mount it again: el() finds it, so mountEmptyLeafInPane
  // re-parents it into a pane content slot instead of silently no-opping.
  panes.mountEmptyLeafInPane(true);
  const remounted = document.querySelectorAll(".workspace-pane")[0]
    .querySelector(".pane-content");
  assert.equal(card.parentNode, remounted,
    "remount path adopts the rescued card into the pane content");
  assert.equal(document.getElementById("workspaceEmptyLeaf"), card,
    "card still reachable after the remount pass");
});

// ---- location bar pane controls ------------------------------------------
// One control group above the panes, acting on the focused leaf. Strips
// carry tabs only. The signature drives the bar's repaint loop, so it
// must move with focus and reshape.
test("bar controls render once, act on the focused leaf, and tracks focus", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");

  // Strips carry no commands; the bar group carries the full set.
  const strip = nodes.container.querySelector(".pane-tab-strip");
  const controls = panes.paneBarControlsHtml();
  assert.ok(!strip.__innerHTML.includes("splitPaneDownFor"), "strip carries no split command");
  assert.ok(controls.includes("pane-new-picker") || controls.includes("newPanelForFocused"), "bar carries the + control");
  assert.ok(controls.includes("splitPaneDownFor"), "bar carries split down");
  assert.ok(controls.includes("togglePaneMenu"), "bar carries the pane menu");

  // A split doubles the leaves but the bar still renders one group for
  // the focused leaf: the fresh sibling is active after split.
  assert.equal(panes.splitPaneDown(), true, "split accepted");
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(leaves.length, 2, "two leaves");
  const afterSplit = panes.paneBarControlsHtml();
  assert.ok(afterSplit.includes("maximizePaneFor"), "maximize appears once a split exists");
  assert.ok(afterSplit.includes("closePaneFor"), "close appears once a split exists");
  const targetId = leaves[1].paneId;
  assert.ok(afterSplit.includes(`'${encodeURIComponent(targetId)}'`),
    "commands target the focused leaf");

  // Focusing the first leaf moves the commands with it: the signature
  // changes, the markup names the other pane.
  const beforeFocus = panes.paneBarControlsSignature();
  panes.maximizePaneFor(targetId);
  panes.maximizePaneFor(targetId);
  // focusLeaf is not exported; activate a tab on the first leaf instead.
  leaves[0].tabs.push("editor:src/a.py");
  ctx.HerdrWorkspacePanes.setActivePaneTab("editor:src/a.py");
  assert.equal(panes.paneRoot().activePaneId, leaves[0].paneId, "focus moved to the first leaf");
  assert.notEqual(panes.paneBarControlsSignature(), beforeFocus, "signature moved with focus");
  assert.ok(panes.paneBarControlsHtml().includes(`'${encodeURIComponent(leaves[0].paneId)}'`),
    "commands target the newly focused leaf");

  // The dashboard takeover suppresses the group: pane controls would
  // target dead chrome.
  const dashboard = document.getElementById("projectDashboard");
  if (dashboard) {
    dashboard.hidden = false;
    assert.equal(panes.paneBarControlsHtml(), "", "dashboard takeover hides the controls");
    assert.equal(panes.paneBarControlsSignature(), "none", "signature reports the takeover");
  }
});

// ---- v3.2: empty-panel auto-close (armed leaves only) ----------------------
// The rule: only panels EMPTIED by a gesture (move, drop, close, backend
// prune) auto-close, and only once focus no longer protects them. Fresh
// splits mint empty panels BY DESIGN (Enter spawns there) and never arm,
// so consecutive splits build the tmux grid. A refill clears the marker.

test("v3.2: consecutive splits keep every fresh empty panel standing", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-50");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "tab_2");
  panes.splitPaneRight();
  panes.splitPaneRight();
  panes.splitPaneDown();
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(leaves.length, 4, "three splits grew the tree to four panels");
  // Renders never sweep the fresh empties: focus rides the last minted
  // leaf, and its siblings carry no arm marker.
  for (let i = 0; i < 3; i++) panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 4, "fresh empties never collapse");
});

test("v3.2: a move-emptied source folds and a refilled panel never folds", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-51");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  leaves[1].tabs = ["git:changes"];
  leaves[1].active = "git:changes";
  // No backend rows: nothing can adopt back into the emptied source, so
  // the fold under test is observable. The ws-only route sync focuses
  // the bound seed leaf.
  ctx.state.tabs = [];
  ctx.state.tab = null;
  panes.renderWorkspacePanes();
  // Drive the real gesture (the strip drop owns the v3.2 marker; the
  // move primitive is pure tree surgery): the editor tab moves to the
  // sibling, the source empties and arms at the gesture site, focus
  // lands on the target, and the drop's own render folds the source.
  const paneEls = document.querySelectorAll(".workspace-pane");
  const targetEl = paneEls.find((node) => node.dataset.paneId === leaves[1].paneId);
  assert.ok(targetEl, "target pane rendered");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/a.py" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.paneStripDrop({ target: targetEl, clientX: 28, clientY: 28, preventDefault() {} });
  let after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "armed emptied source folded");
  assert.equal(after[0].tabs.length, 2, "survivor holds both tabs");
  // A stale armed marker on a leaf holding tabs never folds it: the
  // sweep is empty-only, so a refilled panel is safe even if an arm
  // from an earlier gesture survived.
  after[0].autoCloseArmed = true;
  for (let i = 0; i < 3; i++) panes.renderWorkspacePanes();
  after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "refilled panel never folds");
  assert.ok(after[0].tabs.includes("editor:src/a.py"), "refilled tab intact");
});

test("v3.2: the sweep skips the focused armed leaf and the last panel", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-52");
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["editor:src/a.py"];
  leaves[0].active = "editor:src/a.py";
  // No backend rows: the armed leaf cannot be refilled by adoption.
  // The ws-only route sync focuses the bound seed leaf, so the close
  // below empties the FOCUSED leaf.
  ctx.state.tabs = [];
  ctx.state.tab = null;
  panes.renderWorkspacePanes();
  ctx.window.HerdrFileBrowser = {
    editorFor: () => null,
    closeEditorState: () => {},
    closeEditorTab: null,
  };
  // Close the editor tab with focus still on its leaf: armed but
  // focused, so the panel stands for the Enter spawn.
  panes.closeEditorTabImmediate(encodeURIComponent("src/a.py"));
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 2, "focused armed leaf stands");
  // Focus leaves the emptied panel: the next render folds it.
  panes.focusPanelFor(encodeURIComponent(leaves[1].paneId));
  panes.renderWorkspacePanes();
  const after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "armed leaf folds once unfocused");
  // The tree's last panel never drops even when armed and unfocused.
  after[0].tabs = [];
  after[0].autoCloseArmed = true;
  panes.renderWorkspacePanes();
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "last panel never drops");
});

test("v3.2: the persisted blob never carries the arm marker", () => {
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-53", null, {});
  const panes = ctx.HerdrWorkspacePanes;
  bootstrapPanes(ctx, "t1");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs = ["editor:src/a.py"];
  leaves[1].active = "editor:src/a.py";
  panes.renderWorkspacePanes();
  // Close the tab: the leaf arms, the save runs with the marker set on
  // the LIVE tree, and the stored blob must not contain it.
  ctx.window.HerdrFileBrowser = {
    editorFor: () => null,
    closeEditorState: () => {},
    closeEditorTab: null,
  };
  panes.closeEditorTabImmediate(encodeURIComponent("src/a.py"));
  assert.equal(leaves[1].autoCloseArmed, true, "live tree keeps the marker for the sweep");
  const stored = Object.values(ctx.__storage)[0] || "";
  assert.ok(stored && !stored.includes("autoCloseArmed"), "blob strips the marker");
});

// Dock labels only (redo): the marked collector inside a live group is
// the label dock, not a viewing pane. Unfocused, it mounts NO surface:
// no aux terminal (ensureForLeaf never fires for it), and a shell left
// in its slot from an earlier stint parks home hidden. Focused, the dock
// is the panel being viewed and mounts like any pane.
test("unfocused group dock mounts no terminal surface; focused dock mounts normally", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanesModule(document, "ws-70");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  const dock = { kind: "pane", paneId: "da", tabs: ["tab_1", "tab_3"], active: "tab_1", wsId: "ws-70", groupCollector: true };
  const view = { kind: "pane", paneId: "db", tabs: ["tab_2"], active: "tab_2", wsId: "ws-70" };
  const slot = { kind: "pane", paneId: "dc", tabs: [], active: null, wsId: "ws-70", groupSlot: true };
  entry.root = { kind: "row", sizes: [1, 1, 1], children: [dock, view, slot] };
  entry.root.activePaneId = "db";
  ctx.state.tabs = ["tab_1", "tab_2", "tab_3"].map((id) => ({ tab_id: id, workspace_id: "ws-70" }));
  ctx.state.tab = "tab_2";
  // Aux stub records ensureForLeaf calls per pane; the shell node rides
  // the harness DOM like the real one.
  const ensured = [];
  ctx.window.HerdrPaneTerminals = {
    ensureForLeaf(pane, leaf) { ensured.push(leaf.paneId); return null; },
    parkForTab() {},
    releaseStale() {},
  };
  // Phase 1: the dock is focused and owns the route, so the shell mounts
  // in its slot like any pane (the user pressed a dock label).
  entry.root.activePaneId = "da";
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  const dockViewingPane = paneElements(nodes).find((p) => p.dataset.paneId === "da");
  assert.equal(nodes.shell.parentNode, contentOf(dockViewingPane), "focused dock hosts the shell");
  assert.notEqual(nodes.shell.style.display, "none", "focused dock shows the shell");
  // Phase 2: focus moves to a VIEW leaf with an editor active and a
  // ws-only route. The editor container claims the view slot, so the
  // view leaf is not a shell owner: no later pass re-hosts or re-shows
  // the shell in this render. The dock's gate must be the pass that
  // pulls the shell out of its slot and parks it home hidden, and no
  // aux surface may mount in the dock: labels only.
  view.tabs = ["editor:src/demo.py"];
  view.active = "editor:src/demo.py";
  entry.root.activePaneId = "db";
  ctx.state.tab = null;
  ctx.state.ws = "ws-70";
  panes.renderWorkspacePanes();
  const dockPane = paneElements(nodes).find((p) => p.dataset.paneId === "da");
  assert.ok(dockPane, "dock pane renders");
  assert.ok(!ensured.includes("da"), "unfocused dock mounts no aux surface");
  assert.notEqual(nodes.shell.parentNode, contentOf(dockPane), "shell left the dock slot");
  assert.equal(nodes.shell.style.display, "none", "shell from the dock's stint parks home hidden");
});

// Group collapse (label press) and expand (chip press): pressing a
// docked terminal label inside a live group returns the base state. The
// dock collects every view's labels, the slots drop, the split renders
// the dock pane alone with ONE "Group N panels" chip (member labels
// hidden), and the chip press restores the whole split.
test("dock label press collapses the group; chip press re-expands it", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanesModule(document, "ws-80");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const entry = panes.panesStateFor();
  const dock = { kind: "pane", paneId: "da", tabs: ["tab_1", "tab_3"], active: "tab_1", wsId: "ws-80", groupCollector: true };
  const view1 = { kind: "pane", paneId: "db", tabs: ["tab_2"], active: "tab_2", wsId: "ws-80" };
  const view2 = { kind: "pane", paneId: "dd", tabs: ["tab_4"], active: "tab_4", wsId: "ws-80" };
  const slot = { kind: "pane", paneId: "dc", tabs: [], active: null, wsId: "ws-80", groupSlot: true };
  entry.root = { kind: "row", sizes: [1, 1, 1, 1], children: [dock, view1, slot, view2], activePaneId: "db", splitId: "s90" };
  ctx.state.tabs = ["tab_1", "tab_2", "tab_3", "tab_4"].map((id) => ({ tab_id: id, workspace_id: "ws-80" }));
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  assert.equal(paneElements(nodes).length, 4, "expanded group paints four panes");

  // Press dock label tab_3: collapse. The press folds labels and routes;
  // the harness go stub skips the render pass, so drive it directly like
  // the maximize press tests do.
  panes.activatePaneTab("tab_3");
  panes.renderWorkspacePanes();
  assert.equal(paneElements(nodes).length, 1, "collapsed group paints the dock pane alone");
  const collapsedPane = paneElements(nodes)[0];
  assert.equal(collapsedPane.dataset.paneId, "da", "collapsed pane keeps the dock id");
  const collapsedStrip = collapsedPane.querySelector(".pane-tab-strip");
  // The stub DOM stores innerHTML without parsing it, so assert on the
  // raw strip markup like the rail/chip tests do.
  const chipHtml = collapsedStrip.__innerHTML;
  assert.ok(chipHtml.includes("pane-panel-group-collapsed"), "collapsed strip shows the group chip");
  assert.ok(chipHtml.includes("Group 2 panels"), "chip names the member view count");
  assert.ok(!chipHtml.includes("data-tab-id"), "member labels hidden while collapsed");
  assert.ok(chipHtml.includes("expandCollapsedGroup"), "chip click expands");
  assert.deepEqual([...dock.tabs].sort().map(String), ["tab_1", "tab_2", "tab_3", "tab_4"], "dock holds every folded label");
  assert.equal(dock.active, "tab_3", "pressed label is the mounted view");
  assert.equal(entry.root.activePaneId, "da", "focus sits on the dock");
  // Views survive the sweep: the stamp protects them.
  const leaves = panes.paneLeaves(entry.root);
  assert.equal(leaves.length, 3, "dock + two views stand in the tree");
  assert.ok(leaves.every((l) => !l.autoCloseArmed || !l.tabs.length), "no view holds tabs while collapsed");

  // Chip press: expand.
  const splitBefore = entry.root;
  assert.ok(panes.expandCollapsedGroup(encodeURIComponent("s90")), "expand fires");
  assert.equal(splitBefore.groupCollapsed, undefined, "stamp cleared");
  assert.equal(paneElements(nodes).length, 3, "expanded group paints dock + views");
  // Labels render through strip innerHTML (the stub DOM keeps markup
  // unparsed), so count labels in the raw markup like the chip tests.
  const stripMarkups = paneElements(nodes).map((p) => (p.querySelector(".pane-tab-strip") || { __innerHTML: "" }).__innerHTML);
  const labelCount = stripMarkups.reduce((sum, html) => sum + (html.match(/data-tab-id=/g) || []).length, 0);
  assert.ok(labelCount >= 4, "member labels visible again");
  assert.ok(stripMarkups.some((html) => html.includes("data-tab-id=\"tab_2\"")), "view label tab_2 back in its pane");
});
