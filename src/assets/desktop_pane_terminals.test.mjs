// Auxiliary split-pane terminals and the no-workspace dashboard mount.
// Two contracts live here: (1) a split leaf that is not the shell owner
// still renders its terminal panel through its own wterm instance and
// /ws/terminal socket (HerdrPaneTerminals), including reuse, rescue,
// disposal, input routing, error frames, and the divider refit; (2) the
// project dashboard fills the pane slot when no workspace is open
// (mountDashboardInPane from syncProjectDashboard).
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
    hidden: false,
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
  Object.defineProperty(node, "previousElementSibling", {
    get() {
      if (!node.parentNode) return null;
      const at = node.parentNode.children.indexOf(node);
      return at > 0 ? node.parentNode.children[at - 1] : null;
    },
  });
  Object.defineProperty(node, "nextSibling", {
    get() {
      if (!node.parentNode) return null;
      const at = node.parentNode.children.indexOf(node);
      return at >= 0 && at < node.parentNode.children.length - 1
        ? node.parentNode.children[at + 1]
        : null;
    },
  });
  Object.defineProperty(node, "clientWidth", {
    get() {
      return 800;
    },
  });
  Object.defineProperty(node, "clientHeight", {
    get() {
      return 600;
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

// Minimal wterm adapter stub: records writes, resize calls, dispose, and
// the onData callback so input routing assertions run against the same
// entry the socket writes to.
function makeRendererStub() {
  const created = [];
  return {
    created,
    create: async (container, opts) => {
      const term = {
        container,
        opts,
        cols: opts.cols,
        rows: opts.rows,
        writes: [],
        resized: [],
        themes: [],
        disposed: false,
        write(data) {
          term.writes.push(data);
        },
        resize(cols, rows) {
          term.cols = cols;
          term.rows = rows;
          term.resized.push([cols, rows]);
        },
        setTheme(theme) {
          term.themes.push(theme);
        },
        dispose() {
          term.disposed = true;
        },
      };
      created.push(term);
      return term;
    },
  };
}

// WebSocket stub with the bits pane_terminals.js touches: readyState,
// send, close, onmessage/onclose, and per-instance URL capture.
class WsStub {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    WsStub.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

function loadPanes(document, stateWs) {
  const ctx = {
    document,
    localStorage: {
      getItem: () => null,
      setItem() {},
    },
    TextEncoder,
    state: { ws: stateWs, tabs: [], allTabs: [], workspacePanes: {}, workspaces: [], panes: [] },
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
    newTab: async () => {},
    isEditorTab: null,
    isGitTab: null,
    TERMINAL_TAB_PLACEHOLDER: null,
    options: { terminalCore: "wterm", terminalFontSize: 14, terminalLinks: true },
    terminalTheme: () => ({}),
    terminalFontFamily: () => "monospace",
    currentSessionBackend: () => "",
    wsUrl: null,
    location: { protocol: "http:", host: "localhost:8787" },
    WebSocket: WsStub,
    HerdrTerminalRenderer: null,
    HerdrTerminalFit: { cellSize: () => ({ width: 9, height: 20 }) },
    HerdrAppHelpers: {
      stripTerminalMouseReports: (data) => data,
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const panesSource = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  vm.runInContext(panesSource, vm.createContext(ctx));
  const auxSource = readFileSync(new URL("./desktop/app_js/pane_terminals.js", import.meta.url), "utf8");
  vm.runInContext(auxSource, vm.createContext(ctx));
  return ctx;
}

function bootSplitWithTwoTerminals(ctx, renderer) {
  WsStub.instances.length = 0;
  ctx.HerdrTerminalRenderer = renderer;
  ctx.state.tabs = [{ tab_id: "tab_1", title: "one" }];
  ctx.state.tab = "tab_1";
  ctx.state.panes = [
    { tab_id: "tab_1", terminal_id: "term-aaa", focused: true, pane_id: "p1" },
  ];
  const panes = ctx.HerdrWorkspacePanes;
  // First render: the sync seeds tab_1 into the placeholder leaf.
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  // Second panel via the real placement path: mark the new pane as the
  // next home, then let the sync route the freshly landed tab_2 there
  // (exactly what the strip + button does through newTabForPane).
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.newTabForPane(leaves[1].paneId);
  ctx.state.tabs.push({ tab_id: "tab_2", title: "two" });
  ctx.state.panes.push({ tab_id: "tab_2", terminal_id: "term-bbb", focused: false, pane_id: "p2" });
  panes.renderWorkspacePanes();
  return panes;
}

function auxOf(ctx) {
  return ctx.document.querySelectorAll(".pane-terminal-aux");
}

// ---- aux surface mount -----------------------------------------------------

test("split sibling mounts its own aux terminal with own socket", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  // createSurface is async: the render pass kicked it off; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const auxNodes = auxOf(ctx);
  assert.equal(auxNodes.length, 1, "only the non-owner leaf hosts an aux surface");
  const aux = auxNodes[0];
  assert.equal(aux.dataset.tabId, "tab_2");
  assert.equal(renderer.created.length, 1, "one wterm instance for the aux surface");
  assert.equal(WsStub.instances.length, 1, "one dedicated attach socket");
  const ws = WsStub.instances[0];
  assert.ok(ws.url.includes("terminal_id=term-bbb"), "socket targets the sibling panel's pty");
  assert.ok(ws.url.includes("cols=") && ws.url.includes("rows="), "socket announces its grid");
  // The owner still hosts the singleton shell in its own slot.
  const shell = document.getElementById("terminalShell");
  assert.ok(shell.parentNode.className.split(/\s+/).includes("pane-content"), "owner slot hosts the shell");
});

test("re-render reuses the aux surface instead of recreating it", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.created.length, 1, "no second wterm instance");
  assert.equal(WsStub.instances.length, 1, "no second socket");
  assert.equal(ctx.HerdrPaneTerminals.count(), 1);
});

test("ws frames write into the term and onData routes back to the socket", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  ws.onmessage({ data: "hello pane" });
  assert.deepEqual(renderer.created[0].writes, ["hello pane"], "frames write straight through");
  ws.onmessage({ data: new Uint8Array([104, 105]) });
  assert.equal(renderer.created[0].writes[1].length, 2, "binary frames become byte views");
  const onData = renderer.created[0].opts.onData;
  onData("l\r");
  assert.equal(ws.sent.length, 1, "typing routes to this surface's socket");
  assert.deepEqual([...ws.sent[0]], [...new TextEncoder().encode("l\r")]);
});

test("herdr_error frame drops the socket and reuse rebuilds after backoff", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  // Controllable clock: pane_terminals reads Date.now() for the retry
  // backoff, and the vm context resolves Date from the sandbox unless
  // the ctx supplies one.
  let now = 1_000_000;
  class DateShim extends Date {
    static now() {
      return now;
    }
  }
  ctx.Date = DateShim;
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  ws.onmessage({ data: JSON.stringify({ type: "herdr_error", kind: "connect_failed", message: "down" }) });
  assert.equal(ws.closed, true, "error frame closes the aux socket");
  // First re-render inside the backoff window keeps the stale surface.
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.created.length, 1, "backoff window holds recreation");
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "entry survives the window");
  // Window elapses: the next render disposes the dead surface and
  // rebuilds with a fresh socket.
  now += 10_000;
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.created.length, 2, "aged-out dead surface rebuilds once");
  assert.equal(WsStub.instances.length, 2, "rebuild opens a fresh socket");
  assert.equal(renderer.created[0].disposed, true, "old instance disposed");
});

