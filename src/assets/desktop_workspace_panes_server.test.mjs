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
              // Server contract: the dissolve heals the visible pointer
              // to the surviving member, not the panels[0] fallback.
              if (entry.visible && entry.visible.type === "group" && entry.visible.id === groupId) {
                const survivor = entry.panels.find((p) => group.memberIds.includes(p.paneId));
                if (survivor) entry.visible = { type: "panel", id: survivor.paneId };
              }
              for (const id of group.memberIds) {
                const member = entry.panels.find((p) => p.paneId === id);
                if (member) member.groupId = null;
              }
              entry.groups = entry.groups.filter((g) => g.groupId !== groupId);
            }
          }
        }
      } else if (op.op === "group.create") {
        const dragged = entry.panels.find((p) => p.paneId === op.paneId);
        const neighbor = entry.panels.find((p) => p.paneId === op.neighborPaneId);
        if (dragged && neighbor) {
          const groupId = `g${entry.groups.length + 1}`;
          entry.groups.push({
            groupId,
            name: null,
            memberIds: [op.paneId, op.neighborPaneId],
            layout: {
              kind: op.axis,
              sizes: [1, 1],
              children: op.draggedFirst ? [op.paneId, op.neighborPaneId] : [op.neighborPaneId, op.paneId],
            },
          });
          dragged.groupId = groupId;
          neighbor.groupId = groupId;
          entry.visible = { type: "group", id: groupId };
        }
      } else if (op.op === "panel.create") {
        const paneId = `p${entry.panels.length + 1}`;
        entry.panels.push({ kind: "pane", paneId, tabs: [], active: null, wsId: op.wsId || null, groupId: null, name: null });
      } else if (op.op === "panel.update") {
        // Server contract: the push overwrites the named panel's
        // tabs/active/ws binding (terminal ids are client-pushed
        // truth; the server stores the arrays verbatim).
        const panel = entry.panels.find((p) => p.paneId === op.paneId);
        if (panel) {
          panel.tabs = Array.isArray(op.tabs) ? [...op.tabs] : [];
          panel.active = op.active || (panel.tabs[0] != null ? panel.tabs[0] : null);
          if (op.wsId != null) panel.wsId = op.wsId;
        }
      } else if (op.op === "group.grow") {
        // Server contract: the dragged panel must be ungrouped, the
        // group must be the visible subject, the member list gains the
        // panel, and layout_with_panel_at seats it beside the host.
        const dragged = entry.panels.find((p) => p.paneId === op.paneId);
        const group = entry.groups.find((g) => g.groupId === op.groupId);
        if (!dragged || !group || dragged.groupId) return { ...entry, session: "work" };
        if (!entry.visible || entry.visible.type !== "group" || entry.visible.id !== op.groupId) {
          return { ...entry, session: "work" };
        }
        dragged.groupId = group.groupId;
        group.memberIds.push(op.paneId);
        group.focusedPaneId = op.paneId;
        const ids = Array.isArray(group.layout && group.layout.children)
          ? group.layout.children.slice()
          : [];
        const at = op.hostPaneId && ids.includes(op.hostPaneId) ? ids.indexOf(op.hostPaneId) : ids.length;
        ids.splice(op.draggedFirst ? at : at + 1, 0, op.paneId);
        group.layout = { kind: op.axis || "row", sizes: ids.map(() => 1), children: ids };
      } else if (op.op === "panel.close") {
        // Server contract (real close): the splice drops the panel and
        // its tabs; no migration. The client drains each view through
        // its own close path first, the under-two dissolve heals the
        // visible pointer to the survivor.
        const doomed = entry.panels.find((p) => p.paneId === op.paneId);
        const groupId = doomed && doomed.groupId;
        entry.panels = entry.panels.filter((p) => p.paneId !== op.paneId);
        if (groupId) {
          const group = entry.groups.find((g) => g.groupId === groupId);
          if (group) {
            group.memberIds = group.memberIds.filter((id) => id !== op.paneId);
            if (group.memberIds.length < 2) {
              if (entry.visible && entry.visible.type === "group" && entry.visible.id === groupId) {
                const survivor = entry.panels.find((p) => group.memberIds.includes(p.paneId));
                if (survivor) entry.visible = { type: "panel", id: survivor.paneId };
              }
              for (const id of group.memberIds) {
                const member = entry.panels.find((p) => p.paneId === id);
                if (member) member.groupId = null;
              }
              entry.groups = entry.groups.filter((g) => g.groupId !== groupId);
            }
          }
        }
      } else if (op.op === "subject.set") {
        entry.visible = { type: op.visible.type, id: op.visible.id };
        // Server contract: the record persists through the switch; the
        // op's focus memory lands on it when it names a live member.
        if (op.groupId && op.focusedPaneId) {
          const group = entry.groups.find((g) => g.groupId === op.groupId);
          if (group && group.memberIds.includes(op.focusedPaneId)) {
            group.focusedPaneId = op.focusedPaneId;
          }
        }
      }
      return { ...entry, session: "work" };
    },
  };
  const api = async (url, opt) => {
    calls.push({ url, opt });
    if (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET")) {
      // Wire-realistic: a real response deserializes fresh objects, so
      // a GET must never share references with the fake's live entry
      // (adoption would alias client leaves into the fake and local
      // mutations would write through to "server truth").
      return JSON.parse(JSON.stringify({ ...entry, session: "work" }));
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
  // Persistence: the remote group is NOT this client's subject, but it
  // still adopts as a parked rail chip with its member links intact.
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
  assert.equal(entry.groups.length, 1, "remote group adopted as a parked chip");
  assert.equal(entry.groups[0].groupId, "g1", "group record stands");
  assert.equal(entry.panels.length, 3, "the new server panel adopted");
  assert.equal(entry.panels.find((p) => p.paneId === "p1").groupId, "g1", "member link adopted");
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

test("failed op resyncs and stays in server mode; a dead resync demotes to local", async () => {
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
  // The op dispatch is fire-and-forget: let the retry, the resync, and
  // the settle run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Both op tries failed on transport, but the server answers the
  // resync GET: the session STAYS in server mode on the resynced
  // entry (demoting would fork the session against a live server),
  // and the local twin never runs over the server truth.
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().panels[0].name, null);
  // A server that cannot answer the resync either is a real outage:
  // the session demotes and the local twin stands.
  failOps = true;
  const deadScript = makeServerApi(serverEntry());
  const deadApi = async (url, opt) => {
    if (url === "/api/workspace-panes") throw Error("dead");
    if (url === "/api/workspace-panes/op") throw Error("boom");
    return deadScript.api(url, opt);
  };
  const ctx2 = loadPanesModule(document, "ws-2", deadApi);
  ctx2.HerdrWorkspacePanes.setPanesModeForTests("server");
  const enc2 = encodeURIComponent("p1");
  ctx2.HerdrWorkspacePanes.startPanelChipRename(enc2);
  ctx2.state.editingPanelValue = "local wins";
  ctx2.HerdrWorkspacePanes.commitPanelChipRename(enc2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx2.HerdrWorkspacePanes.panesMode(), "local");
  assert.equal(ctx2.HerdrWorkspacePanes.paneRoot().panels[0].name, "local wins");
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

test("zero-workspace boot converts the server's contentless seed to the empty entry", async () => {
  // Change 6: the server store never holds a zero-panel entry (GET
  // self-seeds, the last panel.close resets to the seed), so a
  // zero-workspace client adopts its contentless p1 seed as the EMPTY
  // state instead of minting the ghost panel.
  const { nodes, document } = buildDom();
  const seedApi = async (url, opt) => {
    if (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET")) {
      return {
        v: 3,
        panels: [{ kind: "pane", paneId: "p1", tabs: [], active: null, wsId: null, groupId: null }],
        groups: [],
        visible: { type: "panel", id: "p1" },
        at: 5,
      };
    }
    throw Error(`unexpected ${url}`);
  };
  const ctx = loadPanesModule(document, null, seedApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels.length, 0, "the contentless seed adopted as the empty entry");
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  assert.ok(!nodes.container.querySelector(".pane-label-rail"), "no rail over the dashboard");
});

test("zero-workspace boot posts the seed shape but keeps the local empty state", async () => {
  // The server never accepts a zero-panel entry (validation gates
  // panels.is_empty()), so a zero-workspace client posts the p1 seed
  // shape on the migration POST while keeping its local panels at
  // zero.
  const { document } = buildDom();
  let posted = null;
  const noEntryApi = async (url, opt) => {
    if (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET")) {
      return null;
    }
    if (url === "/api/workspace-panes" && opt.method === "POST") {
      posted = JSON.parse(opt.body).entry;
      return { ...posted, session: "work" };
    }
    throw Error(`unexpected ${url}`);
  };
  const ctx = loadPanesModule(document, null, noEntryApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  assert.ok(posted, "the migration POST fired");
  assert.equal(posted.panels.length, 1, "the POST carried the p1 seed shape");
  assert.equal(posted.panels[0].paneId, "p1");
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels.length, 0, "the local entry stays empty (zero workspaces)");
});

test("label drop posts group.create with the drop geometry and adopts the group", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // Paint once so a real .workspace-pane with data-pane-id exists for
  // the drop hit test (panelDropTargetAt climbs from event.target).
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  // Drag p1's label and drop it on the right half of the visible p2.
  ctx.HerdrWorkspacePanes.paneLabelDragStart(
    { target: { classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } },
    encodeURIComponent("p1")
  );
  const pane2 = document.getElementById("workspacePanes").querySelector(".workspace-pane");
  assert.ok(pane2 && pane2.dataset.paneId, "the painted pane carries its paneId");
  // Container rect: left 10, top 10, width 24, height 24 (the stub
  // geometry). x=30 lands in the right third (fx=.83), y=15 in the top
  // third (fy=.21), dx=.17 < dy=.21: quadrant row, second half (the
  // dragged panel is NOT first).
  ctx.HerdrWorkspacePanes.paneContainerTabDrop({
    target: pane2,
    clientX: 30,
    clientY: 15,
    dataTransfer: { getData: () => "p1", dropEffect: "move" },
    preventDefault() {},
  });
  const createCall = script.calls.find((c) => c.url === "/api/workspace-panes/op" && JSON.parse(c.opt.body).op === "group.create");
  assert.ok(createCall, "group.create op posted");
  const op = JSON.parse(createCall.opt.body);
  assert.equal(op.paneId, "p1");
  assert.equal(op.neighborPaneId, "p2", "auto-join picks the rail neighbor");
  assert.equal(op.axis, "row");
  assert.equal(op.draggedFirst, false, "the drop quadrant places the neighbor first");
  // The op response carries the server-minted group; the adoption is
  // async (fire-and-forget promise), let the microtask settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.groups.length, 1, "server group adopted");
  assert.equal(entry.groups[0].groupId, "g1");
  assert.deepEqual(entry.groups[0].memberIds, ["p1", "p2"]);
  assert.deepEqual(entry.groups[0].layout.children, ["p2", "p1"]);
  assert.equal(entry.panels.find((p) => p.paneId === "p1").groupId, "g1");
  assert.equal(entry.panels.find((p) => p.paneId === "p2").groupId, "g1");
});

test("a sync pass pushes one panel.update for the touched leaf only", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // Simulate drift: the server entry believes the focused panel p2
  // lost t2 (another client's stale push). The homing ladder serves
  // the focused leaf first (terminalHomeLeafFor), so the sync pass
  // homes t2 back into p2 and pushes the leaf deltas.
  const drifted = ctx.HerdrWorkspacePanes.paneRoot();
  drifted.panels.find((p) => p.paneId === "p2").tabs = [];
  drifted.panels.find((p) => p.paneId === "p2").active = null;
  const changed = ctx.HerdrWorkspacePanes.syncTerminalTabsIntoTree(ctx.HerdrWorkspacePanes.paneRoot());
  assert.equal(changed, true, "the pass reported a change (t2 re-homed)");
  // Fire-and-forget pushes: settle before reading the op log.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = script.calls
    .map((c) => (c.url === "/api/workspace-panes/op" ? JSON.parse(c.opt.body) : null))
    .filter((op) => op && op.op === "panel.update");
  assert.equal(updates.length, 1, "one panel.update for the touched leaf");
  const byId = new Map(updates.map((op) => [op.paneId, op]));
  const p2 = byId.get("p2");
  assert.ok(p2, "the touched leaf pushed");
  assert.ok(!byId.has("p1"), "the untouched leaf stayed quiet");
  assert.deepEqual(p2.tabs, ["t2"], "p2 pushed its re-homed tabs");
  assert.equal(p2.active, "t2");
  assert.equal(p2.wsId, "ws-1");
});

test("a transient op failure retries once, stays in server mode, and adopts", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  let opAttempts = 0;
  let opFailures = 0;
  const flakyApi = async (url, opt) => {
    if (url === "/api/workspace-panes/op") {
      opAttempts += 1;
      if (opAttempts === 1) {
        opFailures += 1;
        throw Error("transient drop");
      }
    }
    return script.api(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", flakyApi);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const enc = encodeURIComponent("p1");
  ctx.HerdrWorkspacePanes.startPanelChipRename(enc);
  ctx.state.editingPanelValue = "retry wins";
  ctx.HerdrWorkspacePanes.commitPanelChipRename(enc);
  // First attempt rejects, the retry rides a real response: settle the
  // fire-and-forget dispatch before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(opAttempts, 2, "exactly one failed attempt plus one successful retry");
  assert.equal(opFailures, 1, "only the first attempt failed");
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server", "no local-mode demotion");
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.panels[0].name, "retry wins", "the retry's response adopted");
  // A follow-up op still dispatches in server mode (no sticky demotion).
  ctx.HerdrWorkspacePanes.startPanelChipRename(enc);
  ctx.state.editingPanelValue = "second op";
  ctx.HerdrWorkspacePanes.commitPanelChipRename(enc);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().panels[0].name, "second op");
});

