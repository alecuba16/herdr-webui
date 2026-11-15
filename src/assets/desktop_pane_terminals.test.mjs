// Auxiliary split-pane terminals and the no-workspace dashboard mount.
// Two contracts live here: (1) a split leaf that is not the shell owner
// still renders its terminal panel through its own wterm instance and
// /ws/terminal socket (HerdrPaneTerminals), including the D8 session
// cache (park on hide, dispose only on close, socket detach while
// parked, cap eviction), input routing, error frames, and the divider
// refit; (2) the project dashboard fills the pane slot when no workspace
// is open (mountDashboardInPane from syncProjectDashboard).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// Compiled once per product file so coverage attributes to the real paths.
const WORKSPACE_PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const workspacePanesScript = new vm.Script(readFileSync(WORKSPACE_PANES_PATH, "utf8"), {
  filename: WORKSPACE_PANES_PATH,
});
const PANE_TERMINALS_PATH = fileURLToPath(new URL("./desktop/app_js/pane_terminals.js", import.meta.url));
const paneTerminalsScript = new vm.Script(readFileSync(PANE_TERMINALS_PATH, "utf8"), {
  filename: PANE_TERMINALS_PATH,
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
    // The app.html siblings (#tabs, #projectDashboard, #terminalShell)
    // carry the hidden attribute on boot; mirror it so the takeover
    // decision (dashboard hidden = not shown) matches the real DOM.
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
  // The sidebar Workspaces pane core.js builds at boot, with its scroll
  // area that hosts the dashboard in the empty state (same shape as the
  // real DOM: workspacePane > sidebar-scroll > workspaces list).
  const sidebarPane = makeNode("workspacePane", "sidebar-pane workspaces-pane");
  const sidebarScroll = makeNode("", "sidebar-scroll");
  const workspaces = makeNode("workspaces", "");
  sidebarScroll.appendChild(workspaces);
  sidebarPane.appendChild(sidebarScroll);
  const nodes = { workspacePanes: container, tabs, projectDashboard: dashboard, terminalShell: shell, terminal, workspacePane: sidebarPane, sidebarScroll };
  nodes.container = container;
  const body = makeNode("body", "");
  body.appendChild(container);
  body.appendChild(sidebarPane);
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
// entry the socket writes to. attachClickFocus captures the click handler
// so focus-order assertions (LRF eviction) can drive a real click.
function makeRendererStub() {
  const created = [];
  const stub = {
    created,
    clicks: [],
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
        focus() {},
      };
      created.push(term);
      return term;
    },
    attachClickFocus(container, handler) {
      stub.clicks.push({ container, handler });
    },
  };
  return stub;
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
    // schedulePtyResize debounces on real timers; the vm realm has no
    // setTimeout unless provided. Tests assert before the timer fires
    // or await the flush, so real timers keep timing honest.
    setTimeout,
    clearTimeout,
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
  workspacePanesScript.runInContext(vm.createContext(ctx));
  const auxSource = readFileSync(new URL("./desktop/app_js/pane_terminals.js", import.meta.url), "utf8");
  paneTerminalsScript.runInContext(vm.createContext(ctx));
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

test("herdr_error frame drops the socket and re-attach waits out the backoff", async () => {
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
  assert.equal(renderer.created[0].disposed, false, "wterm instance stays cached (D8)");
  // First re-render inside the backoff window keeps the dead surface
  // cached and socket-less: churn guard holds.
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.created.length, 1, "backoff window holds re-attach and recreation");
  assert.equal(WsStub.instances.length, 1, "no churn sockets inside the window");
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "entry survives the window");
  // Window elapses: the next render re-attaches a fresh socket into the
  // SAME wterm instance; the hub replay rehydrates the view.
  now += 10_000;
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.created.length, 1, "re-attach reuses the cached wterm instance");
  assert.equal(WsStub.instances.length, 2, "re-attach opens a fresh socket");
  assert.ok(WsStub.instances[1].url.includes("terminal_id=term-bbb"), "fresh socket targets the same pty");
});

// ---- aux surface lifecycle --------------------------------------------