// ---- aux surface lifecycle --------------------------------------------

test("closing the aux leaf disposes its surface and socket", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  // Close the pane hosting the aux surface (closePaneFor promotes the
  // sibling, drops the leaf, and re-renders: releaseStale must dispose).
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.closePaneFor(leaves[1].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 0, "registry drops the closed tab");
  assert.equal(ws.closed, true, "socket closed with the surface");
  assert.equal(renderer.created[0].disposed, true, "wterm instance disposed");
  assert.equal(auxOf(ctx).length, 0, "container removed from the DOM");
});

test("promoting the aux tab to the shell owner disposes its aux surface", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Make the sibling's tab the routed tab: terminalShellOwnerLeaf keys
  // off state.tab, so tab_2's leaf becomes the owner and the primary
  // shell takes over the rendering. The old owner leaf now hosts aux.
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // tab_1's leaf is the non-owner now: exactly one aux exists, and it
  // targets tab_1's pty. tab_2's old aux (if the flip ran mid-flight)
  // disposes through releaseForTab on the owner branch.
  assert.equal(ctx.HerdrPaneTerminals.count(), 1);
  const aux = auxOf(ctx)[0];
  assert.equal(aux.dataset.tabId, "tab_1", "the demoted leaf now hosts the aux surface");
  // Flip back: the first aux goes away and tab_2's aux takes its place.
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx)[0].dataset.tabId, "tab_2", "flip re-creates the sibling aux");
  assert.equal(ctx.HerdrPaneTerminals.count(), 1);
});

