// Divider/member sizes coverage: the twin math behind member
// repositions (FIX A: newcomer share from the parent total, survivor
// sizes by original index), the group.sizes server op fired from the
// divider drag (FIX B), and the render() pane-tree signature gate
// (MEDIUM 4). Mirrors the Rust store pins (6 alternating moves keep
// sizes sane) on the client twin, which runs in local mode.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const WORKSPACE_PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const RENDER_PATH = fileURLToPath(new URL("./desktop/app_js/render.js", import.meta.url));
const workspacePanesScript = new vm.Script(readFileSync(WORKSPACE_PANES_PATH, "utf8"), {
  filename: WORKSPACE_PANES_PATH,
});
const renderScript = new vm.Script(readFileSync(RENDER_PATH, "utf8"), { filename: RENDER_PATH });

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
    hidden: id === "projectDashboard",
    listeners: {},
    __innerHTML: "",
    setAttribute(name, value) { node.attributes[name] = value; },
    getAttribute(name) { return node.attributes[name] != null ? node.attributes[name] : null; },
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
        contains(name) { return self.className.split(/\s+/).includes(name); },
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
    get() { return node.__innerHTML; },
    set(value) {
      node.__innerHTML = String(value);
      for (const child of node.children) child.parentNode = null;
      node.children.length = 0;
    },
  });
  Object.defineProperty(node, "parentElement", { get() { return node.parentNode; } });
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
  let activeElement = null;
  const document = {
    createElement: () => makeNode("", ""),
    getElementById: (id) => findById(id, body),
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
    get activeElement() { return activeElement; },
    set activeElement(value) { activeElement = value; },
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
      setItem(key, value) { storage[key] = value; },
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
    setTimeout: (fn) => { fn(); },
    go: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  workspacePanesScript.runInContext(vm.createContext(ctx));
  ctx.__storage = storage;
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

// Four panels in one row group, layout row[p1,p2,p3,p4], sizes [1,1,1,1].
function loadFourMemberRowGroup(document) {
  const panels = ["p1", "p2", "p3", "p4"].map((id, i) =>
    panelLeaf(id, [`t${i + 1}`], { groupId: "g1" }));
  const groups = [{
    groupId: "g1",
    name: null,
    memberIds: ["p1", "p2", "p3", "p4"],
    layout: { kind: "row", sizes: [1, 1, 1, 1], splitId: "s1", children: ["p1", "p2", "p3", "p4"] },
  }];
  const stored = v2Blob(panels, groups, { type: "group", id: "g1" });
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored, null);
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = panels.map((leaf, i) => ({ tab_id: `t${i + 1}`, workspace_id: "ws-1" }));
  ctx.state.tab = "t1";
  panes.showGroupFromRail(encodeURIComponent("g1"));
  panes.renderWorkspacePanes();
  return { ctx, panes };
}

function entryOf(panes) {
  return panes.paneRoot();
}

function firstGroup(panes) {
  return entryOf(panes).groups[0] || null;
}

function dragEvent(target, clientX, clientY) {
  return {
    target,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { setData() {}, getData: () => "", effectAllowed: "move", dropEffect: "move" },
  };
}

// FIX A pin: 6 alternating same-axis repositions (the Rust store pin)
// must not shrink any pane geometrically. The old twin halved the host
// slot per move and mis-mapped survivor sizes by kept index; 6 rounds
// collapsed a pane to 1/64 of its share.
test("FIX A: 6 alternating member repositions keep sizes sane (local twin)", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadFourMemberRowGroup(document);
  const group = firstGroup(panes);
  assert.ok(group, "group loaded");
  const memberDrag = (paneId) => {
    const chip = document.querySelectorAll(".workspace-pane")
      .find((p) => p.dataset.paneId === paneId);
    panes.paneMemberDragStart(dragEvent(chip, 0, 0), encodeURIComponent(paneId));
  };
  // Alternate dragging p1 onto p2 and back, 3 rounds = 6 moves. The
  // drop repositions the dragged member beside the host inside the
  // same row, hitting the same-axis extend branch of the twin.
  const p2Pane = document.querySelectorAll(".workspace-pane").find((p) => p.dataset.paneId === "p2");
  for (let round = 0; round < 3; round++) {
    for (const [moved, host] of [["p1", "p2"], ["p2", "p1"]]) {
      const wasFirst = moved < host ? "first" : "second";
      // dragging p1 onto p2's left half places p1 BEFORE p2 (first).
      const x = wasFirst === "first" ? 11 : 33;
      memberDrag(moved);
      panes.paneContainerTabDrop(dragEvent(p2Pane, x, 17));
    }
  }
  const sizes = group.layout.sizes;
  assert.equal(sizes.length, group.layout.children.length, "sizes length matches children");
  for (const size of sizes) assert.ok(size >= 0.5, `no entry collapses: ${sizes}`);
  // No host ever halved: each extend must change shares by at most the
  // newcomer's average share, never by half.
  for (const size of sizes) assert.ok(size <= 4.5, `no entry inflates: ${sizes}`);
});