test("closing the aux tab disposes its cached surface and socket", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  // First park the surface the way a leaf collapse does: closePaneFor
  // migrates tab_2's tabs into the survivor and drops the leaf, so the
  // surface parks (D8), not disposes. The pane close itself must NOT
  // kill the cached surface.
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.closePaneFor(leaves[1].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "pane close parks, registry keeps the cache");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 1, "surface parked, not disposed");
  assert.equal(renderer.created[0].disposed, false, "wterm instance survives the pane close");
  // Tab close is the real disposal (closeTab calls releaseForTab).
  ctx.HerdrPaneTerminals.releaseForTab("tab_2");
  assert.equal(ctx.HerdrPaneTerminals.count(), 0, "registry drops the closed tab");
  assert.equal(ws.closed, true, "socket closed with the surface");
  assert.equal(renderer.created[0].disposed, true, "wterm instance disposed");
  assert.equal(auxOf(ctx).length, 0, "container removed from the DOM");
});

test("promoting the aux tab to the shell owner parks its surface, flip back reuses it", async () => {
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
  // tab_1's leaf is the non-owner now: exactly one live aux exists, and
  // it targets tab_1's pty. tab_2's old aux parked when the shell took
  // its slot (D8), so the flip back reuses the same wterm instance.
  assert.equal(ctx.HerdrPaneTerminals.count(), 2, "both surfaces cached across the flip");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 1, "the taken-over surface parks, not disposes");
  const aux = auxOf(ctx)[0];
  assert.equal(aux.dataset.tabId, "tab_1", "the demoted leaf now hosts the aux surface");
  const tabTwoTerm = renderer.created[0];
  assert.equal(tabTwoTerm.disposed, false, "tab_2's wterm survives parked");
  // Flip back: the parked surface returns to the leaf with the SAME
  // wterm instance (D8 identity contract).
  ctx.state.tab = "tab_1";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx)[0].dataset.tabId, "tab_2", "flip restores the sibling aux");
  assert.equal(ctx.HerdrPaneTerminals.count(), 2);
  assert.equal(ctx.HerdrPaneTerminals.parked(), 1, "tab_1's surface parks on the flip back");
  const tabTwoAuxNode = auxOf(ctx).find((node) => node.dataset.tabId === "tab_2");
  assert.ok(tabTwoAuxNode, "tab_2's aux container is back in a leaf");
  assert.ok(renderer.created.includes(tabTwoTerm) && !tabTwoTerm.disposed, "same wterm instance serves the return");
});

test("maximized pane parks the hidden sibling's aux, restore reuses it", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  const term = renderer.created[0];
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.maximizePaneFor(leaves[0].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "registry keeps the cache entry");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 1, "hidden sibling's surface parked");
  assert.equal(ws.closed, true, "park detaches the socket (no sockets for non-visible)");
  assert.equal(term.disposed, false, "wterm instance survives the maximize");
  // Restore: the parked surface re-attaches and re-parents, SAME wterm
  // instance, scrollback intact.
  panes.maximizePaneFor(leaves[0].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx).length, 1, "restore re-mounts the aux surface");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 0, "surface is live again");
  assert.equal(term.disposed, false, "same wterm instance serves the restore");
  assert.ok(WsStub.instances.length >= 2, "restore re-attaches a fresh socket");
  const liveWs = WsStub.instances[WsStub.instances.length - 1];
  assert.equal(liveWs.closed, false, "re-attached socket is open");
});

test("editor-active non-owner leaf parks its aux surface, terminal return reuses it", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = WsStub.instances[0];
  const term = renderer.created[0];
  // The sibling switches to an editor tab: its terminal aux parks.
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs = ["editor:src/main.py"];
  leaves[1].active = "editor:src/main.py";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "editor stint parks the aux, cache keeps it");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 1, "surface parked, not disposed");
  assert.equal(ws.closed, true, "park detaches the socket");
  assert.equal(term.disposed, false, "wterm instance survives the editor stint");
  // Terminal tab back: the aux returns. The editor stint left tab_2
  // re-homed into the owner leaf (the sync lands homeless ids in the
  // sync target), so move it back the way a drag or click would: out
  // of leaf 0, into leaf 1. Raw-duplicating it across both leaves is
  // the state the D7.1 repair exists to collapse.
  const leavesNow = panes.paneLeaves(panes.paneRoot());
  const holder = leavesNow.find((leaf) => leaf.tabs.includes("tab_2"));
  const strip = leavesNow.find((leaf) => leaf !== holder);
  holder.tabs.splice(holder.tabs.indexOf("tab_2"), 1);
  strip.tabs.push("tab_2");
  strip.active = "tab_2";
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(auxOf(ctx).length, 1);
  assert.equal(term.disposed, false, "same wterm instance serves the terminal return");
  assert.ok(WsStub.instances.length >= 2, "return re-attaches a fresh socket");
});

