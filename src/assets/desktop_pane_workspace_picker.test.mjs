// Workspace picker (D3) and mixed-tree badge (D4/D6) contracts.
// The picker serves two entries: the strip `+` (new terminal in ANY
// workspace, landed in this pane) and the badge (route this pane to the
// picked workspace). Rows list every workspace with worktree name +
// branch + dirty dot, selected first. The badge only renders on a mixed
// tree, one-workspace leaves only, and routes on click.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const PICKER_PATH = fileURLToPath(new URL("./desktop/app_js/pane_workspace_picker.js", import.meta.url));
const pickerSource = readFileSync(PICKER_PATH, "utf8");
const pickerScript = new vm.Script(pickerSource, { filename: PICKER_PATH });

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    children: [],
    parentNode: null,
    style: {},
    listeners: {},
    attributes: {},
    innerHTML: "",
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
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (node.parentNode) {
        const at = node.parentNode.children.indexOf(node);
        if (at >= 0) node.parentNode.children.splice(at, 1);
      }
      node.parentNode = null;
    },
    contains(child) {
      return node === child || node.children.some((c) => c.contains(child));
    },
    querySelector(selector) {
      const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
      const walk = (n) => {
        for (const c of n.children) {
          if (wantClass && c.className.split(" ").includes(wantClass)) return c;
          const found = walk(c);
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
        for (const c of n.children) {
          if (wantClass && c.className.split(" ").includes(wantClass)) found.push(c);
          walk(c);
        }
      };
      walk(node);
      return found;
    },
    focus() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, bottom: 100, right: 0, width: 0, height: 0 };
    },
  };
  return node;
}

function loadPicker(overrides = {}) {
  const body = makeNode("body", "");
  const document = {
    createElement: () => makeNode("", ""),
    body,
    activeElement: null,
    addEventListener() {},
    getElementById: () => null,
    innerWidth: 1200,
    innerHeight: 800,
    ...overrides,
  };
  const ctx = {
    document,
    state: {
      ws: "ws-1",
      workspaces: [
        { workspace_id: "ws-1", label: "main", worktree: null },
        { workspace_id: "ws-2", label: "feat", worktree: { repo_name: "herdr", branch: "feature/x", dirty: true } },
      ],
      tabsById: { tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "other" } },
      tabs: [],
    },
    escapeHtml: (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    escapeAttr: (v) => String(v),
    workspaceBranch: (w) => (w.worktree && w.worktree.branch) || "",
    encodeURIComponent,
    window: null,
    go: () => {},
    api: null,
    showBlocking: () => {},
    hideBlocking: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  pickerScript.runInContext(vm.createContext(ctx));
  return { ctx, picker: ctx.HerdrPaneWorkspacePicker, body };
}

test("pickerRows lists every workspace, selected first, with branch and dirty state", () => {
  const { picker } = loadPicker();
  const rows = picker.pickerRows();
  assert.equal(rows.length, 2, "both workspaces listed");
  assert.equal(rows[0].workspaceId, "ws-1", "selected workspace pinned first");
  assert.equal(rows[0].current, true, "selected row marked current");
  assert.equal(rows[1].branch, "feature/x", "worktree branch shown");
  assert.equal(rows[1].dirty, true, "dirty dot shown");
  assert.equal(rows[1].repo, "herdr", "repo name carried");
});

test("openPicker renders rows into the body and the first row takes focus", () => {
  const { picker, body } = loadPicker();
  const anchor = makeNode("anchor", "pane-strip-button");
  picker.openPicker(anchor, "p1", "new-tab");
  assert.ok(picker.isOpen(), "popover open");
  const popover = body.children.find((c) => c.className === "pane-workspace-picker");
  assert.ok(popover, "popover mounted on the body");
  assert.equal(popover.attributes.role, "dialog", "dialog role set");
  // The vm DOM stub does not parse innerHTML into child nodes; the row
  // count and content assertions read the markup string.
  const rowMatches = popover.innerHTML.match(/class="pane-picker-row"/g) || [];
  assert.equal(rowMatches.length, 2, "one row per workspace");
  assert.ok(popover.innerHTML.includes("feature/x"), "branch rendered");
  assert.ok(popover.innerHTML.includes("current"), "current marker rendered");
  picker.close();
  assert.ok(!picker.isOpen(), "close clears state");
  assert.equal(body.children.length, 0, "popover removed from the body");
});

test("pick with scope switch routes to the workspace's first known terminal", () => {
  const routed = [];
  const { ctx, picker } = loadPicker();
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  picker.openPicker(makeNode("anchor", "pane-ws-badge"), "p1", "switch");
  picker.pick("ws-2");
  assert.deepEqual(routed, [["ws-2", "tab_9"]], "routed to ws-2's tab from tabsById");
});

test("pick with scope switch falls back to the workspace root when it has no panels", () => {
  const routed = [];
  const { ctx, picker } = loadPicker();
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  ctx.state.tabsById = {};
  picker.openPicker(makeNode("anchor", "pane-ws-badge"), "p1", "switch");
  picker.pick("ws-2");
  assert.deepEqual(routed, [["ws-2", undefined]], "routed to the workspace root");
});

test("pick with scope new-tab delegates to the shared openPanelInWorkspace", async () => {
  const delegated = [];
  const { ctx, picker } = loadPicker();
  ctx.window.HerdrWorkspacePanes = {
    openPanelInWorkspace: async (workspaceId, paneId) => delegated.push([workspaceId, paneId]),
  };
  picker.openPicker(makeNode("anchor", "pane-new-picker"), "p3", "new-tab");
  await picker.pick("ws-2");
  assert.deepEqual(delegated, [["ws-2", "p3"]], "new-tab creation routes through the shared helper with the opening pane");
});

test("pick with scope new-tab falls back to a plain route when the panes module is absent", async () => {
  const routed = [];
  const { ctx, picker } = loadPicker();
  ctx.go = (ws) => routed.push(ws);
  picker.openPicker(makeNode("anchor", "pane-new-picker"), "p3", "new-tab");
  await picker.pick("ws-2");
  assert.deepEqual(routed, ["ws-2"], "no private creation copy: the route alone");
});

test("source contract: capture wiring, idempotent wire, listbox semantics", () => {
  assert.ok(pickerSource.includes('addEventListener("pointerdown", globalPointerDown, true)'), "outside click closes (capture)");
  assert.ok(pickerSource.includes('addEventListener("keydown", globalKeydown, true)'), "global Escape closes");
  assert.ok(pickerSource.includes("role=\"listbox\""), "listbox semantics");
  assert.ok(pickerSource.includes("role=\"option\""), "option rows");
  assert.ok(/let wired = false/.test(pickerSource) && /if \(wired\) return/.test(pickerSource), "wire is idempotent");
});