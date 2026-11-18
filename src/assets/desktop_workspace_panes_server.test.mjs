// Server-owned panes coverage for workspace_panes.js: the op layer
// (panesServerOp adopt/retry/fallback), boot adoption (GET wins, 404
// seeds through apply, transport failure stays local), broadcast
// adoption with the signature guard, and the panel rename flow on the
// rail chips. The harness mirrors desktop_workspace_panes_split.test.mjs
// (vm realm, node DOM stubs) with a scripted api() that records ops and
// returns canned entries.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const WORKSPACE_PANES_PATH = fileURLToPath(new URL("./desktop/app_js/workspace_panes.js", import.meta.url));
const workspacePanesScript = new vm.Script(readFileSync(WORKSPACE_PANES_PATH, "utf8"), {
  filename: WORKSPACE_PANES_PATH,
});

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
        for (const child of n.children || []) {
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
        for (const child of n.children || []) {
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
        toggle(name, on) {
          const has = self.className.split(/\s+/).includes(name);
          if (on === undefined) on = !has;
          if (on && !has) this.add(name);
          if (!on && has) this.remove(name);
        },
      };
    },
  };
  // The renderer assigns node.innerHTML; capture it so assertions read
  // __innerHTML (same contract as the split harness).
  Object.defineProperty(node, "innerHTML", {
    get() {
      return node.__innerHTML;
    },
    set(value) {
      node.__innerHTML = String(value);
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
    querySelector: () => null,
    querySelectorAll: (selector) => {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const found = [];
      const walk = (n) => {
        for (const child of n.children || []) {
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

// Scripted server. The panes module calls api(url, opt); the script
// records every op and answers from a tiny in-memory entry so adoption
// paths run against realistic server responses.
function makeServerApi(startingEntry) {
  const calls = [];
  let entry = startingEntry
    ? JSON.parse(JSON.stringify(startingEntry))
    : { v: 3, panels: [], groups: [], visible: { type: "panel", id: "" }, at: 1 };
  const script = {
    calls,
    get entry() {
      return entry;
    },
    set entry(next) {
      entry = JSON.parse(JSON.stringify(next));
    },
    // Apply one canned mutation so the op response differs from the
    // local entry (the adoption must visibly win).
    applyServerOp(op) {
      if (op.op === "group.rename") {
        const group = entry.groups.find((g) => g.groupId === op.groupId);
        if (group) group.name = op.name || null;
      } else if (op.op === "panel.rename") {
        const panel = entry.panels.find((p) => p.paneId === op.paneId);
        if (panel) panel.name = op.name || null;
      } else if (op.op === "group.ungroup") {
        const panel = entry.panels.find((p) => p.paneId === op.paneId);
        if (panel && panel.groupId) {
          const groupId = panel.groupId;
          panel.groupId = null;
          const group = entry.groups.find((g) => g.groupId === groupId);
          if (group) {
            group.memberIds = group.memberIds.filter((id) => id !== op.paneId);
            if (group.memberIds.length < 2) {
              for (const id of group.memberIds) {
                const member = entry.panels.find((p) => p.paneId === id);
                if (member) member.groupId = null;
              }
              entry.groups = entry.groups.filter((g) => g.groupId !== groupId);
            }
          }
        }
      } else if (op.op === "panel.create") {
        const paneId = `p${entry.panels.length + 1}`;
        entry.panels.push({ kind: "pane", paneId, tabs: [], active: null, wsId: op.wsId || null, groupId: null, name: null });
      } else if (op.op === "panel.close") {
        entry.panels = entry.panels.filter((p) => p.paneId !== op.paneId);
      } else if (op.op === "subject.set") {
        entry.visible = { type: op.visible.type, id: op.visible.id };
      }
      return { ...entry, session: "work" };
    },
  };
  const api = async (url, opt) => {
    calls.push({ url, opt });
    if (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET")) {
      return { ...entry, session: "work" };
    }
    if (url === "/api/workspace-panes" && opt && opt.method === "POST") {
      const body = JSON.parse(opt.body);
      entry = body.entry;
      return { ...entry, session: "work" };
    }
    if (url === "/api/workspace-panes/op") {
      const op = JSON.parse(opt.body);
      return script.applyServerOp(op);
    }
    throw Error(`unexpected url ${url}`);
  };
  script.api = api;
  return script;
}

function loadPanesModule(document, stateWs, scriptApi) {
  const storage = {};
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
    setTimeout: (fn) => {},
    go: () => {},
    api: scriptApi,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  workspacePanesScript.runInContext(vm.createContext(ctx));
  ctx.__storage = storage;
  return ctx;
}

function serverEntry() {
  return {
    v: 3,
    panels: [
      { kind: "pane", paneId: "p1", tabs: ["t1"], active: "t1", wsId: "ws-1", groupId: null, name: null },
      { kind: "pane", paneId: "p2", tabs: ["t2"], active: "t2", wsId: "ws-1", groupId: null, name: null },
    ],
    groups: [],
    visible: { type: "panel", id: "p2" },
    at: 5,
  };
}

test("boot adopts the server entry and switches to server mode", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels.length, 2);
  assert.equal(entry.panels[0].paneId, "p1");
  // Server visible adopted when the local pointer has no live subject.
  assert.equal(entry.visible.id, "p2");
  // The rail renders both server panels.
  const rail = nodes.container.querySelector(".pane-label-rail");
  assert.ok(rail, "rail renders for two panels");
  assert.ok(rail.__innerHTML.includes("data-pane-id=\"p1\""), "p1 chip present");
  assert.ok(rail.__innerHTML.includes("data-pane-id=\"p2\""), "p2 chip present");
});

test("panel rename flows through the server op", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const enc = encodeURIComponent("p1");
  ctx.HerdrWorkspacePanes.startPanelChipRename(enc);
  ctx.state.editingPanelValue = "my panel";
  ctx.HerdrWorkspacePanes.commitPanelChipRename(enc);
  const renameCall = script.calls.find((c) => c.url === "/api/workspace-panes/op" && JSON.parse(c.opt.body).op === "panel.rename");
  assert.ok(renameCall, "rename op posted");
  const op = JSON.parse(renameCall.opt.body);
  assert.equal(op.op, "panel.rename");
  assert.equal(op.paneId, "p1");
  assert.equal(op.name, "my panel");
  // The server response carried the name; adoption applied it.
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels[0].name, "my panel");
  // The rail chip shows the server name.
  const rail = nodes.container.querySelector(".pane-label-rail");
  assert.ok(rail.__innerHTML.includes("my panel"), "chip shows the server name");
  // Editing state cleared.
  assert.equal(ctx.state.editingPanelPaneId, null);
});

test("panel rename empty commit clears the name through the op", async () => {
  const { document } = buildDom();
  const starting = serverEntry();
  starting.panels[0].name = "old name";
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const enc = encodeURIComponent("p1");
  ctx.HerdrWorkspacePanes.startPanelChipRename(enc);
  ctx.state.editingPanelValue = "   ";
  ctx.HerdrWorkspacePanes.commitPanelChipRename(enc);
  const renameCall = script.calls.find((c) => c.url === "/api/workspace-panes/op" && JSON.parse(c.opt.body).op === "panel.rename");
  assert.ok(renameCall, "rename op posted");
  const op = JSON.parse(renameCall.opt.body);
  assert.equal(op.name, null, "empty commit sends null (clears server-side)");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().panels[0].name, null);
});

test("rail chip renders the rename affordance on double-click", () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  // Two panels adopted from the server so the rail renders (a single
  // panel session paints no rail by design).
  ctx.HerdrWorkspacePanes.adoptServerEntry(serverEntry(), { keepLocalVisible: true });
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  const rail = nodes.container.querySelector(".pane-label-rail");
  assert.ok(rail, "rail renders for two panels");
  assert.ok(rail.__innerHTML.includes("startPanelChipRename"), "panel chip wires the rename");
  assert.ok(rail.__innerHTML.includes("ondblclick"), "double-click affordance wired");
  // Editing swap: state drives the input instead of the button.
  ctx.state.editingPanelPaneId = "p1";
  ctx.state.editingPanelValue = "draft";
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  const rail2 = nodes.container.querySelector(".pane-label-rail");
  assert.ok(rail2.__innerHTML.includes("pane-group-rename-input"), "editing swaps in the input");
  assert.ok(rail2.__innerHTML.includes("commitPanelChipRename"), "the editing input commits on blur");
  assert.ok(rail2.__innerHTML.includes("panelChipRenameKey"), "the editing input wires the keys");
  assert.ok(!rail2.__innerHTML.includes("startPanelChipRename('p1')"), "the edited chip swaps out");
  assert.ok(rail2.__innerHTML.includes("startPanelChipRename('p2')"), "the other chip keeps its affordance");
});