// FIX A pin: removing a NON-LAST member keeps every survivor's own
// size (the old twin remapped by kept index, shifting the tail one
// left). Layout [a,b,c] sizes [1,2,3] minus b must yield [1,3].
test("FIX A: layout_without maps survivor sizes by original index", () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadFourMemberRowGroup(document);
  const group = firstGroup(panes);
  group.layout = { kind: "row", sizes: [1, 2, 3], splitId: "s1", children: ["p1", "p2", "p3"] };
  group.memberIds = ["p1", "p2", "p3"];
  panes.ungroupPaneMember("p2");
  assert.deepEqual(group.layout.children, ["p1", "p3"], "survivors keep their tree slots");
  assert.deepEqual([...group.layout.sizes], [1, 3], "each survivor keeps its own size, not its left neighbor's");
});

// FIX B pin: the divider drag writes the local tree (optimistic twin)
// and, in server mode, fires group.sizes with the resolved splitId
// path and the full sizes array.
test("FIX B: divider drag in server mode fires the group.sizes op", async () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadFourMemberRowGroup(document);
  const fired = [];
  ctx.api = async (url, init) => {
    const payload = JSON.parse(init.body);
    fired.push(payload);
    const entry = JSON.parse(JSON.stringify(panes.paneRoot()));
    return { entry };
  };
  panes.setPanesModeForTests("server");
  const divider = document.querySelectorAll(".pane-divider")[0];
  assert.ok(divider, "divider rendered");
  const growChildren = document.querySelectorAll(".workspace-pane");
  growChildren.forEach((p) => { p.style.flexGrow = "1"; });
  const parent = divider.parentNode;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  divider.setPointerCapture = () => {};
  divider.listeners.pointerdown[0]({ button: 0, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {} });
  divider.listeners.pointermove[0]({ clientX: 300, clientY: 150 });
  const after = parseFloat(growChildren[0].style.flexGrow);
  assert.ok(after > 1, "drag moved the pair");
  divider.listeners.pointerup[0]();
  await Promise.resolve();
  await Promise.resolve();
  const sizesOp = fired.find((op) => op.op === "group.sizes");
  assert.ok(sizesOp, "group.sizes fired");
  assert.equal(sizesOp.groupId, "g1", "op names the group");
  assert.equal(sizesOp.splitId, "s1", "op carries the splitId path the renderer wrote");
  assert.equal(sizesOp.sizes.length, 4, "op carries the full sizes array");
  assert.equal(sizesOp.sizes[0], after, "op sizes match the dragged flexGrow values");
});

// FIX B pin: local mode keeps today's behavior, no op fires.
test("FIX B: divider drag in local mode never fires a server op", async () => {
  const { nodes, document } = buildDom();
  const { ctx, panes } = loadFourMemberRowGroup(document);
  assert.equal(panes.panesMode(), "local", "harness runs local by default");
  let fired = 0;
  ctx.api = async () => { fired++; return { entry: null }; };
  const divider = document.querySelectorAll(".pane-divider")[0];
  const growChildren = document.querySelectorAll(".workspace-pane");
  growChildren.forEach((p) => { p.style.flexGrow = "1"; });
  const parent = divider.parentNode;
  parent.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  divider.setPointerCapture = () => {};
  divider.listeners.pointerdown[0]({ button: 0, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {} });
  divider.listeners.pointermove[0]({ clientX: 300, clientY: 150 });
  divider.listeners.pointerup[0]();
  await Promise.resolve();
  assert.equal(fired, 0, "no api call in local mode");
  const group = firstGroup(panes);
  assert.equal(group.layout.sizes.length, 4, "local twin still persisted the sizes");
});