// Fix B pin: a stale "server" mode from a previous session must not
// survive into a new boot; even an unreachable server leaves local mode.
test("bootFromServer resets a stale server mode back to local first", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [{ tab_id: "t1", workspace_id: "ws-1" }];
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // Transport failure (no reachable entry): local mode stays.
  const unreachableApi = () => Promise.reject(new Error("network down"));
  const ctx2 = loadPanesModule(document, "ws-1", unreachableApi);
  ctx2.state.tabs = [{ tab_id: "t1", workspace_id: "ws-1" }];
  ctx2.HerdrWorkspacePanes.setPanesModeForTests("server");
  await ctx2.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx2.HerdrWorkspacePanes.panesMode(), "local");
  await ctx.HerdrWorkspacePanes.bootFromServer();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server", "successful boot re-promotes");
});

test("entrySignaturesMatch: visible and runtime marks are excluded, tabs order is not", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");

  // A frame differing ONLY in the visible pointer matches the live
  // signature: the pointer is per-client, the guard must skip adoption.
  const otherVisible = serverEntry();
  otherVisible.visible = { type: "panel", id: "p1" };
  let adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(otherVisible);
  assert.equal(adopted, false, "a visible-only difference is a no-op");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().visible.id, "p2", "the local pointer kept");

  // A runtime mark (auto-close arm) is client-only state: the same
  // server signature must still match with the mark on the live leaf.
  const marked = ctx.HerdrWorkspacePanes.paneRoot();
  marked.panels[0].autoCloseArmed = true;
  marked.panels[0].autoClosePre = { tabs: ["t1"] };
  adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(serverEntry());
  assert.equal(adopted, false, "runtime marks never enter the signature");
  const after = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(after.panels[0].autoCloseArmed, true, "the mark survived the (skipped) adoption");

  // A tabs difference does NOT match: the adoption runs. The remote tab
  // is an editor id (client-owned, opaque to the server), so it survives
  // the sync pass instead of pruning as an unknown terminal id.
  const reordered = serverEntry();
  reordered.panels[1].tabs = ["t2", "editor:src/x.py"];
  adopted = ctx.HerdrWorkspacePanes.applyRemoteEntry(reordered);
  assert.equal(adopted, true, "a tabs difference adopts");
  assert.deepEqual(
    Array.from(ctx.HerdrWorkspacePanes.paneRoot().panels[1].tabs),
    ["t2", "editor:src/x.py"],
    "the adopted tabs stand"
  );
});