test("maximized pane disposes the hidden sibling's aux surface", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.maximizePaneFor(leaves[0].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 0, "hidden sibling keeps no live socket");
  assert.equal(ws.closed, true, "socket closed on maximize");
  // Restore: the aux rebuilds for the visible sibling.
  panes.maximizePaneFor(leaves[0].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx).length, 1, "restore re-mounts the aux surface");
});

test("editor-active non-owner leaf releases its aux surface", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  // The sibling switches to an editor tab: its terminal aux must go.
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs = ["editor:src/main.py"];
  leaves[1].active = "editor:src/main.py";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 0, "editor tab released the aux");
  assert.equal(ws.closed, true, "socket closed with it");
  // Terminal tab back: the aux returns.
  leaves[1].tabs = ["tab_2"];
  leaves[1].active = "tab_2";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx).length, 1);
});

test("divider drag finish refits aux grids to the new slot size", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const term = renderer.created[0];
  const before = term.resized.length;
  // The drag handler lives on the divider node created by the render.
  const divider = ctx.document.querySelectorAll(".pane-divider")[0];
  assert.ok(divider, "split renders a divider");
  const down = divider.listeners.pointerdown[0];
  const move = divider.listeners.pointermove[0];
  const up = divider.listeners.pointerup[0];
  down({ button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
  move({ clientX: 220, clientY: 100 });
  up();
  assert.equal(term.resized.length, before + 1, "pointerup refit the aux grid");
});

// ---- no-workspace dashboard mount -------------------------------------

test("dashboard fills the pane slot when no workspace is open", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  panes.mountDashboardInPane(true);
  const dashboard = document.getElementById("projectDashboard");
  const pane = document.querySelectorAll(".workspace-pane")[0];
  assert.ok(pane, "mount creates the flat pane skeleton");
  assert.equal(
    dashboard.parentNode.className.split(/\s+/).includes("pane-content"),
    true,
    "dashboard lives in the pane content slot",
  );
  assert.equal(pane.querySelector(".pane-tab-strip").hidden, true, "empty strip hidden");
  // Hide: everything returns to the app.html home.
  panes.mountDashboardInPane(false);
  assert.equal(dashboard.parentNode, nodes.container, "dashboard parked home");
  assert.equal(document.querySelectorAll(".pane-tab-strip")[0].hidden, false, "strip restored");
});

test("dashboard mount reuses an existing pane and survives layout sweep", () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  // A prior render pass may have built the flat pane already.
  panes.renderWorkspacePanes();
  panes.mountDashboardInPane(true);
  const dashboard = document.getElementById("projectDashboard");
  const panesBefore = document.querySelectorAll(".workspace-pane").length;
  assert.equal(panesBefore, 1, "no duplicate pane created");
  // The sweep must not drop the dashboard-hosting pane (live paneId).
  panes.renderWorkspacePanes();
  assert.equal(
    dashboard.parentNode.className.split(/\s+/).includes("pane-content"),
    true,
    "dashboard still mounted after the render sweep",
  );
});