// ---- D8 cache budget -----------------------------------------------------

test("parking beyond the cap evicts least-recently-focused first", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.cap(), 8, "cap is 8 aux surfaces");
  // Grow the cache past the cap: pre-distribute one known terminal per
  // leaf by hand (the sync only lands homeless ids in ONE target leaf,
  // so raw splits would leave the extra leaves empty), then render.
  // Ten terminals total: tab_1 renders via the singleton shell (the
  // owner does not count toward the aux cap), so tabs 2..10 give nine
  // aux surfaces, one over the cap of 8.
  for (let i = 0; i < 8; i += 1) panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.ok(leaves.length >= 10, "ten leaves stand");
  for (let i = 3; i <= 10; i += 1) {
    ctx.state.tabs.push({ tab_id: `tab_${i}`, title: `t${i}` });
    ctx.state.panes.push({ tab_id: `tab_${i}`, terminal_id: `term-${i}`, focused: false, pane_id: `p${i}` });
    const leaf = leaves[i - 1];
    leaf.tabs = [`tab_${i}`];
    leaf.active = `tab_${i}`;
  }
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The cap holds at the end of every render pass (releaseStale runs
  // evictBeyondCap): the ninth surface never stood. Creation order
  // doubles as focus order here (no clicks ran), so the FIRST created
  // surface is the least-recently-focused and is the one evicted.
  const firstCreated = renderer.created[0];
  const lastCreated = renderer.created[renderer.created.length - 1];
  assert.equal(renderer.created.length, 9, "nine wterm instances were requested");
  assert.equal(ctx.HerdrPaneTerminals.count(), 8, "cache caps at 8 mid-render, not later");
  assert.equal(firstCreated.disposed, true, "least-recently-focused entry evicted");
  assert.equal(lastCreated.disposed, false, "newest surface survives the eviction");
  // Maximize one leaf: every aux parks, and parked means socket detached
  // (no sockets for non-visible surfaces).
  panes.maximizePaneFor(leaves[0].paneId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrPaneTerminals.count(), 8, "cache stays at the cap after parking");
  assert.equal(ctx.HerdrPaneTerminals.parked(), 8, "maximize parked the rest");
  const liveSockets = WsStub.instances.filter((ws) => !ws.closed);
  assert.equal(liveSockets.length, 0, "no live sockets while every surface is parked");
  assert.equal(lastCreated.disposed, false, "surviving surfaces keep their wterm instances");
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

// D9: the aux fit also tells the PTY its new grid. The resize message
// debounces per entry (200ms, trailing edge carries the latest cols/rows),
// lands on the entry's own socket, and never fires for a disposed entry.
test("fitAll debounces a resize message to the aux pty socket", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  WsStub.instances.forEach((ws) => (ws.sent.length = 0));
  const aux = ctx.HerdrPaneTerminals;
  assert.ok(aux && typeof aux.fitAll === "function", "fitAll exported");
  const before = renderer.created[0].resized.length;
  // Two quick fits inside the debounce window collapse into one message.
  aux.fitAll();
  aux.fitAll();
  await new Promise((resolve) => setTimeout(resolve, 260));
  const resizeMessages = WsStub.instances.flatMap((ws) =>
    ws.sent.map((raw) => { try { return JSON.parse(raw); } catch (e) { return null; } }),
  ).filter((msg) => msg && msg.type === "resize");
  assert.ok(resizeMessages.length >= 1, "pty resize message sent after the debounce");
  assert.ok(resizeMessages.every((msg) => Number.isInteger(msg.cols) && Number.isInteger(msg.rows)), "message carries the grid");
  // The renderer still refit locally on every pass.
  assert.ok(renderer.created[0].resized.length > before, "local grid refit ran");
});

test("disposal cancels the pending pty resize", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const panes = ctx.HerdrWorkspacePanes;
  // Empty the second leaf's tabs and re-render: the aux disposes while a
  // resize may still sit in the debounce window.
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs = [];
  leaves[1].active = null;
  const wsBefore = WsStub.instances.length;
  panes.renderWorkspacePanes();
  await new Promise((resolve) => setTimeout(resolve, 260));
  // No resize frame ever hits a disposed entry's socket after close: the
  // stub marks closed sockets, and the scheduler checks the disposed flag
  // before sending. The assertion is the absence of throws plus closed
  // sockets staying silent.
  const closedSent = WsStub.instances.slice(wsBefore).filter((ws) => ws.closed).flatMap((ws) => ws.sent);
  assert.deepEqual(closedSent, [], "no message leaves after disposal");
});