test("broadcast frame adopts the entry through applyRemoteEntry", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // A second client grouped p1 with a new p3; the local pointer (p2)
  // names an ungrouped panel and must survive the broadcast adoption.
  const remote = serverEntry();
  remote.panels.push({ kind: "pane", paneId: "p3", tabs: [], active: null, wsId: "ws-1", groupId: "g1", name: null });
  remote.groups = [
    { groupId: "g1", name: "duo", memberIds: ["p1", "p3"], layout: { kind: "row", sizes: [1, 1], children: ["p1", "p3"] } },
  ];
  remote.panels[0].groupId = "g1";
  remote.visible = { type: "group", id: "g1" };
  const adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(remote);
  assert.equal(adopted, true);
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.groups.length, 1);
  assert.equal(entry.groups[0].name, "duo");
  assert.equal(entry.panels.length, 3, "the new server panel adopted");
  // The local visible pointer (panel p2, still ungrouped) survives.
  assert.equal(entry.visible.type, "panel");
  assert.equal(entry.visible.id, "p2");
});

test("broadcast subject heals to the group when the local panel got grouped", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // The local subject p2 becomes a group member on the server: a grouped
  // panel cannot stand alone, so the subject heals to the group.
  const remote = serverEntry();
  remote.groups = [
    { groupId: "g1", name: "pair", memberIds: ["p1", "p2"], layout: { kind: "row", sizes: [1, 1], children: ["p1", "p2"] } },
  ];
  remote.panels[0].groupId = "g1";
  remote.panels[1].groupId = "g1";
  remote.visible = { type: "group", id: "g1" };
  const adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(remote);
  assert.equal(adopted, true);
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.visible.type, "group");
  assert.equal(entry.visible.id, "g1");
});