// Standalone render.js realm wired to the panes module, with the
// paint call counted. Reuses the exact stub set the first MEDIUM 4
// test grew; every later gate test needs the same shell.
function makeRenderGate(panesCtx, panes) {
  const { document } = panesCtx;
  const realRender = panes.renderWorkspacePanes;
  let paints = 0;
  panes.renderWorkspacePanes = () => { paints++; };
  const renderCtx = {
    document,
    localStorage: panesCtx.localStorage,
    state: panesCtx.state,
    agents: makeNode("agents", "agents"),
    workspaces: makeNode("workspaces", "workspaces"),
    el: (id) => document.getElementById(id),
    window: null,
    escapeHtml: (v) => String(v),
    escapeAttr: (v) => String(v),
    tabTitle: () => "t",
    tabHoverTitle: () => "",
    titleWithWebuiShortcut: (t) => t,
    options: { agentSortMode: "off" },
    normalizeAgentStatusOrder: () => [],
    statusClass: () => "",
    statusDot: () => "",
    worktreeSidebarRowSignature: (w) => (w && w.path) || "",
    workspaceDragAttrs: () => "",
    selectionPath: (id) => `/${id}`,
    navigateSelection: () => true,
    workspaceCardKeydown: () => {},
    startWorkspaceRename: () => {},
    workspaceBranch: () => "",
    gitUiEnabled: () => false,
    fileBrowserEnabled: () => false,
    setupRightSidebarRail: () => {},
    workspacePath: () => "/repo",
    panelVisibleLabel: () => "panel",
    panelRenameInitialLabel: () => "panel",
    workspaceShellKey: (id) => `ws|${id}`,
    selectedOrDefaultWorkspace: () => ({ workspace_id: "ws-1" }),
    syncBrowserFavicon: () => {},
    syncProjectDashboard: () => {},
    syncWorkspaceEmptyLeaf: () => {},
    syncNoSleepControls: () => {},
    updateTitle: () => {},
    applySidebarCollapsed: () => {},
    syncGitWorkspaceToggle: () => {},
    syncFileWorkspaceToggle: () => {},
    renderSpacesCached: () => "",
    renderWorkspaceContextActions: () => "",
    renderAgents: () => "",
    themeToggleIcon: () => "",
    cleanupWorkingDismissals: () => {},
    fitTerminalShell: () => {},
    fitTerminalSurface: () => {},
    syncRightSidebarRail: () => {},
    panesByTabIndex: () => new Map(),
    announcePaneChanges: () => {},
    toast: () => {},
    api: async () => ({}),
    // core.js owns these caches when the full bundle loads; a standalone
    // render.js realm (this harness) supplies fresh ones.
    lastWorkspacesRenderSignature: null,
    lastWorkspacesRenderedHtml: "",
    lastWorkspacesHtml: "",
    lastAgentsHtml: "",
    lastTabsHtml: "",
  };
  renderCtx.window = renderCtx;
  renderCtx.globalThis = renderCtx;
  renderCtx.HerdrWorkspacePanes = panes;
  renderScript.runInContext(vm.createContext(renderCtx));
  renderCtx.HerdrLocationBar = { sync: () => {} };
  return {
    render: renderCtx.HerdrDesktopRender,
    get paints() { return paints; },
    restore() { panes.renderWorkspacePanes = realRender; return realRender; },
  };
}

// MEDIUM 4 pin: render() skips renderWorkspacePanes while the pane
// tree signature is unchanged, and paints once when it changes.
test("MEDIUM 4: render() gates renderWorkspacePanes on the pane tree signature", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  panesCtx.state.workspaces = [];
  panesCtx.state.allTabs = [];
  panesCtx.state.agents = [];
  panesCtx.state.worktrees = [];
  panesCtx.state.panes = [];
  panesCtx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panesCtx.state.tab = "tab_2";
  const gate = makeRenderGate(panesCtx, panes);
  const render = gate.render;
  render();
  assert.equal(gate.paints, 1, "first render paints: the signature was unseen");
  render();
  assert.equal(gate.paints, 1, "unchanged tree skips the pane repaint");
  // Tree change (a second panel mints): the signature moves and the
  // gate opens.
  panes.newPanelForFocused();
  render();
  assert.equal(gate.paints, 2, "tree change repaints the panes");
  render();
  assert.equal(gate.paints, 2, "the gate closes again on the settled tree");
  // Direct calls keep painting unconditionally.
  const realRender = gate.restore();
  realRender();
  assert.ok(document.getElementById("workspacePanes"), "direct render still paints");
});