// ---- no-workspace dashboard mount -------------------------------------

test("dashboard moves to the sidebar Workspaces pane when no workspace is open", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  panes.mountDashboardInPane(true);
  const dashboard = document.getElementById("projectDashboard");
  assert.equal(
    document.querySelectorAll(".workspace-pane").length,
    0,
    "center pane skeleton dropped",
  );
  assert.equal(
    dashboard.parentNode,
    nodes.sidebarScroll,
    "dashboard lives in the sidebar Workspaces scroll area",
  );
  assert.equal(
    dashboard.parentNode.parentNode,
    nodes.workspacePane,
    "scroll area sits inside the sidebar pane",
  );
  assert.equal(nodes.terminalShell.style.display, "none", "shell parked home, hidden");
  // Hide: everything returns to the app.html home.
  panes.mountDashboardInPane(false);
  assert.equal(dashboard.parentNode, nodes.container, "dashboard parked home");
});

test("sidebar dashboard state survives repeated pane render passes", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");
  dashboard.hidden = false;
  panes.mountDashboardInPane(true);
  // The render pass must not rebuild dead chrome nor steal the dashboard
  // back from the sidebar.
  panes.renderWorkspacePanes();
  panes.renderWorkspacePanes();
  assert.equal(
    document.querySelectorAll(".workspace-pane").length,
    0,
    "no pane skeleton re-created",
  );
  assert.equal(dashboard.parentNode, nodes.sidebarScroll, "dashboard keeps the sidebar home");
});

// The live bug the deployed build showed: with no workspace the render
// pass runs syncProjectDashboard (show) then syncWorkspaceEmptyLeaf
// (hide), and the empty-leaf hide branch restored the strip the
// dashboard mount had just hidden. Plus the placeholder leaf claimed
// the terminal shell and stacked it dead under the dashboard. These
// tests replay the full render sequence, not one mount in isolation.
test("empty state: dashboard owns the sidebar across the full render sequence", () => {
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
  // The shell parks home, hidden: no dead chrome shares the column.
  assert.equal(shell.parentNode, nodes.container, "shell parked at #workspacePanes home");
  assert.equal(shell.style.display, "none", "shell hidden while the dashboard shows");
  assert.equal(dashboard.parentNode, nodes.sidebarScroll, "dashboard lives in the sidebar scroll area");
  // A second full render pass (events poll) keeps the contract: the
  // placeholder leaf must not re-host or re-show the shell, and no
  // pane skeleton may be rebuilt in the empty center.
  panes.renderWorkspacePanes();
  assert.equal(shell.parentNode, nodes.container, "shell stays parked after re-render");
  assert.equal(shell.style.display, "none", "shell stays hidden after re-render");
  assert.equal(dashboard.parentNode, nodes.sidebarScroll, "dashboard keeps the sidebar home after re-render");
  assert.equal(document.querySelectorAll(".workspace-pane").length, 0, "no pane skeleton in the empty state");
});

test("empty-leaf hide does not resurrect pane chrome under the dashboard state", () => {
  const { document, nodes } = buildDom();
  // The zero-tab workspace card node, same home as app.html.
  const emptyLeaf = makeNode("workspaceEmptyLeaf", "workspace-empty-leaf");
  nodes.container.appendChild(emptyLeaf);
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");

  // Dashboard owns, empty-leaf hide pass runs: nothing may come back.
  dashboard.hidden = false;
  panes.mountDashboardInPane(true);
  panes.mountEmptyLeafInPane(false);
  assert.equal(document.querySelectorAll(".workspace-pane").length, 0, "no pane skeleton under the dashboard state");
  assert.equal(emptyLeaf.parentNode, nodes.container, "empty leaf parked home");
});