test("broadcast frame equal to the live entry is a no-op", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const same = ctx.HerdrWorkspacePanes.paneRoot();
  const adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(same);
  assert.equal(adopted, false, "signature match skips the adoption");
});

test("ungroup sends the op and adopts the server surgery", async () => {
  const { document } = buildDom();
  const starting = serverEntry();
  starting.groups = [
    { groupId: "g1", name: null, memberIds: ["p1", "p2"], layout: { kind: "row", sizes: [1, 1], children: ["p1", "p2"] } },
  ];
  starting.panels[0].groupId = "g1";
  starting.panels[1].groupId = "g1";
  starting.visible = { type: "group", id: "g1" };
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // The unsplit drop drives ungroupMember with a member tab drag: the
  // editor tab "editor:src/x.py" sits in p1 (seeded through the tab
  // placement seam), the drop ungroups p1, and the server surgery rides
  // back through the op response.
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  const leaf1 = entry.panels.find((p) => p.paneId === "p1");
  leaf1.tabs.push("editor:src/x.py");
  leaf1.active = "editor:src/x.py";
  ctx.paneTabDragStart({ target: { dataset: { tabId: "editor:src/x.py" }, classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } });
  const dropped = ctx.HerdrWorkspacePanes.paneTabUnsplitDrop({ dataTransfer: { getData: () => "editor:src/x.py" } });
  assert.equal(dropped, true, "drop reported");
  const ungroupCall = script.calls.find((c) => c.url === "/api/workspace-panes/op" && JSON.parse(c.opt.body).op === "group.ungroup");
  assert.ok(ungroupCall, "ungroup op posted");
  assert.equal(JSON.parse(ungroupCall.opt.body).paneId, "p1");
  // The op adoption is async (fire-and-forget dispatch): let the response
  // land before reading the adopted entry.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Server surgery adopted: the group dissolved under two members.
  const after = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(after.groups.length, 0, "two members minus one dissolves the group");
  assert.equal(after.panels.find((p) => p.paneId === "p1").groupId, null);
  assert.equal(after.panels.find((p) => p.paneId === "p2").groupId, null);
});

test("failed op falls back to the local mutation and drops to local mode", async () => {
  const { nodes, document } = buildDom();
  let failOps = true;
  const script = makeServerApi(serverEntry());
  const failingApi = async (url, opt) => {
    if (url === "/api/workspace-panes/op" && failOps) throw Error("boom");
    return script.api(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", failingApi);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const enc = encodeURIComponent("p1");
  ctx.HerdrWorkspacePanes.startPanelChipRename(enc);
  ctx.state.editingPanelValue = "local wins";
  ctx.HerdrWorkspacePanes.commitPanelChipRename(enc);
  // The op dispatch is fire-and-forget: let the retry and the local-mode
  // drop settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Retry once then local mode: the rename kept the local value.
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "local");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().panels[0].name, "local wins");
});

test("transport failure on boot stays in local mode", async () => {
  const { nodes, document } = buildDom();
  const deadApi = async () => {
    throw Error("no route");
  };
  const ctx = loadPanesModule(document, "ws-1", deadApi);
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "local");
  // The local boot entry stands (one panel).
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels.length, 1);
  assert.equal(entry.panels[0].paneId, "p1");
});

test("boot with no server entry seeds it through the apply POST", async () => {
  const { document } = buildDom();
  let stored = null;
  const emptyApi = async (url, opt) => {
    if (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET")) {
      // Older shape: an entry with no panels (adoption refuses it).
      return { v: 3, panels: [], groups: [], visible: { type: "panel", id: "" }, at: 1 };
    }
    if (url === "/api/workspace-panes" && opt.method === "POST") {
      stored = JSON.parse(opt.body).entry;
      return { ...stored, session: "work" };
    }
    throw Error(`unexpected ${url}`);
  };
  const ctx = loadPanesModule(document, "ws-1", emptyApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  assert.ok(stored, "seed POST fired");
  assert.equal(stored.panels.length, 1, "the local entry seeded the server");
});