// The live bug the deployed build showed: with no workspace the render
// pass runs syncProjectDashboard (show) then syncWorkspaceEmptyLeaf
// (hide), and the empty-leaf hide branch restored the strip the
// dashboard mount had just hidden. Plus the placeholder leaf claimed
// the terminal shell and stacked it dead under the dashboard. These
// tests replay the full render sequence, not one mount in isolation.
test("empty state: dashboard owns the pane across the full render sequence", () => {
  const { document, nodes } = buildDom();
  // The zero-tab card node, same home as app.html gives it.
  const emptyLeaf = makeNode("workspaceEmptyLeaf", "workspace-empty-leaf");
  nodes.container.appendChild(emptyLeaf);
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");
  const shell = nodes.terminalShell;
  // One full render pass: panes render first, then the same sync order
  // render() uses (dashboard show, then empty-leaf hide).
  panes.renderWorkspacePanes();
  dashboard.hidden = false;
  emptyLeaf.hidden = true;
  panes.mountDashboardInPane(true);
  panes.mountEmptyLeafInPane(false);
  const strip = document.querySelectorAll(".pane-tab-strip")[0];
  assert.equal(strip.hidden, true, "strip stays hidden while the dashboard owns the pane");
  // The shell parks home, hidden: no dead chrome shares the column.
  assert.equal(shell.parentNode, nodes.container, "shell parked at #workspacePanes home");
  assert.equal(shell.style.display, "none", "shell hidden while the dashboard shows");
  // A second full render pass (events poll) keeps the contract: the
  // placeholder leaf must not re-host or re-show the shell.
  panes.renderWorkspacePanes();
  assert.equal(shell.parentNode, nodes.container, "shell stays parked after re-render");
  assert.equal(shell.style.display, "none", "shell stays hidden after re-render");
  assert.equal(
    dashboard.parentNode.className.split(/\s+/).includes("pane-content"),
    true,
    "dashboard stays in the pane content slot",
  );
  assert.equal(document.querySelectorAll(".pane-tab-strip")[0].hidden, true, "strip stays hidden after re-render");
});

test("empty-leaf hide keeps dashboard strips hidden; dashboard hide keeps empty-leaf strips hidden", () => {
  const { document, nodes } = buildDom();
  // The zero-tab workspace card node, same home as app.html.
  const emptyLeaf = makeNode("workspaceEmptyLeaf", "workspace-empty-leaf");
  nodes.container.appendChild(emptyLeaf);
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");
  const strip = () => document.querySelectorAll(".pane-tab-strip")[0];

  // Dashboard owns, empty-leaf hide pass runs: strips must stay hidden.
  dashboard.hidden = false;
  panes.mountDashboardInPane(true);
  panes.mountEmptyLeafInPane(false);
  assert.equal(strip().hidden, true, "empty-leaf hide does not clobber the dashboard's strips");
  // The card went home.
  assert.equal(emptyLeaf.parentNode, nodes.container, "empty leaf parked home");

  // Now the empty leaf owns (zero-tab workspace): dashboard hide pass
  // must not clobber its strips either.
  dashboard.hidden = true;
  emptyLeaf.hidden = false;
  panes.mountDashboardInPane(false);
  assert.equal(strip().hidden, false, "dashboard hide does not clobber the empty-leaf's strips");
});

// The split + no-workspace case: the dashboard owns the whole pane area,
// so a split layout left over from an earlier session must not keep
// strips floating over dead sibling panes. Every strip hides while the
// dashboard shows, and the hide pass restores them all.
test("dashboard takeover hides every strip in a split layout", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");
  // Build a split: render once so p1 exists, then split it.
  panes.renderWorkspacePanes();
  assert.equal(panes.splitPaneRightFor("p1"), true, "split builds a second leaf");
  assert.equal(document.querySelectorAll(".pane-tab-strip").length, 2, "two strips in the split");
  // Full render order: panes first, then the dashboard show pass.
  panes.renderWorkspacePanes();
  dashboard.hidden = false;
  panes.mountDashboardInPane(true);
  const strips = document.querySelectorAll(".pane-tab-strip");
  assert.equal(strips.length, 2, "split kept both strips");
  assert.equal(strips[0].hidden, true, "owner leaf strip hidden");
  assert.equal(strips[1].hidden, true, "sibling leaf strip hidden too");
  // Hide pass restores every strip for the next render.
  dashboard.hidden = true;
  panes.mountDashboardInPane(false);
  assert.equal(strips[0].hidden, false, "owner strip restored");
  assert.equal(strips[1].hidden, false, "sibling strip restored");
});

// ---- theme fan-out --------------------------------------------------------

test("applyThemeAll re-themes open aux surfaces on theme switch", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const aux = ctx.HerdrPaneTerminals;
  assert.equal(aux.count(), 1, "one aux surface open");
  const term = renderer.created[0];
  assert.equal(term.themes.length, 0, "no re-theme before the switch");
  const light = { background: "#fff" };
  ctx.terminalTheme = () => light;
  aux.applyThemeAll();
  assert.equal(term.themes.length, 1, "aux term re-themed");
  assert.deepEqual(term.themes[0], light, "theme payload is the current palette");
});