test("visibility regain re-adopts the drifted server entry (bindings.js bootFromServer path)", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  // Client A went hidden: broadcasts stop landing (the harness simply
  // never calls applyRemoteEntry). While hidden, another client renamed
  // p1 and p3 got created server-side.
  script.entry.panels[0].name = "renamed while hidden";
  script.entry.panels.push({ kind: "pane", paneId: "p3", tabs: [], active: null, wsId: "ws-1", groupId: null, name: null });
  // Client A regains visibility: bindings.js calls bootFromServer again.
  await ctx.HerdrWorkspacePanes.bootFromServer();
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(ctx.HerdrWorkspacePanes.panesMode(), "server");
  assert.equal(entry.panels.length, 3, "the hidden-period panel p3 adopted");
  assert.equal(entry.panels.find((p) => p.paneId === "p1").name, "renamed while hidden");
  // The per-client visible pointer survives when its subject still lives.
  assert.equal(entry.visible.type, "panel");
  assert.equal(entry.visible.id, "p2", "the live local pointer kept through the re-adopt");

  // Second regain where the local subject DIED while hidden: p2 closed
  // server-side, so the heal must hand the pointer to a live subject.
  script.entry = serverEntry();
  script.entry.panels[0].name = "renamed while hidden";
  script.entry.panels.push({ kind: "pane", paneId: "p3", tabs: [], active: null, wsId: "ws-1", groupId: null, name: null });
  script.entry.panels = script.entry.panels.filter((p) => p.paneId !== "p2");
  script.entry.visible = { type: "panel", id: "p3" };
  await ctx.HerdrWorkspacePanes.bootFromServer();
  const healed = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(healed.panels.length, 2, "the closed p2 dropped");
  assert.notEqual(healed.visible.id, "p2", "the dead pointer healed");
  assert.ok(
    healed.visible.type === "panel" && healed.panels.some((p) => p.paneId === healed.visible.id),
    "the healed pointer names a live panel"
  );
});