// The signature folds in state.tab: a tab-only route change (tree
// untouched) must still open the gate, because the strip highlight
// homes through the render's route resync, never directly.
test("MEDIUM 4: a tab-only route change repaints the panes", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  panesCtx.state.workspaces = [];
  panesCtx.state.allTabs = [];
  panesCtx.state.agents = [];
  panesCtx.state.worktrees = [];
  panesCtx.state.panes = [];
  panesCtx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panesCtx.state.tab = "tab_2";
  const gate = makeRenderGate(panesCtx, panes);
  gate.render();
  assert.equal(gate.paints, 1, "first render paints");
  gate.render();
  assert.equal(gate.paints, 1, "quiet poll skips");
  panesCtx.state.tab = "other_tab";
  gate.render();
  assert.equal(gate.paints, 2, "tab-only route change repaints");
  gate.render();
  assert.equal(gate.paints, 2, "gate closes again on the settled route");
});

// A NEW backend row (id the tree has not homed yet) must open the
// gate: the homing itself runs inside renderWorkspacePanes via
// syncTerminalTabsIntoTree, so a gated render never sees the id.
test("MEDIUM 4: a new backend tab id repaints the panes", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  panesCtx.state.workspaces = [];
  panesCtx.state.allTabs = [];
  panesCtx.state.agents = [];
  panesCtx.state.worktrees = [];
  panesCtx.state.panes = [];
  panesCtx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panesCtx.state.tab = "tab_2";
  const gate = makeRenderGate(panesCtx, panes);
  gate.render();
  gate.render();
  assert.equal(gate.paints, 1, "quiet poll skips");
  panesCtx.state.tabs.push({ tab_id: "t9", workspace_id: "ws-1", label: "run", number: 9 });
  gate.render();
  assert.equal(gate.paints, 2, "new backend id repaints");
  gate.render();
  assert.equal(gate.paints, 2, "gate closes again");
});

// Label text feeds the strip spans (paneTerminalTabById rows): an
// edit to a row label or number, or to a workspace display name, must
// open the gate even though no tree fact moved.
test("MEDIUM 4: row and workspace label edits repaint the panes", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  panesCtx.state.workspaces = [{ workspace_id: "ws-1", label: "repo" }];
  panesCtx.state.workspaceBranches = {};
  panesCtx.state.allTabs = [];
  panesCtx.state.agents = [];
  panesCtx.state.worktrees = [];
  panesCtx.state.panes = [];
  panesCtx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "zsh", number: 2 }];
  panesCtx.state.tab = "tab_2";
  const gate = makeRenderGate(panesCtx, panes);
  gate.render();
  gate.render();
  assert.equal(gate.paints, 1, "quiet poll skips");
  panesCtx.state.tabs[0].label = "bash";
  gate.render();
  assert.equal(gate.paints, 2, "row label edit repaints");
  gate.render();
  assert.equal(gate.paints, 2, "gate closes again");
  panesCtx.state.workspaces[0].label = "repo-main";
  gate.render();
  assert.equal(gate.paints, 3, "workspace display name edit repaints");
  gate.render();
  assert.equal(gate.paints, 3, "gate closes again");
});

// worktreeDisplayName resolves the branch/worktree into the rendered
// name (render.js:1052): a branch switch changes the resolved name with
// workspace_id and w.label untouched, so the fingerprint must carry
// the RESOLVED value, not the raw label.
test("MEDIUM 4: a branch switch through worktreeDisplayName repaints the panes", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  panesCtx.state.workspaces = [{ workspace_id: "ws-1", label: "repo", worktree: { label: "repo", checkout_path: "/repo" } }];
  panesCtx.state.workspaceBranches = {};
  panesCtx.state.allTabs = [];
  panesCtx.state.agents = [];
  panesCtx.state.worktrees = [];
  panesCtx.state.panes = [];
  panesCtx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "zsh", number: 2 }];
  panesCtx.state.tab = "tab_2";
  let displayBranch = "main";
  panesCtx.worktreeDisplayName = (w) => `${(w && w.label) || "repo"} (${displayBranch})`;
  const gate = makeRenderGate(panesCtx, panes);
  gate.render();
  gate.render();
  assert.equal(gate.paints, 1, "quiet poll skips");
  displayBranch = "feature/pane-controls";
  gate.render();
  assert.equal(gate.paints, 2, "branch switch through worktreeDisplayName repaints");
  gate.render();
  assert.equal(gate.paints, 2, "gate closes again");
});