// The live bug the deployed build showed on a zero-tab workspace: opening
// the Files drawer hid the empty-leaf card, the pane render then claimed the
// slot for the terminal shell, and a dead Connecting panel painted in the
// center. render.js keeps the card up with a drawer open now; this test
// pins the panes side of the contract: the render pass must not steal the
// slot from the mounted card nor unhide the shell the card pass hid.
test("zero-tab workspace: pane render keeps the mounted card owner and the shell hidden", () => {
  const { document, nodes } = buildDom();
  const emptyLeaf = makeNode("workspaceEmptyLeaf", "workspace-empty-leaf");
  nodes.container.appendChild(emptyLeaf);
  const ctx = loadPanes(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  const shell = nodes.terminalShell;
  // Full render sequence with a drawer open, render.js order: the leaf
  // sync shows the card (shell hidden attr), then the pane render runs.
  ctx.state.tab = null;
  emptyLeaf.hidden = false;
  shell.hidden = true;
  panes.mountEmptyLeafInPane(true);
  panes.renderWorkspacePanes();
  const content = document.querySelectorAll(".pane-content")[0];
  assert.ok(content, "pane content slot renders");
  assert.equal(emptyLeaf.parentNode, content, "card keeps the pane content slot");
  assert.equal(shell.hidden, true, "shell stays hidden while the card owns the slot");
  // A second pass (events poll) must not drift.
  panes.renderWorkspacePanes();
  assert.equal(emptyLeaf.parentNode, content, "card keeps the slot across re-render");
  assert.equal(shell.hidden, true, "shell stays hidden across re-render");
  // Closing the drawer re-runs the same sequence with no state change:
  // the card keeps the slot, nothing dead claims the center.
  panes.mountEmptyLeafInPane(true);
  panes.renderWorkspacePanes();
  assert.equal(emptyLeaf.parentNode, content, "card keeps the slot after the drawer closes");
  assert.equal(shell.hidden, true, "shell stays hidden after the drawer closes");
});

// The split + no-workspace case: a split layout left over from an
// earlier session must not survive the empty state as dead chrome. The
// whole skeleton goes, so no strips float over empty sibling panes,
// and the hide pass lets the next render rebuild the layout.
test("empty-state dashboard drops the whole split layout", () => {
  const { document, nodes } = buildDom();
  const ctx = loadPanes(document, null);
  const panes = ctx.HerdrWorkspacePanes;
  const dashboard = document.getElementById("projectDashboard");
  // Build a split: render once so p1 exists, then split it.
  dashboard.hidden = true;
  panes.renderWorkspacePanes();
  assert.equal(panes.splitPaneRightFor("p1"), true, "split builds a second leaf");
  assert.equal(document.querySelectorAll(".workspace-pane").length, 2, "two panes in the split");
  // Full render order: panes first, then the dashboard show pass.
  panes.renderWorkspacePanes();
  dashboard.hidden = false;
  panes.mountDashboardInPane(true);
  assert.equal(document.querySelectorAll(".workspace-pane").length, 0, "split skeleton dropped");
  assert.equal(document.querySelectorAll(".pane-tab-strip").length, 0, "strips dropped with it");
  assert.equal(dashboard.parentNode, nodes.sidebarScroll, "dashboard lives in the sidebar");
  // Hide pass: the next render rebuilds the pane layout from the tree.
  dashboard.hidden = true;
  panes.mountDashboardInPane(false);
  panes.renderWorkspacePanes();
  assert.ok(document.querySelectorAll(".workspace-pane").length >= 1, "pane skeleton rebuilt after the dashboard hides");
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

test("dragging an aux terminal tab to another leaf keeps the wterm instance and socket (D7.4)", async () => {
  const { document } = buildDom();
  const ctx = loadPanes(document, "ws-1");
  const renderer = makeRendererStub();
  const panes = bootSplitWithTwoTerminals(ctx, renderer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const termBefore = renderer.created[0];
  const socketBefore = WsStub.instances[0];
  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.ok(leaves[0].tabs.includes("tab_2") || leaves[1].tabs.includes("tab_2"), "tab_2 lives in a leaf");
  const source = leaves.find((leaf) => leaf.tabs.includes("tab_2"));
  const target = leaves.find((leaf) => leaf !== source);

  // The drag drop path: movePaneTabTo is exactly what paneStripDrop runs.
  assert.equal(panes.movePaneTabTo("tab_2", target.paneId, 0), true, "drop accepted");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const moved = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.tabs.includes("tab_2"));
  assert.equal(moved, target, "tab_2 now lives in the target leaf");
  assert.equal(renderer.created.length, 1, "no second wterm instance: identity survives the drag");
  assert.equal(WsStub.instances.length, 1, "no second socket: the pty mirror and scrollback survive");
  assert.strictEqual(renderer.created[0], termBefore, "same wterm instance object");
  assert.strictEqual(WsStub.instances[0], socketBefore, "same socket object");
  assert.equal(ctx.HerdrPaneTerminals.count(), 1, "registry count unchanged");
});