test("subject switch to a panel sends subject.set and keeps the group", async () => {
  const { document } = buildDom();
  // Server entry with a visible group g1 over p1+p2.
  const starting = serverEntry();
  starting.groups = [{ groupId: "g1", name: null, memberIds: ["p1", "p2"], layout: { kind: "row", sizes: [1, 1], children: ["p1", "p2"] } }];
  starting.panels[0].groupId = "g1";
  starting.panels[1].groupId = "g1";
  starting.visible = { type: "group", id: "g1" };
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  assert.equal(ctx.HerdrWorkspacePanes.paneRoot().groups.length, 1, "group adopted");
  // Member press: the record survives, the pressed member rides the op
  // as the group's focus memory, and the server stub mirrors it back.
  assert.equal(ctx.HerdrWorkspacePanes.showPanelFromRail(encodeURIComponent("p1")), true);
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.groups.length, 1, "subject switch kept the group record");
  assert.equal(entry.visible.type, "panel", "subject names the pressed panel");
  const subjectSet = script.calls.find((c) => c.url === "/api/workspace-panes/op" && c.opt && JSON.parse(c.opt.body).op === "subject.set");
  assert.ok(subjectSet, "subject.set op fired");
  const body = JSON.parse(subjectSet.opt.body);
  assert.equal(body.groupId, "g1", "op carries the group id");
  assert.equal(body.focusedPaneId, "p1", "op carries the pressed member");
  assert.equal(entry.groups[0].focusedPaneId, "p1", "adopted frame mirrors the focus memory");
});

test("a 422-rejected intent resyncs and never runs the local twin", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  // Business-rule refusal: the op route answers 422 (panel already
  // grouped on the server side, the race case from the review).
  const realApi = script.api;
  let refused = false;
  const refusingApi = async (url, opt) => {
    if (url === "/api/workspace-panes/op") {
      const op = JSON.parse(opt.body);
      if (op.op === "group.ungroup" && !refused) {
        refused = true;
        throw Object.assign(new Error("panel is not grouped"), { status: 422 });
      }
    }
    return realApi(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", refusingApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  // No group exists locally; the ungroup intent is refused. The local
  // twin must NOT run over the resynced entry.
  const leaf = panes.paneRoot().panels[0];
  const before = JSON.stringify(panes.paneRoot());
  const out = await panes.panesOpWithFallbackForTests(
    { op: "group.ungroup", paneId: leaf.paneId },
    () => "local-twin-ran",
  );
  assert.equal(out, panes.panesOpRejectedForTests, "rejected intent returns the rejection sentinel, not the twin value");
  assert.ok(refused, "the op reached the refusing server");
  assert.equal(JSON.stringify(panes.paneRoot()), before, "entry unchanged: resync state kept, no local twin");
  assert.equal(panes.panesMode(), "server", "422 does not demote to local mode");
});

test("a 400 rejection is authoritative: resync, no twin, no demotion", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  // Transport-shaped 400 (malformed intent): same contract as 422, the
  // entry stays server truth and the local twin never runs.
  const realApi = script.api;
  const refusingApi = async (url, opt) => {
    if (url === "/api/workspace-panes/op") {
      throw Object.assign(new Error("malformed intent"), { status: 400 });
    }
    return realApi(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", refusingApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  const leaf = panes.paneRoot().panels[0];
  const before = JSON.stringify(panes.paneRoot());
  const out = await panes.panesOpWithFallbackForTests(
    { op: "group.ungroup", paneId: leaf.paneId },
    () => "local-twin-ran",
  );
  assert.equal(out, panes.panesOpRejectedForTests, "400 rejection returns the rejection sentinel");
  assert.equal(JSON.stringify(panes.paneRoot()), before, "entry unchanged after 400 resync");
  assert.equal(panes.panesMode(), "server", "400 does not demote to local mode");
});

test("a 401 auth failure is NOT authoritative: retry then local mode", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  // 401 is carved out of the rejection set: auth failures ride the
  // retry ladder like a transport failure. A dead session 401s the op
  // AND the resync GET (same cookie), so the ladder ends in local mode
  // with the local twin applied.
  const realApi = script.api;
  const authApi = async (url, opt) => {
    if (
      url === "/api/workspace-panes/op" ||
      (url === "/api/workspace-panes" && (!opt || !opt.method || opt.method === "GET"))
    ) {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    }
    return realApi(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", authApi);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  const leaf = panes.paneRoot().panels[0];
  const out = await panes.panesOpWithFallbackForTests(
    { op: "group.ungroup", paneId: leaf.paneId },
    () => "local-twin-ran",
  );
  assert.equal(out, "local-twin-ran", "401 runs the local twin after the retry ladder");
  assert.equal(panes.panesMode(), "local", "401 ends in local mode");
});

test("adoption preserves the local focus pointer", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  panes.paneRoot().activePaneId = "p1";
  // Another writer's frame arrives with a different (stale) focus. The
  // remote differs structurally (name change) so the signature guard
  // lets the adoption through.
  const remote = serverEntry();
  remote.activePaneId = "p2";
  remote.panels[0].name = "remote rename";
  assert.equal(panes.applyRemoteEntry(remote), true);
  assert.equal(panes.paneRoot().activePaneId, "p1", "local focus survived the adoption");
});

test("close inside a split adopts the server drop and the survivor heal", async () => {
  const { document } = buildDom();
  const starting = serverEntry();
  starting.panels.push({ kind: "pane", paneId: "p3", tabs: ["editor:src/gone.py"], active: "editor:src/gone.py", wsId: "ws-1", groupId: null, name: null });
  starting.groups = [
    { groupId: "g1", name: null, memberIds: ["p2", "p3"], layout: { kind: "row", sizes: [1, 1], children: ["p2", "p3"] } },
  ];
  starting.panels[1].groupId = "g1";
  starting.panels[2].groupId = "g1";
  starting.visible = { type: "group", id: "g1" };
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  ctx.window.HerdrFileBrowser = {
    async closeEditorTab(path) { ctx.HerdrWorkspacePanes.closeEditorTabImmediate(path); },
  };
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  assert.equal(panes.paneRoot().visible.type, "group", "group subject adopted");
  assert.equal(await panes.closePaneFor("p3"), true, "close accepted");
  // The op adoption is async (fire-and-forget dispatch): let the
  // response land before reading the adopted entry.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = panes.paneRoot();
  const survivor = after.panels.find((p) => p.paneId === "p2");
  assert.ok(survivor, "survivor stands");
  assert.ok(!survivor.tabs.includes("editor:src/gone.py"), "doomed views die with the panel, no server merge");
  assert.ok(!after.panels.some((p) => p.paneId === "p3"), "closed panel record dropped");
  assert.equal(after.groups.length, 0, "group dissolved under two members");
  assert.equal(after.visible.type, "panel", "subject healed to a panel");
  assert.equal(after.visible.id, "p2", "the survivor takes the subject, not panels[0]");
});

test("close during panel.close flight pushes no panel.update for the sibling", async () => {
  const { document } = buildDom();
  // Tree order matters for the reproduction: the D7.1 one-owner repair
  // lets the first panel win a duplicated id, so the doomed panel (p2)
  // must precede its sibling (p3) exactly like the live p3/p4 case.
  const starting = serverEntry();
  starting.panels[0].tabs = [];
  starting.panels[0].active = null;
  starting.panels[1].tabs = ["t1", "t2"];
  starting.panels[1].active = "t2";
  starting.panels.push({ kind: "pane", paneId: "p3", tabs: [], active: null, wsId: "ws-1", groupId: "g1", name: null });
  starting.panels[1].groupId = "g1";
  starting.groups = [
    { groupId: "g1", name: null, memberIds: ["p2", "p3"], layout: { kind: "row", sizes: [1, 1], children: ["p2", "p3"] } },
  ];
  starting.visible = { type: "group", id: "g1" };
  const script = makeServerApi(starting);
  // Hold panel.close in flight so the pre-adoption window is observable.
  let releaseClose = null;
  const gate = script.api;
  script.api = async (url, opt) => {
    if (url === "/api/workspace-panes/op") {
      const op = JSON.parse(opt.body);
      if (op.op === "panel.close") {
        await new Promise((resolve) => { releaseClose = resolve; });
        return gate(url, opt);
      }
    }
    return gate(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  // The real closeTab owns the backend row close; model the row half
  // so the drain's close does not strand re-homeable ids.
  ctx.window.closeTab = async (tabId) => {
    ctx.state.tabs = ctx.state.tabs.filter((row) => row.tab_id !== tabId);
    ctx.HerdrWorkspacePanes.onTerminalTabClosed(tabId);
  };
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  const panes = ctx.HerdrWorkspacePanes;
  const closePromise = panes.closePaneFor("p2");
  // The drain awaits each view's own close path before the panel.close
  // fires: settle one microtask tick so the op parks in flight.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(releaseClose, "close op fired and is parked in flight");
  // The close op is in flight: the local tree still holds p2 with its
  // tabs, p3 empty. A sync pass here is the exact window where the old
  // code's pre-merge put the doomed tabs in two owners, D7.1 stripped
  // the later sibling, and the panel.update push (tabs=[]) landed
  // after the close response and wiped the server merge.
  script.calls = script.calls.filter((c) => c.url !== "/api/workspace-panes/op");
  panes.syncTerminalTabsIntoTree();
  const midFlight = script.calls.filter((c) => {
    if (c.url !== "/api/workspace-panes/op") return false;
    const op = JSON.parse(c.opt.body);
    return op.op === "panel.update" && op.paneId === "p3";
  });
  assert.equal(midFlight.length, 0, "no sibling panel.update while the close is in flight");
  releaseClose();
  await closePromise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = panes.paneRoot();
  const survivor = after.panels.find((p) => p.paneId === "p3");
  assert.ok(survivor, "survivor stands");
  // The close is real: the doomed rows are gone, the survivor keeps
  // nothing of the closed panel (no merge), and the group dissolved.
  assert.ok(!after.panels.some((p) => p.paneId === "p2"), "closed panel record dropped");
  assert.equal(survivor.tabs.length, 0, "survivor keeps only its own views");
  assert.equal(after.groups.length, 0, "group dissolved under two members");
  assert.equal(after.visible.id, "p3", "the survivor takes the subject");
});

test("a strip drop onto a busy server member grows the group server-side", async () => {
  const { nodes, document } = buildDom();
  // Start from a two-member visible group: p1 and p2 grouped, p3 flat
  // holding t3. Dropping t3 onto p1's busy strip must mint a fresh
  // panel and grow the group through panel.create + group.grow ops,
  // never stack t3 into p1.
  const grouped = serverEntry();
  grouped.panels.push({ kind: "pane", paneId: "p3", tabs: ["t3"], active: "t3", wsId: "ws-1", groupId: null, name: null });
  grouped.groups.push({
    groupId: "g1",
    name: null,
    memberIds: ["p1", "p2"],
    layout: { kind: "row", sizes: [1, 1], children: ["p1", "p2"] },
    focusedPaneId: "p1",
  });
  grouped.panels[0].groupId = "g1";
  grouped.panels[1].groupId = "g1";
  grouped.visible = { type: "group", id: "g1" };
  const script = makeServerApi(grouped);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
    { tab_id: "t3", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  // Find p1's strip under the painted split.
  const container = document.getElementById("workspacePanes");
  const walk = (n) => {
    for (const child of n.children || []) {
      if (child.dataset && child.dataset.paneId === "p1") return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const pane1 = walk(container);
  assert.ok(pane1, "p1 pane painted in the split");
  const strip = pane1.querySelector(".pane-tab-strip");
  assert.ok(strip, "p1 strip painted");
  ctx.paneTabDragStart({ target: { dataset: { tabId: "t3" } }, dataTransfer: { setData() {}, effectAllowed: "" } });
  ctx.HerdrWorkspacePanes.paneStripDrop({
    target: strip,
    clientX: 4,
    clientY: 4,
    preventDefault() {},
    dataTransfer: { _data: {}, setData(k, v) { this._data[k] = v; }, getData(k) { return this._data[k] || ""; } },
  });
  // The split engine is async (panel.create then group.grow awaits):
  // settle the microtask chain.
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const ops = script.calls
    .filter((c) => c.url === "/api/workspace-panes/op")
    .map((c) => JSON.parse(c.opt.body));
  assert.ok(ops.some((op) => op.op === "panel.create"), "panel.create minted the fresh member");
  const grow = ops.find((op) => op.op === "group.grow");
  assert.ok(grow, "group.grow posted");
  assert.equal(grow.groupId, "g1");
  assert.equal(grow.hostPaneId, "p1", "the busy target hosts the seat");
  assert.equal(grow.axis, "row");
  assert.equal(grow.draggedFirst, false);
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  const p1 = entry.panels.find((p) => p.paneId === "p1");
  // vm-realm arrays fail the host deepStrictEqual: spread before compare.
  assert.deepEqual([...p1.tabs], ["t1"], "the busy member never stacked a second view");
  const group = entry.groups.find((g) => g.groupId === "g1");
  assert.ok(group.memberIds.includes("p4"), "the fresh member joined the group");
  const fresh = entry.panels.find((p) => p.paneId === "p4");
  assert.ok(fresh, "the server minted the fresh member");
  assert.deepEqual([...fresh.tabs], ["t3"], "the dropped view landed in the fresh member");
  const p3 = entry.panels.find((p) => p.paneId === "p3");
  assert.deepEqual([...p3.tabs], [], "the source leaf emptied");
});

// A server-mode group.create drop is a PROMISE: the immediate
// save+render after the drop would persist and paint a visible subject
// carrying the "__pending__" placeholder id before the op lands. The
// paint must wait for the settle, and localStorage must never hold the
// placeholder while the op is in flight.
test("a server group.create drop defers the paint to the op response", async () => {
  const { nodes, document } = buildDom();
  const script = makeServerApi(serverEntry());
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  const heldApi = async (url, opt) => {
    // group.create stalls until the test releases it; every other call
    // (the boot GET) passes through.
    if (url === "/api/workspace-panes/op" && JSON.parse(opt.body).op === "group.create") {
      await gate;
      return script.api(url, opt);
    }
    return script.api(url, opt);
  };
  const ctx = loadPanesModule(document, "ws-1", heldApi);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();
  const railHtmlBefore = nodes.container.querySelector(".pane-label-rail").__innerHTML;
  const storageBefore = JSON.stringify(ctx.__storage);

  // The same drop gesture as the adoption test: p1 onto p2's right.
  ctx.HerdrWorkspacePanes.paneLabelDragStart(
    { target: { classList: { add() {}, remove() {} } }, dataTransfer: { setData() {}, effectAllowed: "move" } },
    encodeURIComponent("p1")
  );
  const pane2 = document.getElementById("workspacePanes").querySelector(".workspace-pane");
  ctx.HerdrWorkspacePanes.paneContainerTabDrop({
    target: pane2,
    clientX: 30,
    clientY: 15,
    dataTransfer: { getData: () => "p1", dropEffect: "move" },
    preventDefault() {},
  });
  // In flight: no group adopted yet, and neither the paint nor the
  // save ran, so localStorage never held a visible.id "__pending__".
  const inFlightEntry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(inFlightEntry.groups.length, 0, "no group while the op is in flight");
  const storedNow = JSON.stringify(ctx.__storage);
  assert.ok(!storedNow.includes('"__pending__"'), "no placeholder id persisted while in flight");
  const railInFlight = nodes.container.querySelector(".pane-label-rail").__innerHTML;
  assert.equal(railInFlight, railHtmlBefore, "no paint while the op is in flight");

  // The settle owns the adoption: the response carries the real group
  // and the paint follows.
  settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entry = ctx.HerdrWorkspacePanes.paneRoot();
  assert.equal(entry.groups.length, 1, "server group adopted on settle");
  assert.ok(!entry.visible || entry.visible.id !== "__pending__", "the painted subject never keeps the placeholder id");
  assert.notEqual(
    nodes.container.querySelector(".pane-label-rail").__innerHTML,
    railHtmlBefore,
    "the paint ran after the settle"
  );
  assert.ok(!JSON.stringify(ctx.__storage).includes('"__pending__"'), "the settle repaint persists the real subject");
});

test("an editor tab close pushes its leaf delta to the server", async () => {
  const { document } = buildDom();
  // p2 holds one terminal id and one editor id: the terminal sync pass
  // never carries the editor close, so the close itself must push.
  const starting = serverEntry();
  starting.panels[1].tabs = ["t2", "editor:src/gone.py"];
  starting.panels[1].active = "editor:src/gone.py";
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  ctx.HerdrWorkspacePanes.closeEditorTabImmediate(encodeURIComponent("src/gone.py"));
  // Fire-and-forget push: settle before reading the op log.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = script.calls
    .map((c) => (c.url === "/api/workspace-panes/op" ? JSON.parse(c.opt.body) : null))
    .filter((op) => op && op.op === "panel.update");
  assert.equal(updates.length, 1, "the close pushed one panel.update");
  assert.equal(updates[0].paneId, "p2");
  assert.deepEqual([...updates[0].tabs], ["t2"], "the dead editor id left the server array");
  assert.equal(updates[0].active, "t2");
  // The push response adoption must not resurrect the closed id: the
  // server entry (scripted) dropped it and the local tree stays clean.
  // vm-realm arrays fail the host deepStrictEqual: spread before compare.
  const leaf = ctx.HerdrWorkspacePanes.paneRoot().panels.find((p) => p.paneId === "p2");
  assert.deepEqual([...leaf.tabs], ["t2"], "the local tree kept the splice after adoption");
});

test("a git tab close pushes its leaf delta to the server", async () => {
  const { document } = buildDom();
  const starting = serverEntry();
  starting.panels[1].tabs = ["t2", "git:status"];
  starting.panels[1].active = "git:status";
  const script = makeServerApi(starting);
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("server");
  ctx.HerdrWorkspacePanes.closeGitTabImmediate("status");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = script.calls
    .map((c) => (c.url === "/api/workspace-panes/op" ? JSON.parse(c.opt.body) : null))
    .filter((op) => op && op.op === "panel.update");
  assert.equal(updates.length, 1, "the git close pushed one panel.update");
  assert.equal(updates[0].paneId, "p2");
  assert.deepEqual([...updates[0].tabs], ["t2"], "the dead git id left the server array");
});

test("an editor tab close in local mode pushes nothing", async () => {
  const { document } = buildDom();
  const script = makeServerApi(serverEntry());
  const ctx = loadPanesModule(document, "ws-1", script.api);
  ctx.state.tabs = [
    { tab_id: "t1", workspace_id: "ws-1" },
    { tab_id: "t2", workspace_id: "ws-1" },
  ];
  await ctx.HerdrWorkspacePanes.bootFromServer();
  ctx.HerdrWorkspacePanes.setPanesModeForTests("local");
  const leaf = ctx.HerdrWorkspacePanes.paneRoot().panels.find((p) => p.paneId === "p2");
  leaf.tabs.push("editor:src/gone.py");
  leaf.active = "editor:src/gone.py";
  ctx.HerdrWorkspacePanes.closeEditorTabImmediate(encodeURIComponent("src/gone.py"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = script.calls
    .map((c) => (c.url === "/api/workspace-panes/op" ? JSON.parse(c.opt.body) : null))
    .filter((op) => op && op.op === "panel.update");
  assert.equal(updates.length, 0, "local mode never posts the delta");
});
