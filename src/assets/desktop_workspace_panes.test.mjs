// Regression test: renderWorkspacePanes must never destroy the live
// #terminalShell node. Phase 1 shipped a first-run `container.innerHTML`
// that wiped #workspacePanes' children: #terminalShell, #tabs,
// #projectDashboard, orphaning every id-resolved const in the bundle
// (the live symptom was "terminal is not defined" in connectTerminal and
// a dead session). The pane skeleton must be built with createElement so
// the persistent nodes survive and #terminalShell can move into
// .pane-content by reference.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepEqual } from "node:assert";
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
    // hidden attribute until syncProjectDashboard shows it, and the
    // takeover decision reads exactly that attr.
    hidden: id === "projectDashboard",
    __innerHTML: "",
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
    // The renderer's reconcile enforces the pane/divider DOM order via
    // insertBefore after extends splice fresh panes mid-array; the stub
    // must mirror the real DOM contract.
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
    // Phase 5 menu helpers: closest walks classes like querySelector,
    // contains walks children, remove detaches from the parent. The
    // standalone menu lives on document.body, so these are the only DOM
    // services the menu code needs.
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
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 34, bottom: 34, width: 24, height: 24 };
    },
    // Phase 5 drag helpers: classList mirrors the className string.
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
    // Model the destructive browser semantics that caused the bug: setting
    // innerHTML drops all existing children.
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
  // Mirrors src/assets/app.html: #workspacePanes holds #tabs,
  // #projectDashboard, and #terminalShell (which contains #terminal).
  // All live under #document > #body so getElementById can walk the tree
  // like a real browser: containers mounted at runtime (editor/git tabs)
  // resolve by id wherever they sit.
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
  nodes.dashboard = dashboard;
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
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    body,
  };
  return { nodes, document };
}

function loadPanesModule(document, stateWs) {
  return loadPanesModuleWithStorage(document, stateWs, null);
}

function loadPanesModuleWithStorage(document, stateWs, stored) {
  const ctx = {
    document,
    localStorage: { getItem: () => stored, setItem() {} },
    state: { ws: stateWs, tabs: [], allTabs: [], workspacePanes: {} },
    // Minimal helpers the module references from the shared bundle scope.
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
  const source = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  workspacePanesScript.runInContext(vm.createContext(ctx));
  return ctx;
}

// The strip highlight regression (Phase 3b): render() is called from
// every navigation surface (go(), boot restore, shortcuts, panel menu),
// but only the editor path ever moved the tree's active pointer. Three
// desyncs shipped: terminal clicks via go() left the highlight behind,
// boot restored route and tree from different stores, and a same-route
// click (editor open keeps the route) early-returned without taking the
// slot back from the editor. All three live in the sync + activation
// seam these tests pin.
test("route navigation takes the strip active pointer from the editor tab", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }, { tab_id: "tab_3" }];
  const panes = ctx.HerdrWorkspacePanes;
  // Boot: route restores tab_2 while a stored tree keeps an editor
  // pointer with no container mounted (the blank-pane boot).
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  assert.equal(root.active, "tab_2", "boot sync: route panel takes the pointer");

  // Open an editor tab: the real flow pushes the tab into the tree
  // (paneEnsureEditorTab) before the file browser's mount takes the
  // pointer. The route stays on tab_2 (opening a file does not
  // navigate).
  root.tabs.push("editor:src/demo.py");
  panes.setActivePaneTab("editor:src/demo.py");
  assert.equal(root.active, "editor:src/demo.py", "editor open takes the pointer");

  // go()-style navigation to another panel: the pointer follows.
  ctx.state.tab = "tab_3";
  panes.renderWorkspacePanes();
  assert.equal(root.active, "tab_3", "route change moves the highlight");

  // Re-render without a route change: the editor pointer survives (no
  // yank on every poll).
  panes.setActivePaneTab("editor:src/demo.py");
  panes.renderWorkspacePanes();
  assert.equal(root.active, "editor:src/demo.py", "same route keeps the editor pointer");
  root.tabs.splice(root.tabs.indexOf("editor:src/demo.py"), 1);
  root.active = "tab_2";
});

test("same-route terminal click takes the slot back from the editor", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  // Editor open flow: tab lands in the tree first, then the pointer.
  root.tabs.push("editor:src/demo.py");
  panes.setActivePaneTab("editor:src/demo.py");
  // The route never moved (tab_2), the strip shows the editor active;
  // clicking the terminal tab must take the pointer back, not no-op.
  ctx.HerdrWorkspacePanes.activatePaneTab("tab_2");
  assert.equal(root.active, "tab_2", "same-route click moves the pointer");
  assert.equal(panes.paneActiveTab(root), "tab_2", "strip highlights the terminal");
});

test("terminal-active render hides stale editor containers in the slot", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const pane = nodes.container.querySelector(".workspace-pane");
  const content = pane.querySelector(".pane-content");
  // Simulate the editor container the file browser mounts when the tab
  // opens: the id is the real mount id, so the pane render claims it.
  const stale = makeNode(panes.paneEditorMountId("src/demo.py"), "pane-editor-container");
  stale.style.display = "";
  content.appendChild(stale);
  // Editor-active render first (tab in the tree, then pointer): the
  // container stays visible, the shell parks outside the slot.
  panes.paneRoot().tabs.push("editor:src/demo.py");
  panes.setActivePaneTab("editor:src/demo.py");
  assert.notEqual(stale.style.display, "none", "editor active keeps the container");
  assert.equal(nodes.shell.parentNode, nodes.container, "shell parks outside the slot");
  // Terminal-active render: the stale container hides, the shell owns
  // the slot again.
  panes.setActivePaneTab("tab_2");
  assert.equal(stale.style.display, "none", "terminal active hides the editor container");
  assert.equal(nodes.shell.parentNode, content, "shell back in the slot");
});

test("renderWorkspacePanes keeps #terminalShell attached and mounts it in the pane", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.HerdrWorkspacePanes.renderWorkspacePanes();

  // The persistent nodes survived the first render: still in the document
  // tree (the orphaning bug left them detached from every parent).
  assert.equal(nodes.terminal.parentNode, nodes.shell, "test setup");
  assert.ok(nodes.terminal.parentNode !== null, "#terminal keeps a parent");
  assert.equal(nodes.shell.parentNode !== null, true, "#terminalShell stays attached");
  assert.equal(nodes.tabs.parentNode !== null, true, "#tabs stays attached");
  assert.equal(nodes.dashboard.parentNode !== null, true, "#projectDashboard stays attached");

  // The pane skeleton exists and owns the terminal shell by reference.
  const pane = nodes.container.querySelector(".workspace-pane");
  assert.ok(pane, "pane skeleton renders");
  // Phase 4 seeds leaves with stable paneIds (p1, p2, ...): the flat
  // single-leaf fallback used to write the literal "root", but the
  // reconcile keys on the leaf's own id now.
  assert.equal(pane.dataset.paneId, "p1");
  const strip = pane.querySelector(".pane-tab-strip");
  assert.ok(strip, "tab strip renders");
  const content = pane.querySelector(".pane-content");
  assert.ok(content, "pane content slot renders");
  assert.equal(nodes.shell.parentNode, content, "#terminalShell moved into .pane-content");
  assert.equal(document.getElementById("terminalShell"), nodes.shell, "id lookup still resolves the same node");
  assert.equal(document.getElementById("terminal"), nodes.terminal, "#terminal still resolvable by id");
});

test("renderWorkspacePanes is idempotent across renders", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const firstPane = nodes.container.querySelector(".workspace-pane");
  const strip = firstPane.querySelector(".pane-tab-strip");
  strip.innerHTML = "";
  panes.renderWorkspacePanes();
  const again = nodes.container.querySelector(".workspace-pane");
  assert.equal(again, firstPane, "no pane rebuild on re-render");
  assert.equal(nodes.shell.parentNode, again.querySelector(".pane-content"), "terminal stays mounted");
});

test("backend panel ids sync into the pane tree and render in the strip", () => {
  // Live regression (Phase 3b): a workspace with existing backend panels
  // rendered an empty strip because the tree-driven renderer only shows
  // ids already in the tree, and nothing inserted the real tab ids. The
  // tree must mirror the backend: the seed placeholder is replaced by
  // the real ids, and a later panel list drops closed ids.
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }, { tab_id: "tab_3" }];
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  assert.deepEqual([...root.tabs], ["tab_2", "tab_3"], "placeholder replaced by backend ids");
  assert.equal(root.active, "tab_2", "active follows the first real panel");
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(strip.innerHTML.includes('data-tab-id="tab_2"'), "real panel renders in the strip");
  assert.ok(strip.innerHTML.includes('data-tab-id="tab_3"'), "second panel renders too");
  assert.ok(!strip.innerHTML.includes('data-tab-id="terminal"'), "no dead placeholder tab");

  // A closed panel drops from the tree on the next render; editor tabs and
  // a stale active pointer survive the prune.
  panes.openEditorTab("src/demo.py");
  root.active = "tab_3";
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  panes.renderWorkspacePanes();
  assert.deepEqual([...root.tabs], ["tab_2", "editor:src/demo.py"], "closed panel id drops, editor tab stays");
  assert.equal(root.active, "tab_2", "active pointer heals onto a live tab");

  // An empty panel list never prunes (poll gap / closed workspace): the
  // render filter hides ids without a panel instead of losing layout.
  ctx.state.tabs = [];
  panes.renderWorkspacePanes();
  assert.deepEqual([...root.tabs], ["tab_2", "editor:src/demo.py"], "empty panel list keeps the tree");
});

// ---- unfiltered universe + prune rule (split-panel slice 2, D10) -------
// The snapshot ships id -> row maps from the UNFILTERED arrays: a stored
// id whose row the workspace filter dropped must stay (snapshot race,
// cross-workspace tree), and a genuinely closed id must drop. The eager
// workspace-close sweep must act before the state rows leave.
test("a stored id absent from the filtered list but present in tabsById survives the prune", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tabsById = { tab_3: { tab_id: "tab_3", workspace_id: "ws-2", label: "other" } };
  // Session-global tree (D1): the sync places ids from EVERY workspace,
  // so tab_3 lands in the tree through the unfiltered map on its own.
  // The render filter must keep it (terminalTabKnown), and the active
  // pointer must hold onto it.
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  assert.deepEqual([...root.tabs].sort(), ["tab_2", "tab_3"], "unfiltered-map id placed and kept");
  root.active = "tab_3";
  panes.renderWorkspacePanes();
  assert.equal(root.active, "tab_3", "active pointer stays on the live id");
  assert.ok(panes.paneTabsForTree(root).includes("tab_3"), "strip filter keeps the id");
});

test("a stored id missing from both the filtered list and the unfiltered maps drops", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tabsById = { tab_2: { tab_id: "tab_2", workspace_id: "ws-1" } };
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  root.tabs.push("tab_gone");
  root.active = "tab_gone";
  panes.renderWorkspacePanes();
  assert.deepEqual([...root.tabs], ["tab_2"], "dead id pruned from the leaf");
  assert.equal(root.active, "tab_2", "pointer heals onto the survivor");
});

test("pruneWorkspaceTabsFromPanes sweeps a closed workspace's ids eagerly and collapses emptied leaves", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  // ws-1 tree: split with tab_2 (ws-1) on the left, tab_3 (ws-2) right.
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  ctx.state.allTabs = [
    { tab_id: "tab_2", workspace_id: "ws-1" },
    { tab_id: "tab_3", workspace_id: "ws-2" },
  ];
  panes.renderWorkspacePanes();
  assert.equal(panes.splitPaneRight(), true, "split plants the second leaf");
  const root = panes.paneRootFor();
  const rightLeaf = panes.paneLeaves(root).find((leaf) => leaf.tabs.length === 0);
  rightLeaf.tabs.push("tab_3");
  rightLeaf.active = "tab_3";

  // ws-2 closes: its ids must leave every tree NOW, not on the next poll.
  assert.equal(panes.pruneWorkspaceTabsFromPanes("ws-2"), true, "sweep reports a change");
  // deepEqual, not deepStrictEqual: leaf arrays are vm-realm objects.
  deepEqual(panes.paneLeaves(root).map((leaf) => [...leaf.tabs]), [["tab_2"], []], "ws-2 id gone, ws-1 id stays");
  // The emptied right leaf collapsed: the tree is the single left leaf.
  assert.equal(panes.paneLeaves(panes.paneRootFor()).length, 1, "emptied leaf collapsed");
  assert.equal(panes.paneLeaves(panes.paneRootFor())[0].tabs[0], "tab_2", "survivor keeps its id");
});

// ---- git view tabs (Phase 3c) -------------------------------------------
// The strip renders three tab kinds: terminal (backend panels), editor
// (editor:<path>), and git (git:<view-key>). These tests pin the git tab
// identity helpers, the strip render, the placeholder drop when git_ui
// fails to load, the close/reactivate order, and the terminal sync keep
// filter, all against a HerdrGitUi stub.
function makeGitStub() {
  const calls = [];
  return {
    calls,
    async openViewTab(viewKey) { calls.push({ openViewTab: String(viewKey) }); },
    releaseViewTab(viewKey) { calls.push({ releaseViewTab: String(viewKey) }); },
  };
}

test("git tab identity helpers map view-keys to tab ids and strip labels", () => {
  const { nodes, document } = buildDom();
  const panesCtx = loadPanesModule(document, "ws-1");
  const panes = panesCtx.HerdrWorkspacePanes;
  assert.equal(panes.gitTabId("changes"), "git:changes");
  assert.equal(panes.gitTabViewKey("git:history@src/a.py"), "history@src/a.py");
  assert.equal(panes.gitTabViewKey("editor:src/a.py"), "", "editor ids carry no git view-key");
  assert.equal(panes.isGitTab("git:log"), true);
  assert.equal(panes.isGitTab("editor:src/a.py"), false);
  assert.equal(panes.isGitTab("tab_1"), false);

  // Persisted git tabs render in the strip with data-tab-kind="git" and
  // labels derived from the view-key alone (placeholder tabs render
  // identically before git_ui.js loads).
  const root = panes.paneRoot();
  root.tabs.push(panes.gitTabId("changes"), panes.gitTabId("history@src/a.py"));
  root.active = panes.gitTabId("log"); // no log tab in the tree yet
  panes.renderWorkspacePanes();
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(strip.innerHTML.includes('data-tab-kind="git" data-tab-id="git:changes"'), "git tab renders in the strip");
  assert.ok(strip.innerHTML.includes('data-tab-id="git:history@src/a.py"'), "per-file history tab renders");
  assert.ok(strip.innerHTML.includes(">gitchanges</span>"), "changes label is the compact gitchanges");
  assert.ok(strip.innerHTML.includes(">history a.py</span>"), "history label carries the file basename");
  assert.equal(panes.gitTabLabel("compare@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), "gitcmp aaaaaaa vs bbbbbbb", "compare label shortens both refs to 7 chars");
  assert.equal(panes.gitTabLabel("compare@cccc..current"), "gitcmp cccc vs current", "against-working-tree compare keeps the current ref");
  assert.equal(panes.gitTabLabel("compare@main..feature-x"), "gitcmp main vs feature", "branch-name refs truncate to 7 chars");
  assert.equal(panes.gitTabLabel("compare@feature-x..master"), "gitcmp master vs feature", "master sorts first on the label");
  assert.equal(panes.gitTabTitle("compare@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), "gitcmp aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "compare hover keeps the full refs");
  assert.equal(panes.gitTabTitle("compare@cccc..current"), "gitcmp cccc..current", "against-working-tree compare hover keeps its refs");
  assert.equal(panes.gitTabTitle("changes"), "gitchanges", "non-compare hover reuses the tab label");
  panes.paneRoot().tabs.push(panes.gitTabId("compare@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..current"));
  panes.renderWorkspacePanes();
  const full = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok(strip.innerHTML.includes(`title="gitcmp ${full}..current"`), "strip compare button hovers the full compare text");
  assert.ok(strip.innerHTML.includes(`>gitcmp aaaaaaa vs current</span>`), "strip compare label keeps the short hash");

  // branch[Head] labels: the hook answers only when git_ui has the log
  // loaded, and the master-first sort still fires once the [Head] marker
  // is stripped, so a master tip keeps both its position and its marker.
  panesCtx.window.HerdrGitUi = { branchHeadLabel: (ref) => (ref === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ? "master[Head]" : "") };
  assert.equal(panes.gitTabLabel("compare@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..feature-x"), "gitcmp master[Head] vs feature", "branch tip resolves through the hook and master sorts first");
  assert.equal(panes.gitTabLabel("compare@feature-x..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "gitcmp master[Head] vs feature", "master-first applies whichever side carries the tip");
  panesCtx.window.HerdrGitUi = { branchHeadLabel: (ref) => (ref === "cccccccccccccccccccccccccccccccccccccccc" ? "feature[Head]" : "") };
  assert.equal(panes.gitTabLabel("compare@main..cccccccccccccccccccccccccccccccccccccccc"), "gitcmp main vs feature[Head]", "non-master tips keep base-vs-target order");
  delete panesCtx.window.HerdrGitUi;
});

test("openGitTab ensures the tab, hands the open to git_ui, and drops the placeholder when the module is missing", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();

  // Module loaded: openViewTab owns the state; the pane tree records the
  // tab id (git_ui's setActivePaneTab would move the pointer, the stub
  // skips that, so assert the tab lands in the tree and the open fired).
  const git = makeGitStub();
  ctx.window.HerdrGitUi = git;
  await panes.openGitTab("log");
  const root = panes.paneRoot();
  assert.ok(root.tabs.includes("git:log"), "openGitTab pushes the tab id into the tree");
  assert.deepEqual(git.calls, [{ openViewTab: "log" }], "the open went to git_ui");

  // Module missing (load failure): the placeholder tab drops so the
  // strip does not keep a dead tab around.
  delete ctx.window.HerdrGitUi;
  await panes.openGitTab("stash");
  assert.ok(!root.tabs.includes("git:stash"), "failed load drops the placeholder");
  assert.ok(root.tabs.includes("git:log"), "earlier git tab survives");
});

test("closing the active git tab reactivates the neighbor and releases the container", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  const git = makeGitStub();
  ctx.window.HerdrGitUi = git;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();

  // Two git tabs: close the active one, the neighbor git tab reactivates
  // through openGitTab (openViewTab refetches its content).
  await panes.openGitTab("changes");
  await panes.openGitTab("log");
  panes.setActivePaneTab("git:log");
  assert.equal(root.active, "git:log", "pointer sits on the log tab");
  git.calls.length = 0;
  panes.closeGitTab(encodeURIComponent("log"));
  assert.ok(!root.tabs.includes("git:log"), "closed tab drops from the tree");
  assert.equal(root.active, "git:changes", "neighbor git tab reactivates");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(git.calls.filter((c) => c.openViewTab), [{ openViewTab: "changes" }], "reactivation reopens the neighbor view");
  assert.deepEqual(git.calls.filter((c) => c.releaseViewTab), [{ releaseViewTab: "log" }], "close releases the tab's view state");

  // Close the last git tab while a terminal tab lives in the tree: the
  // pointer heals onto the terminal tab.
  panes.closeGitTab(encodeURIComponent("changes"));
  assert.equal(root.active, "tab_2", "pointer heals onto the terminal tab");
});

test("terminal sync keeps git tabs in the tree and prefers them for the healed pointer", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  const git = makeGitStub();
  ctx.window.HerdrGitUi = git;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  await panes.openGitTab("changes");
  panes.setActivePaneTab("git:changes");

  // A backend list change prunes only backend ids; the git tab survives.
  ctx.state.tabs = [{ tab_id: "tab_9" }];
  panes.renderWorkspacePanes();
  assert.deepEqual([...root.tabs], ["git:changes", "tab_9"], "git tab survives the backend prune");

  // A stale active pointer (closed backend panel) heals onto the git tab
  // before falling back to the first tab.
  root.active = "tab_2";
  panes.renderWorkspacePanes();
  assert.equal(root.active, "git:changes", "healed pointer prefers the git tab");
});

// A git tab id belongs to one leaf. A strip click on a non-active pane
// (the W1 live bug: activatePaneTab routed the id to openGitTab, which
// minted a duplicate into the active leaf while the container stayed in
// the owner) must focus the owner and activate there, never duplicate.
test("a git tab click on a non-active pane focuses the owner instead of duplicating", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  const git = makeGitStub();
  ctx.window.HerdrGitUi = git;
  panes.renderWorkspacePanes();

  // Open git:log in the first leaf, split (fresh leaf takes focus),
  // then click the strip's git:log tab from the fresh leaf.
  await panes.openGitTab("log");
  assert.equal(panes.splitPaneRight(), true, "split succeeds");
  const leaves = panes.paneLeaves(panes.paneRoot());
  const owner = leaves.find((leaf) => leaf.tabs.includes("git:log"));
  assert.equal(panes.paneRoot().activePaneId, leaves[1].paneId, "fresh leaf holds the focus");
  assert.notEqual(owner, leaves[1], "git tab lives in the other leaf");

  panes.activatePaneTab("git:log");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = panes.paneLeaves(panes.paneRoot());
  const owners = after.filter((leaf) => leaf.tabs.includes("git:log"));
  assert.equal(owners.length, 1, "no duplicate tab id across leaves");
  assert.equal(owners[0].paneId, owner.paneId, "the tab stays in its owning leaf");
  assert.equal(owners[0].active, "git:log", "owner leaf activates the clicked tab");
  assert.equal(panes.paneRoot().activePaneId, owner.paneId, "focus returns to the owner");
  assert.ok(git.calls.some((call) => call.openViewTab === "log"), "git_ui reopens the view in the owner");

  // Same contract for editor tabs: the id never lands in two leaves.
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  await panes.openEditorTab("src/demo.py");
  const editorLeaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(panes.paneRoot().activePaneId, owner.paneId, "editor opens beside the git tab");
  panes.splitPaneRight();
  const editorRoot2 = panes.paneRoot();
  const freshLeaf = panes.paneLeaves(editorRoot2).find((leaf) => !leaf.tabs.includes("editor:src/demo.py"));
  assert.equal(editorRoot2.activePaneId, freshLeaf.paneId, "fresh leaf takes the focus");
  panes.activatePaneTab("editor:src/demo.py");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const editorAfter = panes.paneLeaves(panes.paneRoot());
  assert.equal(editorAfter.filter((leaf) => leaf.tabs.includes("editor:src/demo.py")).length, 1, "editor id never duplicates");
  const editorOwner = editorAfter.find((leaf) => leaf.tabs.includes("editor:src/demo.py"));
  assert.equal(panes.paneRoot().activePaneId, editorOwner.paneId, "focus returns to the editor owner");

  // A fresh open request for the same file (search result, tree row,
  // open-full-file funnel) rides paneEnsureEditorTab, not the strip
  // click path: it must focus the owner, never mint a second id into
  // another leaf. Split first so the focus sits on a fresh leaf, like
  // the state after a cross-leaf navigation.
  panes.splitPaneRight();
  const beforeReopen = panes.paneLeaves(panes.paneRoot());
  const ownerBefore = beforeReopen.find((leaf) => leaf.tabs.includes("editor:src/demo.py"));
  assert.notEqual(panes.paneRoot().activePaneId, ownerBefore.paneId, "fresh leaf holds focus before the reopen");
  await panes.openEditorTab("src/demo.py");
  const reopenLeaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(reopenLeaves.filter((leaf) => leaf.tabs.includes("editor:src/demo.py")).length, 1, "reopen does not duplicate the editor id");
  assert.equal(panes.paneRoot().activePaneId, ownerBefore.paneId, "reopen focuses the owning leaf");
});

test("paneElementForTab resolves the owning pane element and falls back to the active pane", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  ctx.window.HerdrGitUi = makeGitStub();
  // Render the single-leaf tree first so pane elements exist.
  panes.renderWorkspacePanes();
  const single = panes.paneElementForTab("tab_2");
  assert.ok(single, "terminal tab resolves a pane element");
  assert.equal(single, panes.activePaneElement(), "unrecorded tab falls back to the active pane");

  // Split, then record a git tab in the first leaf while focus sits on
  // the fresh one: the mount target must be the owner's element, not
  // the active leaf's. The container follows its tab even when the
  // active pointer disagrees (focus desync after maximize restore).
  panes.splitPaneRight();
  await panes.openGitTab("changes");
  const ownerLeaf = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.tabs.includes("git:changes"));
  assert.ok(ownerLeaf, "git tab recorded in a leaf");
  panes.paneRoot().activePaneId = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf !== ownerLeaf).paneId;
  panes.renderWorkspacePanes();
  const target = panes.paneElementForTab("git:changes");
  assert.ok(target, "git tab resolves a pane element");
  assert.equal(target.dataset.paneId, ownerLeaf.paneId, "the mount target is the owning pane, not the active one");
  assert.notEqual(target.dataset.paneId, panes.paneRoot().activePaneId, "owner wins even while focus sits elsewhere");
});

// ---- Phase 4: split panes ------------------------------------------------
// The tree model commands: splitRight/splitDown wrap the active leaf in a
// binary split, closeActivePane promotes the sibling (single-child splits
// collapse, the tree never drops below one leaf), and
// moveActiveTabToNextPane carries an editor/git tab between leaves. The
// terminal tab is the singleton surface: it never moves, and closing its
// leaf hands it to the survivor.

test("splitRight wraps the active leaf in a row split and focuses the new leaf", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  assert.equal(panes.splitPaneRight(), true, "split succeeds on a leaf root");
  const next = panes.paneRoot();
  assert.equal(next.kind, "row", "root is now a row split");
  assert.deepEqual([...next.sizes], [1, 1], "fresh split halves the space");
  assert.equal(panes.paneLeaves(next).length, 2, "two leaves");
  assert.equal(next.activePaneId, panes.paneLeaves(next)[1].paneId, "focus sits on the fresh leaf");
  assert.equal(panes.activePane().tabs.length, 0, "new leaf starts empty");

  // The DOM materializes the split: .pane-row wrapper, two panes, one
  // divider between them.
  const rows = nodes.container.querySelectorAll(".pane-row");
  assert.equal(rows.length, 1, "one row split element");
  const panesInDom = nodes.container.querySelectorAll(".workspace-pane");
  assert.equal(panesInDom.length, 2, "both panes render");

  // Splitting again from the active leaf nests a column split inside.
  assert.equal(panes.splitPaneDown(), true, "nested split succeeds");
  const after = panes.paneRoot();
  assert.equal(after.kind, "row", "outer split keeps its direction");
  const nested = after.children.find((child) => child.kind === "column");
  assert.ok(nested, "inner column split wraps the old active leaf");
  assert.equal(panes.paneLeaves(after).length, 3, "three leaves total");
});

test("closeActivePane promotes the sibling and collapses the parent split", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const splitRoot = panes.paneRoot();
  const survivorId = splitRoot.children[0].paneId;

  // Close the fresh (active) leaf: the old leaf is promoted to root.
  assert.equal(await panes.closeActivePane(), true, "close succeeds");
  const root = panes.paneRoot();
  assert.equal(root.kind, "pane", "single-leaf root after collapse");
  assert.equal(root.paneId, survivorId, "the survivor is promoted");
  assert.equal(panes.paneLeaves(root).length, 1, "one leaf left");
  const panesInDom = nodes.container.querySelectorAll(".workspace-pane");
  assert.equal(panesInDom.length, 1, "one pane in the DOM");
  assert.equal(nodes.container.querySelectorAll(".pane-row").length, 0, "split element removed");

  // Closing the last leaf is a no-op: the tree never goes below one.
  assert.equal(await panes.closeActivePane(), false, "root leaf refuses to close");
});

test("closing the terminal leaf hands the terminal tab to the survivor", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();

  // Active leaf is the fresh empty one; switch focus back to the terminal
  // leaf, then close it: the terminal tab must survive somewhere.
  const leaves = panes.paneLeaves(panes.paneRoot());
  const terminalLeaf = leaves.find((leaf) => leaf.tabs.includes("tab_2"));
  panes.activatePaneTab("tab_2");
  assert.ok(terminalLeaf, "terminal leaf found");
  const beforeId = terminalLeaf.paneId;
  assert.equal(await panes.closeActivePane(), true, "close succeeds");
  const root = panes.paneRoot();
  assert.notEqual(root.paneId, beforeId, "the terminal leaf itself is gone");
  assert.ok(root.tabs.includes("tab_2"), "terminal tab handed to the survivor");
  assert.equal(root.active, "tab_2", "survivor activates the terminal tab");
});

test("moveActiveTabToNextPane carries editor tabs and refuses the terminal", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();

  // The registry stub mirrors file_browser's real flow: mount, then
  // setActivePaneTab. Without it the standalone harness's openEditorTab
  // would drop the placeholder (module-failed path).
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };

  // Open an editor tab, split, and move it to the new leaf. The move
  // operates on the active leaf's tab: after the split the fresh leaf is
  // active (and empty), so click the editor tab first, like a real user
  // would before moving it.
  await panes.openEditorTab("src/demo.py");
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  panes.activatePaneTab("editor:src/demo.py");
  // activatePaneTab runs through the async registry round-trip: give the
  // pointer time to land before moving the tab.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panes.moveActiveTabToNextPane(), true, "editor tab moves");
  const from = leaves.find((leaf) => leaf.tabs.includes("editor:src/demo.py"));
  assert.equal(from, leaves[1], "tab landed in the next (fresh) leaf");
  assert.ok(leaves[1].active === "editor:src/demo.py", "target leaf activates the moved tab");
  assert.ok(!leaves[0].tabs.includes("editor:src/demo.py"), "source leaf dropped it");

  // Terminal tabs refuse to move: the singleton stays in its leaf.
  panes.activatePaneTab("tab_2");
  assert.equal(panes.moveActiveTabToNextPane(), false, "terminal tab refuses the move");

  // A single-leaf tree refuses too (nothing to move to).
  const fresh = loadPanesModule(buildDom().document, "ws-2");
  fresh.state.tabs = [{ tab_id: "tab_9" }];
  fresh.state.tab = "tab_9";
  assert.equal(fresh.HerdrWorkspacePanes.moveActiveTabToNextPane(), false, "single leaf refuses");
});

test("normalizePaneTree repairs sizes drift and collapses single-child splits", () => {
  // A drifted tree: sizes shorter than children, a single-child column
  // split, and a missing paneId. The normalize pass must repair all three
  // before the tree renders. Reload itself now starts from a fresh tree.
  const drifted = {
    root: {
      kind: "row",
      sizes: [2],
      children: [
        { kind: "column", children: [{ kind: "pane", tabs: ["tab_2"], active: "tab_2" }] },
        { kind: "pane", tabs: [], active: null },
      ],
    },
  };
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-9");
  const root = ctx.normalizePaneTree(drifted.root);
  assert.equal(root.kind, "row", "row split survives");
  assert.equal(root.children.length, 2, "single-child column collapsed into the row");
  assert.ok(root.children.every((child) => child.kind === "pane"), "only leaves remain");
  assert.equal(root.children[0].tabs.length, 1, "collapsed leaf kept its tabs");
  assert.equal(root.sizes.length, 2, "sizes repaired to match children");
  assert.ok(root.children.every((child) => !!child.paneId), "pane ids assigned");
});

// ---- session-global tree (D1) --------------------------------------------
// One tree per session: the store loads the session entry (or migrates
// the first legacy entry), an all-empty stored tree resets to the default
// pane (D13), and the tree survives a workspace switch unchanged.
test("load imports the stored session tree and keeps foreign workspace ids", () => {
  const stored = JSON.stringify({
    __session__: {
      root: {
        kind: "row",
        sizes: [1, 1],
        activePaneId: "p1",
        children: [
          { kind: "pane", paneId: "p1", tabs: ["tab_2"], active: "tab_2" },
          { kind: "pane", paneId: "p2", tabs: ["tab_9"], active: "tab_9" },
        ],
      },
      at: 123,
    },
  });
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored);
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRootFor();
  assert.equal(root.kind, "row", "stored split restored");
  deepEqual(panes.paneLeaves(root).map((leaf) => [...leaf.tabs]), [["tab_2"], ["tab_9"]], "leaves and ids restored");
  assert.equal(root.activePaneId, "p1", "active pane pointer restored");
});

test("load migrates a legacy per-workspace blob by importing its first entry", () => {
  const stored = JSON.stringify({
    "ws|ws-1": {
      root: { kind: "pane", tabs: ["tab_2"], active: "tab_2" },
      at: 5,
    },
    "ws|ws-2": {
      root: { kind: "pane", tabs: ["tab_7"], active: "tab_7" },
      at: 6,
    },
  });
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored);
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRootFor();
  assert.ok(root.tabs.includes("tab_2"), "first legacy entry imported");
  assert.ok(!root.tabs.includes("tab_7"), "other legacy entries dropped (D1 migration)");
  assert.equal(Object.keys(ctx.state.workspacePanes).length, 1, "only the session entry lives in state");
  assert.ok(ctx.state.workspacePanes["__session__"], "session key used");
});

test("load resets an all-empty stored tree to the single default pane", () => {
  const stored = JSON.stringify({
    __session__: {
      root: {
        kind: "row",
        sizes: [1, 1],
        activePaneId: null,
        children: [
          { kind: "pane", paneId: "p1", tabs: [], active: null },
          { kind: "pane", paneId: "p2", tabs: [], active: null },
        ],
      },
      at: 9,
    },
  });
  const { document } = buildDom();
  const ctx = loadPanesModuleWithStorage(document, "ws-1", stored);
  const panes = ctx.HerdrWorkspacePanes;
  const root = panes.paneRootFor();
  assert.equal(root.kind, "pane", "D13: all-empty tree reset to one leaf");
  assert.deepEqual([...root.tabs], ["terminal"], "reset leaf carries only the boot placeholder");
  assert.equal(root.active, "terminal", "active pointer on the placeholder");
  assert.ok(root.paneId, "reset leaf has a fresh pane id");
});

test("the tree survives a workspace switch (no per-workspace swap)", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panes.renderWorkspacePanes();
  assert.equal(panes.splitPaneRight(), true, "split the tree");
  const root = panes.paneRootFor();
  // Switch the selected workspace: the tree object must stay identical.
  ctx.state.ws = "ws-2";
  const rootAfterSwitch = panes.paneRootFor();
  assert.equal(rootAfterSwitch, root, "same tree object across a workspace switch");
  assert.equal(panes.paneLeaves(rootAfterSwitch).length, 2, "layout survived the switch");
});

// ---- mixed tree: badge (D4/D6) -------------------------------------------
// The badge renders ONLY on a tree hosting multiple workspaces, only on
// leaves whose tabs resolve to exactly one workspace, and the workspace
// always comes from the tab rows, never the hosting workspace.
test("the badge hides on a single-workspace tree and on mixed leaves", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panes.renderWorkspacePanes();
  const root = panes.paneRootFor();
  // Single-workspace tree: no badge anywhere.
  assert.ok(!JSON.stringify(panes.paneLeaves(root).map((leaf) => ctx.HerdrWorkspacePanes.paneWorkspaceBadgeHtml ? ctx.HerdrWorkspacePanes.paneWorkspaceBadgeHtml(leaf) : null)).includes("pane-ws-badge"), "no badge on a single-workspace tree");
  // Mixed tree via the unfiltered map.
  ctx.state.tabsById = { tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "other" } };
  panes.renderWorkspacePanes();
  const leaves = panes.paneLeaves(panes.paneRootFor());
  // Every id resolved a workspace: two ids, one leaf, two workspaces in
  // that leaf -> no badge (ids.length !== 1).
  const badge = ctx.HerdrWorkspacePanes.paneWorkspaceBadgeHtml(leaves[0]);
  assert.equal(badge, "", "no badge on a leaf mixing two workspaces");
});

test("the badge labels a single-workspace leaf on a mixed tree and routes on click", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main", worktree: { repo_name: "herdr", branch: "main" } },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  ctx.state.tabsById = { tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "other" } };
  panes.renderWorkspacePanes();
  assert.equal(panes.splitPaneRight(), true, "split the tree");
  // Arrange each leaf to one workspace's tabs (drag-equivalent state,
  // slice 4 wires the interaction): tab_2 (ws-1) left, tab_9 (ws-2)
  // right.
  const leaves = panes.paneLeaves(panes.paneRootFor());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  const badgeHtml = ctx.HerdrWorkspacePanes.paneWorkspaceBadgeHtml(leaves[1]);
  assert.ok(badgeHtml.includes("pane-ws-badge"), "badge renders on the single-workspace leaf");
  assert.ok(badgeHtml.includes("feat"), "badge carries the workspace label");
  assert.ok(badgeHtml.includes("'switch'"), "badge opens the picker in switch scope");
  assert.ok(badgeHtml.includes(encodeURIComponent(leaves[1].paneId)), "badge addresses its own pane");
  const otherBadge = ctx.HerdrWorkspacePanes.paneWorkspaceBadgeHtml(leaves[0]);
  assert.ok(otherBadge.includes("main"), "sibling leaf badges its own workspace");
});

test("pane-owns-current marks only the selected workspace's pane on a mixed tree", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panes.renderWorkspacePanes();
  // Single-workspace tree: the marker would fire on every pane and
  // carry no information, so it stays off.
  for (const pane of nodes.container.querySelectorAll(".workspace-pane")) {
    assert.ok(!pane.classList.contains("pane-owns-current"), "single-workspace tree carries no marker");
  }
  // Mixed tree, one leaf per workspace: only the selected workspace's
  // pane wears the marker.
  ctx.state.tabsById = { tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "other" } };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRootFor());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  panes.renderWorkspacePanes();
  const marked = nodes.container.querySelectorAll(".workspace-pane").filter((p) => p.classList.contains("pane-owns-current"));
  assert.equal(marked.length, 1, "exactly one pane wears the marker");
  assert.equal(marked[0].dataset.paneId, leaves[0].paneId, "the selected workspace's pane carries it");
  // Switching the selection moves the marker with it.
  ctx.state.ws = "ws-2";
  panes.renderWorkspacePanes();
  const markedAfter = nodes.container.querySelectorAll(".workspace-pane").filter((p) => p.classList.contains("pane-owns-current"));
  assert.equal(markedAfter.length, 1, "still exactly one marker after the switch");
  assert.equal(markedAfter[0].dataset.paneId, leaves[1].paneId, "the marker followed the selection");
});

test("workspaceIdForTab resolves the row's workspace and falls back on a missing row", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  ctx.state.tabsById = { tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "other" } };
  assert.equal(panes.workspaceIdForTab("tab_2"), "ws-1", "filtered row resolves");
  assert.equal(panes.workspaceIdForTab("tab_9"), "ws-2", "unfiltered map row resolves");
  assert.equal(panes.workspaceIdForTab("tab_missing"), "ws-1", "missing row falls back to state.ws");
  assert.equal(panes.workspaceIdForTab(null), "ws-1", "empty id falls back to state.ws");
});

test("the bar + opens the picker with multiple workspaces and stays direct with one", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main" }];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }];
  panes.renderWorkspacePanes();
  // Strips carry only tabs now: the + lives in the bar controls.
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(!strip.innerHTML.includes("pane-new-picker"), "strip carries no + control");
  assert.ok(!strip.innerHTML.includes("newTabForPane"), "strip carries no pane commands");
  let barControls = panes.paneBarControlsHtml();
  assert.ok(!barControls.includes("pane-new-picker"), "single workspace keeps the direct create");
  // A second workspace switches the + to the picker entry (D3).
  ctx.state.workspaces.push({ workspace_id: "ws-2", label: "feat" });
  panes.renderWorkspacePanes();
  barControls = panes.paneBarControlsHtml();
  assert.ok(barControls.includes("pane-new-picker"), "multi-workspace + opens the picker");
  assert.ok(!barControls.includes("newTabForPane('')"), "no empty-pane direct create leak");
});

// ---- Phase 5: maximize + [⋮] pane menu --------------------------------
// The toggle must round-trip without touching the tree: the split stays
// intact, the active pointer follows the maximized leaf, and the render
// swaps between one flat pane and the split layout.
test("maximizeActivePane toggles a leaf without touching the tree", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-10");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);
  assert.equal(leaves.length, 2, "split produced two leaves");

  assert.equal(panes.maximizeActivePane(), true, "split active pane maximizes");
  assert.equal(panes.paneIsMaximized(), true, "maximized flag set");
  assert.equal(root.children.length, 2, "tree untouched while maximized");
  assert.equal(root.activePaneId, leaves[1].paneId, "active pointer follows the maximized leaf");

  // The render shows one flat pane keyed by the maximized leaf.
  const container = document.getElementById("workspacePanes");
  const flat = container.children.find((child) => child.className.split(/\s+/).includes("workspace-pane"));
  assert.ok(flat, "flat pane rendered");
  assert.equal(flat.dataset.paneId, leaves[1].paneId, "flat pane carries the maximized leaf id");

  // Second toggle restores the split layout.
  assert.equal(panes.maximizeActivePane(), true, "second toggle restores");
  assert.equal(panes.paneIsMaximized(), false, "maximized flag cleared");
  const row = container.children.find((child) => child.className.split(/\s+/).includes("pane-row"));
  assert.ok(row, "split layout restored");
});

test("maximizeActivePane refuses single-leaf trees and stale ids heal", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-11");
  const panes = ctx.HerdrWorkspacePanes;
  assert.equal(panes.maximizeActivePane(), false, "single leaf refuses");
  assert.equal(panes.paneIsMaximized(), false, "no flag on refusal");

  // A stale maximizedPaneId (leaf closed while maximized in another
  // session) heals on the next resolve.
  panes.splitPaneRight();
  const entry = panes.panesStateFor();
  entry.maximizedPaneId = "p-nope";
  assert.equal(panes.paneIsMaximized(), false, "stale id reads as not maximized");
  assert.equal(entry.maximizedPaneId, null, "stale id healed to null");
});

test("pane menu items adapt to the active tab kind", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-12");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);

  // Terminal leaf: rename panel entry, no move-file entry. Seed a real
  // terminal tab so paneTerminalTabById resolves the placeholder.
  ctx.state.tabs = [{ tab_id: "tab_7" }];
  const seededLeaf = { ...leaves[0], tabs: ["tab_7"], active: "tab_7" };
  const termItems = ctx.paneMenuItemsFor(seededLeaf, root);
  assert.ok(termItems.some((item) => item.id === "rename-tab"), "terminal menu offers rename");
  assert.ok(!termItems.some((item) => item.id === "move-tab"), "terminal menu hides move-file");
  assert.ok(termItems.some((item) => item.id === "maximize"), "multi-leaf menu offers maximize");
  assert.ok(termItems.some((item) => item.id === "close-pane"), "multi-leaf menu offers close");

  // Editor leaf: move-file entry, no rename entry.
  const editItems = ctx.paneMenuItemsFor({ ...leaves[1], tabs: ["editor:src/main.py"], active: "editor:src/main.py" }, root);
  assert.ok(editItems.some((item) => item.id === "move-tab"), "editor menu offers move-file");
  assert.ok(!editItems.some((item) => item.id === "rename-tab"), "editor menu hides rename");

  // Empty leaf: neither rename nor move; single-leaf trees hide
  // maximize and close entirely.
  const freshCtx = loadPanesModule(buildDom().document, "ws-13");
  const freshRoot = freshCtx.HerdrWorkspacePanes.paneRoot();
  const freshItems = freshCtx.paneMenuItemsFor(freshRoot, freshRoot);
  assert.ok(!freshItems.some((item) => item.id === "maximize"), "single-leaf menu hides maximize");
  assert.ok(!freshItems.some((item) => item.id === "close-pane"), "single-leaf menu hides close");
  assert.ok(!freshItems.some((item) => item.id === "rename-tab"), "empty menu hides rename");
});

test("pane menu keydown: arrows move focus and Escape returns to the button", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-16");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const container = document.getElementById("workspacePanes");
  const row = container.children.find((child) => child.className.split(/\s+/).includes("pane-row"));
  const pane = row.children.find((child) => child.className.split(/\s+/).includes("workspace-pane"));
  const button = makeNode("", "pane-strip-button pane-menu-button");
  pane.appendChild(button);
  ctx.togglePaneMenu(button);
  const menu = document.getElementById("paneMenu");
  assert.ok(menu, "menu opened");
  // Fake DOM innerHTML never materializes children, so attach the menu
  // items the same nodes the click handler would find.
  const items = ["Split right", "Split down", "Maximize pane"].map((label, index) => {
    const item = makeNode("", "pane-menu-item");
    item.dataset.index = String(index);
    item.label = label;
    menu.appendChild(item);
    return item;
  });
  let focused = null;
  for (const item of items) item.focus = () => { focused = item; };
  button.focus = () => { focused = button; };
  document.activeElement = items[0];
  const keydown = (key) => ctx.paneMenuKeydown({ key, preventDefault() {}, stopPropagation() {} });
  keydown("ArrowDown");
  assert.equal(focused, items[1], "ArrowDown moves to the second item");
  document.activeElement = items[1];
  keydown("ArrowUp");
  assert.equal(focused, items[0], "ArrowUp wraps to the first item");
  document.activeElement = items[1];
  keydown("Home");
  assert.equal(focused, items[0], "Home lands on the first item");
  document.activeElement = items[0];
  keydown("End");
  assert.equal(focused, items[items.length - 1], "End lands on the last item");
  keydown("Escape");
  assert.equal(document.getElementById("paneMenu"), null, "Escape closes the menu");
  assert.equal(focused, button, "Escape restores focus to the [⋮] button");
});

test("togglePaneMenu opens, re-click closes, and item actions dispatch", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-14");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  // The fake innerHTML never materializes strip buttons: build the
  // [⋮] node the same way the reconcile builds panes, then attach it to
  // a pane so closest() resolves the pane id.
  const container = document.getElementById("workspacePanes");
  const row = container.children.find((child) => child.className.split(/\s+/).includes("pane-row"));
  const pane = row.children.find((child) => child.className.split(/\s+/).includes("workspace-pane"));
  const button = makeNode("", "pane-strip-button pane-menu-button");
  pane.appendChild(button);
  assert.ok(button, "strip carries the [⋮] button");

  // First click opens the menu on document.body.
  ctx.togglePaneMenu(button);
  let menu = document.getElementById("paneMenu");
  assert.ok(menu, "menu opened");
  assert.equal(menu.attributes["role"], "menu", "menu role set");
  assert.ok(menu.__innerHTML.includes("Maximize pane"), "menu lists maximize");

  // Same button again closes (toggle semantics).
  ctx.togglePaneMenu(button);
  assert.equal(document.getElementById("paneMenu"), null, "re-click closes");

  // Re-open and run the maximize item action the same way the menu's
  // click handler does: close, then dispatch.
  ctx.togglePaneMenu(button);
  menu = document.getElementById("paneMenu");
  assert.ok(menu, "menu re-opened");
  const items = ctx.paneMenuItemsFor(panes.paneLeaves(panes.paneRoot())[1], panes.paneRoot());
  const maximize = items.find((item) => item.id === "maximize");
  assert.ok(maximize, "maximize item present");
  maximize.action();
  assert.equal(panes.paneIsMaximized(), true, "maximize item toggles the flag");
});

test("strip HTML includes the pane menu control and maximize shortcut defaults", () => {
  // Source-level pins: the [⋮] control rides every strip, the default
  // shortcut map gains maximizePane/togglePaneMenu, and the dispatch
  // table wires them.
  const panesSource = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  assert.ok(panesSource.includes("paneMenuControlHtml"), "strip renders the menu control");
  assert.ok(panesSource.includes("function togglePaneMenu"), "toggle entry point exists");
  assert.ok(panesSource.includes("function closePaneMenu"), "close entry point exists");
  const coreSource = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
  assert.ok(coreSource.includes('maximizePane: "Shift+KeyM"'), "maximize shortcut default");
  assert.ok(coreSource.includes('togglePaneMenu: "F10"'), "menu shortcut default");
  const shortcutsSource = readFileSync(new URL("./desktop/app_js/shortcuts.js", import.meta.url), "utf8");
  assert.ok(shortcutsSource.includes("maximizePane: () =>"), "shortcut dispatch wired");
  assert.ok(shortcutsSource.includes("togglePaneMenu: () =>"), "menu shortcut dispatch wired");
});

test("closePaneMenu restores focus through the live button, not a stale ref", () => {
  // Pane strips are innerHTML-swapped on re-renders, so the button ref
  // captured at open time can be detached by close time. Source-level pin:
  // closePaneMenu re-queries the button by pane id before focusing. The
  // behavioral check runs in the live CDP verify (real browser DOM).
  const panesSource = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  assert.ok(panesSource.includes("paneButtonByPaneId"), "close resolves the live button by pane id");
  const closeBody = panesSource.slice(panesSource.indexOf("function closePaneMenu"), panesSource.indexOf("function closePaneMenu") + 1300);
  assert.ok(closeBody.includes("paneButtonByPaneId(paneId)"), "closePaneMenu consults the re-query before the captured ref");
  assert.ok(closeBody.includes("(paneId && paneButtonByPaneId(paneId)) || captured"), "captured ref is only the fallback");
  // Pane destroyed while its menu was open: both the re-query and the
  // captured ref are detached, so focus must fall through to a surviving
  // pane's button instead of a dead node (silent no-op would strand
  // focus on body).
  assert.ok(closeBody.includes('paneButtonByPaneId("*")'), "destroyed-pane fallback resolves a surviving pane's button");
  assert.ok(closeBody.includes("isConnected === false"), "fallback triggers on detached button only");
});

// ---- Phase 5: tab drag between panes -----------------------------------
// The drag pipeline ends in movePaneTabTo: same semantics the drop
// handler runs. D7 lifted the terminal refusal: terminal tabs move
// across leaves, the dragged route tab re-routes so the singleton
// #terminalShell follows (D7.2), and a non-route terminal keeps its
// aux identity (the registry keys per tab, so the re-render
// re-parents the existing container). Editor tabs move across
// leaves at the caret index, and a same-leaf drop at a different
// index reorders.
test("movePaneTabTo moves an editor tab across leaves at the caret index", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-15");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);
  leaves[0].tabs.push("editor:src/a.py", "editor:src/b.py");
  leaves[0].active = "editor:src/a.py";

  // Cross-leaf move: b.py lands at index 0 of the fresh leaf.
  assert.equal(panes.movePaneTabTo("editor:src/b.py", leaves[1].paneId, 0), true, "move accepted");
  assert.deepEqual([...leaves[1].tabs], ["editor:src/b.py"], "target holds the tab at the caret slot");
  assert.ok(!leaves[0].tabs.includes("editor:src/b.py"), "source dropped it");
  assert.equal(leaves[1].active, "editor:src/b.py", "target activates the moved tab");
  assert.equal(root.activePaneId, leaves[1].paneId, "active pointer follows the receiving pane");

  // Same-leaf reorder: a.py before the terminal placeholder slot changes
  // nothing when the caret is effectively at its own position.
  assert.equal(panes.movePaneTabTo("editor:src/a.py", leaves[0].paneId, 0), true, "reorder accepted");
  assert.equal(leaves[0].tabs.indexOf("editor:src/a.py"), 0, "a.py reordered to slot 0");
});

test("movePaneTabTo refuses unknown ids and unknown panes", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-16");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);
  leaves[0].tabs.push("editor:src/x.py");

  assert.equal(panes.movePaneTabTo("editor:src/ghost.py", leaves[1].paneId, 0), false, "unknown tab refuses");
  assert.equal(panes.movePaneTabTo("terminal", leaves[1].paneId, 0), false, "placeholder never moves");
});

test("movePaneTabTo moves a terminal tab and re-routes when it is the route tab", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-17");
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }, { tab_id: "tab_3", workspace_id: "ws-2" }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1" },
    tab_3: { tab_id: "tab_3", workspace_id: "ws-2" },
  };
  ctx.state.tab = "tab_2";
  const routed = [];
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);
  panes.syncTerminalTabsIntoTree(root);
  // Leaf 0 keeps tab_2 (sync target), tab_3 lands wherever the sync
  // placed it: force it into leaf 1 to model the mixed tree.
  leaves[1].tabs.push("tab_3");

  assert.equal(panes.movePaneTabTo("tab_2", leaves[1].paneId, 0), true, "terminal move accepted");
  assert.ok(leaves[1].tabs.includes("tab_2"), "target holds the terminal tab");
  assert.ok(!leaves[0].tabs.includes("tab_2"), "source dropped it");
  assert.equal(leaves[1].active, "tab_2", "target activates the moved terminal");
  assert.deepEqual(routed, [["ws-1", "tab_2"]], "route follows the moved route tab (D7.2), workspace from its own row");
});

test("movePaneTabTo moves a non-route terminal without touching the route", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-18");
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1" }, { tab_id: "tab_3", workspace_id: "ws-1" }];
  ctx.state.tab = "tab_2";
  const routed = [];
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const root = panes.paneRoot();
  const leaves = panes.paneLeaves(root);
  panes.syncTerminalTabsIntoTree(root);
  leaves[0].active = "tab_2";
  leaves[1].tabs.push("tab_3");
  leaves[1].active = "tab_3";

  assert.equal(panes.movePaneTabTo("tab_3", leaves[0].paneId, 1), true, "non-route terminal move accepted");
  assert.ok(leaves[0].tabs.includes("tab_3"), "target holds the moved terminal");
  assert.equal(ctx.state.tab, "tab_2", "route untouched");
  assert.deepEqual(routed, [], "no re-route for a non-route terminal");
});

test("dragged terminal and editor tabs carry draggable attributes in strip html", () => {
  const source = readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8");
  assert.ok(source.includes('draggable="true" ondragstart="paneTabDragStart(event)" ondragend="paneTabDragEnd()"'), "all tab kinds are draggable");
  assert.ok(source.includes('data-tab-kind="terminal"'), "terminal tabs render (D7 drag)");
  assert.ok(/data-tab-kind="terminal"[^>]*draggable="true"/.test(source), "terminal tabs are draggable (D7)");
  assert.ok(source.includes("function paneDropCaretAt"), "caret writer exists");
  assert.ok(source.includes("function paneDropIndexAt"), "index calculator exists");
});

// ---- p6: per-strip controls (split/new/max/close) ------------------------
// The strip controls are per-leaf and view-aware: the split button that
// matches the leaf's current orientation hides, maximize/close hide on
// single-leaf trees, and every control targets the pane whose strip was
// pressed, not the active one.
test("strip controls render per leaf with orientation hiding and split gating", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-20");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();

  // Single-leaf tree: both split buttons render, maximize/close hide
  // (nothing to maximize into or collapse).
  const root = panes.paneRoot();
  const singleSplit = ctx.paneSplitControlsHtml(root);
  assert.ok(singleSplit.includes("splitPaneRightFor"), "flat leaf offers split right");
  assert.ok(singleSplit.includes("splitPaneDownFor"), "flat leaf offers split down");
  assert.equal(ctx.panePaneControlsHtml(root), "", "single leaf hides maximize/close");

  // After splitPaneRight: both leaves sit in a row. tmux model: both
  // buttons stay visible everywhere (right extends the row, down
  // nests a column inside the pressed pane).
  panes.splitPaneRight();
  const rowRoot = panes.paneRoot();
  const leaves = panes.paneLeaves(rowRoot);
  for (const leaf of leaves) {
    const html = ctx.paneSplitControlsHtml(leaf);
    assert.ok(html.includes("splitPaneRightFor"), "row child still offers split right (extend)");
    assert.ok(html.includes("splitPaneDownFor"), "row child offers split down (nest)");
    const paneCtrl = ctx.panePaneControlsHtml(leaf);
    assert.ok(paneCtrl.includes("maximizePaneFor"), "row child offers maximize");
    assert.ok(paneCtrl.includes("closePaneFor"), "row child offers close");
  }

  // New-tab control rides every strip and carries the leaf id.
  for (const leaf of leaves) {
    const html = ctx.paneNewTabControlHtml(leaf);
    assert.ok(html.includes("newTabForPane"), "new-tab control rides the strip");
    assert.ok(html.includes(encodeURIComponent(leaf.paneId)), "control targets its own leaf");
  }
});

test("splitPaneFor extends on the same kind and nests on the other", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-21");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const before = panes.paneLeaves(panes.paneRoot());

  // Pressing split-right on a row child extends the row: a fresh
  // sibling splices in after the pressed leaf, no wrapper changes.
  assert.equal(panes.splitPaneRightFor(before[0].paneId), true, "extend accepted");
  const extended = panes.paneRoot();
  assert.equal(extended.kind, "row", "row stays a row");
  assert.equal(extended.children.length, 3, "a third leaf joined the row");
  assert.equal(extended.children[0].paneId, before[0].paneId, "pressed leaf keeps its slot");
  assert.equal(extended.activePaneId, extended.children[1].paneId, "focus lands on the fresh pane");

  // Pressing split-down on a row child nests instead: the pressed
  // leaf wraps into a fresh column split holding two leaves.
  assert.equal(panes.splitPaneDownFor(before[0].paneId), true, "nested split accepted");
  const nested = panes.paneRoot();
  assert.equal(nested.kind, "row", "outer keeps its direction");
  const inner = nested.children.find((child) => child.kind === "column");
  assert.ok(inner, "inner column split wraps the pressed leaf");
  assert.equal(panes.paneLeaves(nested).length, 4, "four leaves after nesting");
});

test("newTabForPane parks the placement and the sync consumes it once", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-22");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const fresh = leaves[1];

  // Backend panel creation stub: newTab lands the id in state.tabs and
  // routes to it, then the render's sync consumes the placement.
  ctx.window.newTab = async () => {
    ctx.state.tabs.push({ tab_id: "tab_9" });
    ctx.state.tab = "tab_9";
  };
  await panes.newTabForPane(fresh.paneId);
  panes.renderWorkspacePanes();
  const target = panes.paneLeaves(panes.paneRoot());
  const home = target.find((leaf) => leaf.tabs.includes("tab_9"));
  assert.ok(home, "the new panel landed in the tree");
  assert.equal(home.paneId, fresh.paneId, "placement consumed by the pressed leaf");
  assert.equal(home.active, "tab_9", "pressed leaf activates the new panel");

  // Placement consumed exactly once: a second sync tick must not steal
  // the target back (stale __next__ redirect regression).
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  panes.renderWorkspacePanes();
  const homeAfter = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.tabs.includes("tab_9"));
  assert.equal(homeAfter.paneId, fresh.paneId, "second sync keeps the panel homed");
  assert.equal(homeAfter.active, "tab_9", "active pointer survives the second sync");
});

// The no-workspace state: the strip + must not disable, and the press
// must route to the open-workspace/worktree modal instead of dying.
// Standalone harness: the modal and the path resolver come from the rest
// of the bundle, so inject them on the context the way the full app has
// them hoisted.
test("newTabForPane with no workspace opens the seeded discovery flow instead of dying", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, null);
  const panes = ctx.HerdrWorkspacePanes;

  const html = ctx.paneNewTabControlHtml({ paneId: "p1" });
  assert.ok(!html.includes(" disabled"), "the + control stays enabled without a workspace");

  let newTabCalls = 0;
  ctx.window.newTab = async () => {
    newTabCalls++;
  };
  const opens = [];
  ctx.window.HerdrLocationBar = { openDiscoveryForFolder: (path) => opens.push({ path }) };
  ctx.selectedWorkspaceRepoPath = () => "/seed/repo";

  await panes.newTabForPane("p1");
  assert.equal(newTabCalls, 0, "no backend panel is created without a workspace");
  assert.equal(opens.length, 1, "the press opens the discovery flow");
  assert.equal(opens[0].path, "/seed/repo", "discovery seeds the current folder");
});

// Closing a terminal that lives in a non-sync-target leaf must prune it
// there too: the sync target selection picks the leaf holding the first
// live backend id, so a sibling's closed id would otherwise stay in its
// tabs with a dangling active pointer while the strip filter hides it,
// leaving an orphan blank pane.
test("closing a sibling pane's terminal prunes it and heals its active pointer", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-24");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "t1" }, { tab_id: "t2" }];
  ctx.state.tab = "t1";
  panes.renderWorkspacePanes();
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const leafA = leaves[0];
  const leafB = leaves[1];
  // Each leaf owns its terminal, like a "+" from each pane creates.
  leafA.tabs = ["t1"];
  leafA.active = "t1";
  leafB.tabs = ["t2"];
  leafB.active = "t2";
  panes.renderWorkspacePanes();

  // t2 closes: the backend list drops it while the route stays on t1.
  // The emptied split leaf collapses (last tab of that pane closed), so
  // the survivor keeps the screen and the route stays intact.
  ctx.state.tabs = [{ tab_id: "t1" }];
  ctx.state.tab = "t1";
  panes.syncTerminalTabsIntoTree(panes.paneRoot());

  const bAfter = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.paneId === leafB.paneId);
  assert.equal(bAfter, undefined, "emptied split leaf collapsed, no dead pane lingers");
  const aAfter = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.paneId === leafA.paneId);
  assert.ok(aAfter && !aAfter.tabs.includes("t2"), "closed sibling id pruned from the tree");
  assert.equal(aAfter.active, "t1", "survivor keeps its live pointer");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 1, "tree collapsed to the survivor");
});

// Same heal with a surviving editor tab in the sibling: the pointer
// moves to the editor tab instead of null.
test("sibling heal picks a surviving editor tab over null", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-25");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "t1" }, { tab_id: "t2" }];
  ctx.state.tab = "t1";
  panes.renderWorkspacePanes();
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const leafA = leaves[0];
  const leafB = leaves[1];
  leafA.tabs = ["t1"];
  leafA.active = "t1";
  leafB.tabs = ["editor:src/keep.rs", "t2"];
  leafB.active = "t2";
  panes.renderWorkspacePanes();

  ctx.state.tabs = [{ tab_id: "t1" }];
  ctx.state.tab = "t1";
  panes.syncTerminalTabsIntoTree(panes.paneRoot());

  const bAfter = panes.paneLeaves(panes.paneRoot()).find((leaf) => leaf.paneId === leafB.paneId);
  assert.ok(!bAfter.tabs.includes("t2"), "closed terminal id pruned");
  assert.equal(bAfter.active, "editor:src/keep.rs", "pointer heals to the surviving editor tab");
});

test("closePaneFor migrates editor, git, and terminal tabs to the survivor", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-23");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const survivor = leaves[0];
  const closing = leaves[1];

  // All three kinds live in the closing leaf. The registry stubs mirror
  // the real module flow: activateEditorTab/openGitTab call the module's
  // open entry with the path/view-key, and the module calls back
  // setActivePaneTab with the tab id it mounted.
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) { panes.setActivePaneTab("editor:" + path); },
  };
  ctx.window.HerdrGitUi = {
    async openViewTab() { panes.setActivePaneTab("git:commit:main"); },
  };
  closing.tabs.push("editor:src/demo.py", "git:commit:main", "tab_2");
  closing.active = "editor:src/demo.py";
  survivor.tabs = ["editor:src/survivor.py"];
  survivor.active = "editor:src/survivor.py";

  assert.equal(await panes.closePaneFor(closing.paneId), true, "close accepted");
  const after = panes.paneRoot();
  assert.equal(after.kind, "pane", "parent collapsed");
  const migrated = ["editor:src/demo.py", "git:commit:main", "tab_2"];
  for (const id of migrated) {
    assert.ok(after.tabs.includes(id), `migrated tab survived: ${id}`);
  }
  // Dedupe: the survivor's own tab is not duplicated.
  assert.equal(after.tabs.filter((id) => id === "editor:src/survivor.py").length, 1, "survivor tab not duplicated");
  // The survivor keeps its own live active pointer (no clobber).
  assert.equal(after.active, "editor:src/survivor.py", "survivor keeps its active tab");
  assert.notEqual(after.paneId, closing.paneId, "closing leaf gone");
});

test("closePaneFor heals a null survivor pointer to the route terminal tab", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-24");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const survivor = leaves[0];
  const closing = leaves[1];
  closing.tabs.push("tab_2");
  survivor.tabs = [];
  survivor.active = null;

  assert.equal(await panes.closePaneFor(closing.paneId), true, "close accepted");
  const after = panes.paneRoot();
  assert.ok(after.tabs.includes("tab_2"), "terminal tab migrated");
  // The route tab wins the heal when the survivor pointer is null.
  assert.equal(after.active, "tab_2", "null pointer heals to the route terminal tab");
});

test("closePaneFor moves tabs to the edge leaf of a split sibling", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-25");
  const panes = ctx.HerdrWorkspacePanes;
  panes.splitPaneRight();
  const firstId = panes.paneRoot().children[0].paneId;
  // First split-down on the row child nests a column split under it;
  // the second extends that inner column with a third leaf. The
  // closing leaf's sibling is now that inner split: closing hands its
  // tabs to the edge leaf nearest the closing pane (the split's first
  // leaf, because the closing pane sits after it in the row).
  panes.splitPaneDownFor(firstId);
  const rootAfterFirst = panes.paneRoot();
  assert.equal(rootAfterFirst.kind, "row", "row root stays a row");
  panes.splitPaneDownFor(firstId);
  const root = panes.paneRoot();
  assert.equal(root.kind, "row", "row root");
  const inner = root.children.find((child) => child.kind === "column");
  assert.ok(inner, "inner column exists");
  const closingLeaf = root.children.find((child) => child.kind === "pane" && child !== inner);
  assert.ok(closingLeaf, "fresh leaf beside the column split");
  const innerLeaves = panes.paneLeaves(inner);
  const expected = innerLeaves[0];
  closingLeaf.tabs.push("editor:src/x.py");
  assert.equal(await panes.closePaneFor(closingLeaf.paneId), true, "close accepted");
  assert.ok(expected.tabs.includes("editor:src/x.py"), "tabs landed in the nearest edge leaf");
  // The root row held just the inner column and the closing leaf, so
  // closing promotes the column straight into the root slot.
  assert.equal(panes.paneRoot().kind, "column", "inner column promoted to root");
  assert.equal(panes.paneLeaves(panes.paneRoot()).length, 3, "three leaves remain in the promoted column");
});

test("maximizePaneFor toggles the pressed pane and clears on the other pane", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-26");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());

  assert.equal(panes.maximizePaneFor(leaves[0].paneId), true, "first pane maximizes");
  assert.equal(panes.paneIsMaximized(), true, "maximized flag set");
  assert.equal(panes.activePane().paneId, leaves[0].paneId, "active pointer follows the maximized pane");

  // Maximize the OTHER pane while maximized: the flag moves to it.
  assert.equal(panes.maximizePaneFor(leaves[1].paneId), true, "other pane maximizes");
  const entry = panes.panesStateFor();
  assert.equal(entry.maximizedPaneId, leaves[1].paneId, "maximized id moved");

  // Same pane again restores.
  assert.equal(panes.maximizePaneFor(leaves[1].paneId), true, "same pane restores");
  assert.equal(panes.paneIsMaximized(), false, "maximized flag cleared");
});

// ---- p6: shell-owner determinism -----------------------------------------
// The p6 terminal-single-owner seam: exactly one leaf hosts #terminalShell
// per render, chosen deterministically (route leaf, first terminal-active
// leaf, seeded leaf). Sibling terminal leaves never ping-pong the shell,
// and maximize mode resolves the owner among rendered leaves only.
test("one owner hosts the terminal shell across sibling terminal leaves", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-27");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }, { tab_id: "tab_3" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();

  // Force both leaves terminal-active: the route leaf (tab_2) owns the
  // shell, the sibling leaves it alone.
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[1].tabs.push("tab_3");
  leaves[1].active = "tab_3";
  panes.renderWorkspacePanes();
  const ownerLeaf = leaves.find((leaf) => leaf.active === "tab_2");
  const content = findPaneContentForLeaf(nodes, ownerLeaf);
  assert.ok(content, "owner pane rendered");
  assert.equal(nodes.shell.parentNode, content, "shell hosted by the route leaf only");

  // Switch the route to the sibling's tab: the shell follows the route.
  ctx.state.tab = "tab_3";
  panes.renderWorkspacePanes();
  const siblingContent = findPaneContentForLeaf(nodes, leaves.find((l) => l.active === "tab_3"));
  assert.equal(nodes.shell.parentNode, siblingContent, "shell follows the route tab to the sibling");
});

test("maximized mode never parks the shell in a hidden leaf", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-28");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());

  // Maximize the terminal leaf: the route leaf is the rendered max leaf,
  // it owns the shell and hosts it in its content slot.
  const termLeaf = leaves.find((leaf) => leaf.tabs.includes("tab_2"));
  panes.maximizePaneFor(termLeaf.paneId);
  let owner = ctx.HerdrWorkspacePanes.terminalShellOwnerLeaf(panes.paneRoot());
  assert.equal(owner, termLeaf, "route leaf owns the shell while maximized");
  panes.renderWorkspacePanes();
  let termContent = findPaneContentForLeaf(nodes, termLeaf);
  assert.ok(termContent, "maximized terminal pane rendered");
  assert.equal(nodes.shell.parentNode, termContent, "shell hosted by the maximized terminal leaf");

  // Maximize the empty fresh leaf instead: the hidden terminal sibling
  // must NOT own the shell (owner cascade only sees rendered leaves),
  // and the empty maximized pane parks the shell hidden at the
  // persistent home instead of leaving it inside the abandoned split.
  const freshLeaf = leaves.find((leaf) => leaf !== termLeaf);
  panes.maximizePaneFor(freshLeaf.paneId);
  owner = ctx.HerdrWorkspacePanes.terminalShellOwnerLeaf(panes.paneRoot());
  assert.equal(owner, freshLeaf, "owner resolves among rendered leaves only");
  panes.renderWorkspacePanes();
  assert.equal(nodes.shell.parentNode, nodes.container, "shell parked at the persistent home");
  assert.equal(nodes.shell.style.display, "none", "shell hidden behind the empty maximized pane");
});

// A dangling survivor pointer heals to the first migrated tab and
// re-mounts it through the owning module: the git path must round-trip
// through openGitTab, not just sit in the tree.
test("closePaneFor heals a dangling pointer to a migrated git tab and re-mounts it", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-29");
  const panes = ctx.HerdrWorkspacePanes;
  const gitCalls = [];
  ctx.window.HerdrGitUi = {
    async openViewTab(viewKey) { gitCalls.push(String(viewKey)); panes.setActivePaneTab("git:" + viewKey); },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  const survivor = leaves[0];
  const closing = leaves[1];
  survivor.tabs = ["git:changes"];
  survivor.active = "editor:src/gone.py"; // dangling: the tab is not held
  closing.tabs.push("editor:src/demo.py");
  closing.active = "editor:src/demo.py";

  assert.equal(await panes.closePaneFor(closing.paneId), true, "close accepted");
  const after = panes.paneRoot();
  assert.ok(after.tabs.includes("git:changes"), "git tab survived the migration");
  assert.equal(after.active, "git:changes", "dangling pointer healed to the git tab");
  assert.deepEqual(gitCalls, ["changes"], "healed git tab re-mounted through openGitTab");
});

// The bar find control: an editor-active focused leaf renders the ⌕
// button in the bar's pane controls, and clicking it opens find on the
// pane's mounted editor. Terminal and git actives render no find control.
test("bar find control renders for editor tabs and opens the mounted editor", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(!strip.innerHTML.includes("pane-find-button"), "strip carries no find control");
  assert.ok(!panes.paneBarControlsHtml().includes("pane-find-button"), "terminal active renders no find control");

  // Editor tab active: the bar carries the find control.
  root.tabs.push("editor:src/demo.py");
  panes.setActivePaneTab("editor:src/demo.py");
  assert.ok(panes.paneBarControlsHtml().includes("pane-find-button"), "editor active renders the bar find control");

  // A mounted editor inside the pane content slot: openPaneEditorFind must
  // resolve it and hand it to HerdrEditor.openFind.
  const pane = findPaneElementForLeaf(nodes, root);
  const content = pane.querySelector(".pane-content");
  const editorHost = makeNode("pane-editor-demo", "pane-editor-container");
  const editorNode = makeNode("", "herdr-editor");
  editorHost.appendChild(editorNode);
  content.appendChild(editorHost);
  const openFindCalls = [];
  ctx.HerdrEditor = { openFind: (target) => openFindCalls.push(target) };
  panes.openPaneEditorFind(root.paneId);
  assert.equal(openFindCalls.length, 1, "find opened once");
  assert.equal(openFindCalls[0], editorNode, "find opened on the mounted editor");

  // Hidden container (another file inactive in the same pane): the next
  // editor must win, not the hidden one.
  editorHost.style.display = "none";
  const secondHost = makeNode("pane-editor-two", "pane-editor-container");
  const secondEditor = makeNode("", "herdr-editor");
  secondHost.appendChild(secondEditor);
  content.appendChild(secondHost);
  panes.openPaneEditorFind(root.paneId);
  assert.equal(openFindCalls[openFindCalls.length - 1], secondEditor, "visible editor wins over hidden");
});

test("bar find control absent for git tabs", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  root.tabs.push("git:changes");
  panes.setActivePaneTab("git:changes");
  assert.ok(!panes.paneBarControlsHtml().includes("pane-find-button"), "git active renders no find control");
});

// ---- editor open race (Tu2) ---------------------------------------------
// The registry's open awaits a fetch. If the strip ✕ wins the race, the
// tree drops the tab id and closeEditorState tears the per-file state; the
// fetch landing must not resurrect either. The registry stub reproduces
// file_browser.js's real order (guard with editorTabStillOpen semantics:
// the pane tree is the tab identity arbiter, then mount + pointer).
test("an editor close mid-fetch does not resurrect the tab when the fetch lands", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();

  const events = [];
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const closed = new Set();
  ctx.window.HerdrFileBrowser = {
    async openEditorTab(path) {
      events.push(`open:${path}`);
      await gate; // the file fetch is in flight
      // file_browser.js's post-fetch guard: the pane tree owns tab
      // identity, so a closed tab stops here instead of mounting.
      const tabId = panes.editorTabId(path);
      const stillOpen = panes.paneLeaves(panes.paneRoot()).some((leaf) => leaf.tabs.includes(tabId));
      if (!stillOpen) return;
      events.push(`mount:${path}`);
      panes.setActivePaneTab(tabId);
    },
    closeEditorState(path) {
      events.push(`state-closed:${path}`);
      closed.add(path);
    },
    editorFor(path) { return closed.has(path) ? null : { path }; },
  };

  const opened = panes.openEditorTab("src/demo.py");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(root.tabs.includes("editor:src/demo.py"), "placeholder tab sits in the strip while the fetch runs");

  // The ✕ wins the race: the tree drops the id, teardown fires, and the
  // pointer falls back to the terminal tab.
  await panes.closeEditorTab(encodeURIComponent("src/demo.py"));
  assert.ok(!root.tabs.includes("editor:src/demo.py"), "close dropped the tab id mid-fetch");
  assert.ok(closed.has("src/demo.py"), "registry tore the per-file state down");
  assert.equal(root.active, "tab_2", "pointer falls back to the terminal tab");

  releaseFetch();
  await opened;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(!events.includes("mount:src/demo.py"), "the landed fetch never mounts the editor");
  assert.ok(!root.tabs.includes("editor:src/demo.py"), "the closed tab id stays out of the tree");
  assert.equal(root.active, "tab_2", "the pointer stays on the terminal tab");
});

// Helper: the .pane-content slot of the DOM pane keyed by leaf id. The fake
// DOM's querySelector walks children, so the lookup mirrors the real DOM
// contract (one pane element per leaf, keyed by data-pane-id).
function findPaneContentForLeaf(nodes, leaf) {
  const pane = findPaneElementForLeaf(nodes, leaf);
  return pane ? pane.querySelector(".pane-content") : null;
}

function findPaneElementForLeaf(nodes, leaf) {
  const container = nodes.container || nodes.workspacePanes;
  const all = container.querySelectorAll(".workspace-pane");
  for (const pane of all) {
    if (pane.dataset.paneId === leaf.paneId) return pane;
  }
  // Maximized renders one flat pane keyed by the max leaf.
  const first = container.querySelector(".workspace-pane");
  return first && first.dataset.paneId === leaf.paneId ? first : null;
}

// Middle-click close: every tab kind carries an onauxclick that routes to
// the same close path as its ✕ (confirm included), so the middle button
// can never bypass a terminal or dirty-file confirmation.
test("pane strip tabs carry middle-click close routing", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const closed = [];
  ctx.closeEditorTab = async (id) => closed.push(["editor", id]);
  ctx.closeGitTab = (id) => closed.push(["git", id]);
  ctx.closeTab = async (id) => closed.push(["terminal", id]);
  const panes = ctx.HerdrWorkspacePanes;

  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  root.tabs.push("editor:src/readme.md");
  root.tabs.push(panes.gitTabId("status"));
  root.active = "tab_2";
  panes.renderWorkspacePanes();

  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(strip.innerHTML.includes('onauxclick="paneTabAuxClick(event,\'terminal\',\'tab_2\')"'),
    "terminal tab carries the auxclick close");
  assert.ok(strip.innerHTML.includes(`onauxclick="paneTabAuxClick(event,'editor','${encodeURIComponent("src/readme.md")}')"`),
    "editor tab carries the auxclick close");
  assert.ok(strip.innerHTML.includes(`onauxclick="paneTabAuxClick(event,'git','status')"`),
    "git tab carries the auxclick close");

  // The dispatcher only reacts to button 1 (middle); other buttons are
  // ignored, and each kind lands on its own close path.
  ctx.paneTabAuxClick({ button: 0, preventDefault() {}, stopPropagation() {} }, "terminal", "tab_2");
  assert.equal(closed.length, 0, "left click is not a close");
  ctx.paneTabAuxClick({ button: 1, preventDefault() {}, stopPropagation() {} }, "terminal", "tab_2");
  ctx.paneTabAuxClick({ button: 1, preventDefault() {}, stopPropagation() {} }, "editor", encodeURIComponent("src/readme.md"));
  ctx.paneTabAuxClick({ button: 1, preventDefault() {}, stopPropagation() {} }, "git", "status");
  assert.deepEqual(closed.map(([kind]) => kind), ["terminal", "editor", "git"],
    "middle click routes each kind to its close path");
  assert.deepEqual(closed[1], ["editor", encodeURIComponent("src/readme.md")], "editor id stays encoded");
});

// Markdown bar control: the eye button mirrors the focused file's view
// state (preview shows the source toggle, source shows edit, edit shows
// preview). Binary and truncated files get no control.
test("markdown bar control follows the file view state", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const views = [];
  ctx.window.HerdrFileBrowser = {
    editorFor: (path) => (path === "src/readme.md"
      ? { path, editing: false, previewSource: false, binary: false, truncated: false, dirty: false }
      : { path, editing: false, previewSource: false, binary: false, truncated: true, dirty: false }),
    setMarkdownPreview: (path) => views.push(["preview", path]),
    setMarkdownSource: (path) => views.push(["source", path]),
    setMarkdownEdit: (path) => views.push(["edit", path]),
  };
  ctx.window.HerdrEditor = { isMarkdownPath: (path) => /\.md$/.test(path) };
  const panes = ctx.HerdrWorkspacePanes;

  ctx.state.tabs = [{ tab_id: "tab_2" }];
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  root.tabs.push("editor:src/readme.md");
  root.tabs.push("editor:src/huge.md");
  root.active = "editor:src/readme.md";
  panes.renderWorkspacePanes();

  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(!strip.innerHTML.includes("paneMarkdownSource"), "strip carries no markdown control");
  assert.ok(panes.paneBarControlsHtml().includes("paneMarkdownSource('src%2Freadme.md')"),
    "preview state offers the source view");

  // Source state offers edit; edit state offers preview. The eye is
  // active-tab only, and the truncated file never gets one at all.
  ctx.window.HerdrFileBrowser.editorFor = (path) => (path === "src/readme.md"
    ? { path, editing: false, previewSource: true, binary: false, truncated: false, dirty: false }
    : { path, editing: false, previewSource: false, binary: false, truncated: true, dirty: false });
  root.active = "editor:src/huge.md";
  panes.renderWorkspacePanes();
  assert.ok(!panes.paneBarControlsHtml().includes("paneMarkdownEdit"), "truncated markdown shows no edit toggle");
  assert.ok(!panes.paneBarControlsHtml().includes("paneMarkdownSource"), "truncated markdown shows no eye at all");
  root.active = "editor:src/readme.md";
  panes.renderWorkspacePanes();
  assert.ok(panes.paneBarControlsHtml().includes("paneMarkdownEdit('src%2Freadme.md')"),
    "source state offers edit");

  ctx.window.HerdrFileBrowser.editorFor = (path) => ({ path, editing: true, previewSource: false, binary: false, truncated: false, dirty: false });
  panes.renderWorkspacePanes();
  assert.ok(panes.paneBarControlsHtml().includes("paneMarkdownPreview('src%2Freadme.md')"),
    "edit state offers the preview");

  // The strip dispatchers forward to the registry API.
  ctx.paneMarkdownSource(encodeURIComponent("src/readme.md"));
  ctx.paneMarkdownEdit(encodeURIComponent("src/readme.md"));
  ctx.paneMarkdownPreview(encodeURIComponent("src/readme.md"));
  assert.deepEqual(views, [
    ["source", "src/readme.md"],
    ["edit", "src/readme.md"],
    ["preview", "src/readme.md"],
  ], "strip dispatchers land on the registry view setters");
});

// ---- slice 4: D7.1 duplicate repair ---------------------------------------
// A mid-drag crash or a stale stored tree can leave one terminal id in
// two leaves. The repair keeps the first owner in tree order, drops the
// later copies, and collapses a leaf the repair emptied inside a split.
test("sync repairs a duplicated terminal id: first leaf wins, emptied leaf collapses", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-40");
  ctx.state.tabs = [{ tab_id: "t1" }, { tab_id: "t2" }];
  ctx.state.tab = "t1";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["t1", "t2"];
  leaves[0].active = "t1";
  leaves[1].tabs = ["t2", "editor:src/keep.py"];
  leaves[1].active = "t2";

  panes.syncTerminalTabsIntoTree(panes.paneRoot());

  const after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 2, "leaf with an editor tab survives");
  const first = after[0];
  const second = after[1];
  assert.deepEqual([...first.tabs], ["t1", "t2"], "first leaf in tree order keeps the id");
  assert.deepEqual([...second.tabs], ["editor:src/keep.py"], "duplicate drops, editor tab stays");
  assert.equal(second.active, "editor:src/keep.py", "pointer heals to a surviving tab");
});

test("sync repair collapses a leaf the repair emptied", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-41");
  ctx.state.tabs = [{ tab_id: "t1" }, { tab_id: "t2" }];
  ctx.state.tab = "t1";
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // t2 duplicated into the second leaf, which holds nothing else: the
  // repair drops its copy and the leaf collapses (no blank pane).
  leaves[0].tabs = ["t1", "t2"];
  leaves[0].active = "t1";
  leaves[1].tabs = ["t2"];
  leaves[1].active = "t2";

  panes.syncTerminalTabsIntoTree(panes.paneRoot());

  const after = panes.paneLeaves(panes.paneRoot());
  assert.equal(after.length, 1, "emptied duplicate leaf collapsed");
  assert.deepEqual([...after[0].tabs], ["t1", "t2"], "survivor holds both ids once");
});

// ---- slice 4: D3 card-to-strip speed path ---------------------------------
test("workspace card dragover shows the open-here hint on the hovered strip", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-42");
  ctx.state.workspaces = [{ workspace_id: "ws-42", label: "main" }];
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  ctx.state.dragWorkspace = "ws-42";
  const pane = document.body.querySelector(".workspace-pane");
  const strip = pane.querySelector(".pane-tab-strip");

  panes.paneStripDragOver({ target: strip, clientX: 0, preventDefault() {}, dataTransfer: { dropEffect: null } });

  const hint = strip.children.find((child) =>
    child.className.split(/\s+/).includes("pane-ws-drop-hint"));
  assert.ok(hint, "hint node renders on the strip");
  assert.equal(hint.textContent, "Open terminal: main here", "hint names the workspace");
});

test("workspace card drop opens the terminal in that workspace and cleans drag state", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-43");
  ctx.state.workspaces = [{ workspace_id: "ws-src", label: "side" }];
  const posted = [];
  const routed = [];
  ctx.api = async (url, opt) => {
    posted.push([url, JSON.parse(opt.body)]);
    return { result: { tab: { tab_id: "tab_new" } } };
  };
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // The strip-level wiring calls the exported entry; mirror the card
  // drag state the sidebar sets.
  ctx.state.dragWorkspace = "ws-src";
  const pane = document.body.querySelectorAll(".workspace-pane")[1];
  const strip = pane.querySelector(".pane-tab-strip");
  const dimmed = makeNode("", "workspace-card workspace-drag");
  document.body.appendChild(dimmed);

  panes.paneStripDrop({ target: strip, preventDefault() {}, dataTransfer: null });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(posted, [["/api/tabs", { workspace_id: "ws-src" }]], "panel created in the dragged workspace");
  assert.deepEqual(routed, [["ws-src", "tab_new"]], "route lands on the new panel");
  assert.equal(ctx.state.dragWorkspace, null, "drag state cleared");
  assert.ok(!dimmed.className.includes("workspace-drag"), "card drag class cleared");
  // The placement landed: the next sync homes the fresh id in the
  // dropped pane's leaf (observable through the tree, not the map).
  ctx.state.tabs.push({ tab_id: "tab_new" });
  panes.syncTerminalTabsIntoTree(panes.paneRoot());
  assert.ok(leaves[1].tabs.includes("tab_new"), "pending placement homed the new tab in the dropped pane");
});

test("openPanelInWorkspace registers the placement, posts, and routes", async () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-44");
  const posted = [];
  const routed = [];
  ctx.api = async (url, opt) => {
    posted.push([url, JSON.parse(opt.body)]);
    return { result: { tab: { tab_id: "tab_7" } } };
  };
  ctx.go = (ws, tab) => routed.push([ws, tab]);
  const panes = ctx.HerdrWorkspacePanes;
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());

  await panes.openPanelInWorkspace("ws-9", leaves[1].paneId);
  ctx.state.tabs.push({ tab_id: "tab_7" });
  panes.syncTerminalTabsIntoTree(panes.paneRoot());

  assert.deepEqual(posted, [["/api/tabs", { workspace_id: "ws-9" }]], "panel created in the target workspace");
  assert.deepEqual(routed, [["ws-9", "tab_7"]], "route carries the new tab");
  assert.ok(leaves[1].tabs.includes("tab_7"), "placement homed the new tab in the requested pane");
});

// ---- default-label workspace prefix (D15) ------------------------------
// Mixed-tree regression: default panel labels number inside their own
// workspace, so a foreign panel's "1" next to the selected workspace's
// "1" read as one series. Foreign default panels carry the worktree/
// workspace name before their number; the selected workspace's own
// numbers stay bare; custom names never get a prefix.

test("foreign default panels prefix the worktree name on a mixed tree", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main", worktree: { repo_name: "herdr", branch: "main" } },
    { workspace_id: "ws-2", label: "feat", worktree: { repo_name: "herdr", branch: "feat/panels" } },
  ];
  // worktreeDisplayName lives in the shared bundle (render.js), so the
  // module-scope test stubs it; this pins the exact string the strip's
  // accessible name and data-ws-prefix attribute carry.
  ctx.worktreeDisplayName = (w) => ctx.state.workspaceBranches[w.workspace_id] || w.label;
  ctx.state.workspaceBranches = { "ws-2": "feat/panels" };
  // Selected workspace's row rides state.tabs; the foreign row rides the
  // unfiltered map (exactly the filtered-snapshot shape the sync sees).
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  panes.renderWorkspacePanes();

  const strips = nodes.container.querySelectorAll(".pane-tab-strip");
  const ownLabel = strips[0].innerHTML;
  const foreignLabel = strips[1].innerHTML;
  // Own workspace: bare number, no prefix machinery in the markup.
  assert.ok(ownLabel.includes('data-tab-id="tab_2"'), "own panel renders");
  assert.match(ownLabel, /<span class="pane-tab-label">1<\/span>/, "own default panel stays a bare number");
  assert.ok(!ownLabel.includes("data-ws-prefix"), "own panel carries no prefix attribute");
  assert.match(ownLabel, /aria-label="Panel 1"/, "own button names itself Panel 1");
  // Foreign workspace: prefix attribute with the worktree name, number
  // as the span text, and the full string as the accessible name.
  assert.ok(foreignLabel.includes('data-tab-id="tab_9"'), "foreign panel renders");
  assert.ok(foreignLabel.includes('data-ws-prefix="feat/panels"'), "foreign panel carries the worktree name");
  assert.match(foreignLabel, /<span class="pane-tab-label" data-ws-prefix="feat\/panels">1<\/span>/, "foreign number renders bare with the prefix beside it");
  assert.match(foreignLabel, /aria-label="Panel feat\/panels 1"/, "foreign accessible name spells the origin");
});

test("foreign prefixes flip with the selected workspace and skip custom names", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-2");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_c: { tab_id: "tab_c", workspace_id: "ws-1", label: "build", number: 2 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_9", "tab_2", "tab_c"];
  leaves[0].active = "tab_9";
  panes.renderWorkspacePanes();

  // Selected workspace (ws-2) keeps the bare number; ws-1's default
  // panel prefixes; ws-1's custom name never prefixes.
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.match(strip.innerHTML, /<span class="pane-tab-label">1<\/span>/, "selected workspace default stays bare");
  assert.ok(strip.innerHTML.includes('data-ws-prefix="main"'), "ws-1 default prefixes with its label");
  assert.match(strip.innerHTML, /<span class="pane-tab-label">build<\/span>/, "custom name renders unprefixed");
  assert.ok(!strip.innerHTML.includes('data-ws-prefix="build"'), "custom tab carries no prefix attribute");

  // Switch the selection: ws-2's panel takes the prefix, ws-1's goes bare.
  ctx.state.ws = "ws-1";
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  panes.renderWorkspacePanes();
  const stripAfter = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(stripAfter.innerHTML.includes('data-ws-prefix="feat"'), "ws-2 default prefixes after the switch");
  assert.match(stripAfter.innerHTML, /<span class="pane-tab-label">1<\/span>/, "ws-1 default goes bare after the switch");
});

test("single-workspace trees and unknown foreign workspaces keep bare numbers", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main" }];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  panes.renderWorkspacePanes();
  let strip = nodes.container.querySelector(".pane-tab-strip");
  assert.match(strip.innerHTML, /<span class="pane-tab-label">1<\/span>/, "single-workspace tree keeps bare numbers");
  assert.ok(!strip.innerHTML.includes("data-ws-prefix"), "no prefix machinery on a clean tree");

  // Foreign row whose workspace record is missing (snapshot race): the
  // label keeps the bare number instead of a misleading or empty prefix.
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_x: { tab_id: "tab_x", workspace_id: "ws-gone", label: "shell", number: 3 },
  };
  panes.renderWorkspacePanes();
  strip = nodes.container.querySelector(".pane-tab-strip");
  assert.match(strip.innerHTML, /<span class="pane-tab-label">3<\/span>/, "unknown workspace keeps the bare number");
  assert.ok(!strip.innerHTML.includes("data-ws-prefix"), "no prefix when the workspace record is missing");
});

test("pane menu rename seeds empty for defaults and the name for customs", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [
    { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    { tab_id: "tab_c", workspace_id: "ws-1", label: "build", number: 2 },
  ];
  // panelRenameInitialLabel is a module function; expose it on the ctx
  // before the render so paneTabButtonHtml's inline rename wiring can
  // resolve it (the loadPanesModule stub starts with a fake).
  ctx.panelRenameInitialLabel = (tab) => panes.panelRenameInitialLabel(tab);
  panes.renderWorkspacePanes();
  const root = panes.paneRoot();
  const defaultItems = panes.paneMenuItemsFor(root, root);
  const renameDefault = defaultItems.find((item) => item.id === "rename-tab");
  assert.ok(renameDefault, "default terminal tab offers rename");
  // panelRenameInitialLabel comes from the module; the pane menu passes
  // it to startTabRename, so a default seeds "" (fresh name) and a
  // custom seeds its own name.
  assert.equal(panes.panelRenameInitialLabel(ctx.state.tabs[0]), "");
  assert.equal(panes.panelRenameInitialLabel(ctx.state.tabs[1]), "build");
});

test("a slash branch name rides the prefix attribute through escapeAttr", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.worktreeDisplayName = (w) => (w.workspace_id === "ws-2" ? "feature/slash-branch name" : w.label);
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 2 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  panes.renderWorkspacePanes();
  const strips = nodes.container.querySelectorAll(".pane-tab-strip");
  const foreign = strips[1].innerHTML;
  // "/" and spaces survive the attribute round trip; the number stays
  // the span text; the accessible name carries the full string.
  assert.ok(foreignLabelAttr(foreign, "feature/slash-branch name"), "slash branch rides data-ws-prefix");
  assert.match(foreign, /<span class="pane-tab-label" data-ws-prefix="feature\/slash-branch name">2<\/span>/, "number stays the span text");
  assert.match(foreign, /aria-label="Panel feature\/slash-branch name 2"/, "accessible name carries the full string");
});

function foreignLabelAttr(html, value) {
  return html.includes(`data-ws-prefix="${value}"`);
}

// A row the tree references but neither state.tabs nor tabsById resolves
// (older server without the map, or a snapshot race): the strip must not
// render a broken button. paneTerminalTabButtonHtml answers null with "",
// so nothing shows and no prefix machinery runs for the ghost id.
test("unresolvable tab rows render nothing instead of a broken button", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_ghost"];
  leaves[1].active = "tab_ghost";
  panes.renderWorkspacePanes();

  const strips = nodes.container.querySelectorAll(".pane-tab-strip");
  const ghostStrip = strips[1].__innerHTML;
  assert.ok(!ghostStrip.includes('data-tab-id="tab_ghost"'), "unresolvable row renders no terminal button");
  assert.ok(!ghostStrip.includes("data-ws-prefix"), "no prefix for a row that resolves nothing");
  // The null-row exit is the same guard the strip filter relies on. The
  // prune already collapsed the ghost leaf (unknown ids drop from every
  // leaf, an emptied leaf inside a split collapses), so only the
  // resolvable leaf survives: its tree tabs keep the live id.
  const leavesAfter = panes.paneLeaves(panes.paneRoot());
  assert.equal(leavesAfter.length, 1, "ghost-emptied leaf collapsed");
  // vm arrays are cross-realm: the loose deepEqual tolerates that, the
  // strict one does not (same reason the older tests use the named import).
  deepEqual(panes.paneTabsForTree(leavesAfter[0]), ["tab_2"], "resolvable id stays in the tree tabs");
});

// foreignWorkspacePrefix guards, one assertion per exit: a row with no
// workspace_id inherits state.ws (own workspace, bare), a foreign id with
// no workspace record keeps the bare number, and a workspace whose name
// chain (worktreeDisplayName then label) is empty keeps the bare number
// too. An empty prefix must never render as an empty attribute.
test("prefix fallback matrix: no workspace id, missing record, empty name", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_noid: { tab_id: "tab_noid", label: "shell", number: 4 },
    tab_gone: { tab_id: "tab_gone", workspace_id: "ws-gone", label: "shell", number: 5 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2", "tab_noid", "tab_gone"];
  leaves[0].active = "tab_2";
  panes.renderWorkspacePanes();

  // No workspace_id on the row: the state.ws fallback makes it own, bare.
  assert.equal(panes.foreignWorkspacePrefix("tab_noid"), "", "row without workspace id stays bare");
  // Unknown foreign workspace: no record, no display name, bare number.
  assert.equal(panes.foreignWorkspacePrefix("tab_gone"), "", "missing workspace record stays bare");
  assert.equal(panes.panelVisibleLabel(ctx.state.tabsById.tab_noid, 3), "4", "visible label falls back to the number");
  assert.equal(panes.panelVisibleLabel(ctx.state.tabsById.tab_gone, 4), "5", "unknown workspace keeps the bare number");

  // Workspace record with every name source empty: bare number, and the
  // strip never renders an empty prefix attribute.
  ctx.state.workspaces.push({ workspace_id: "ws-3" });
  ctx.state.tabsById.tab_e = { tab_id: "tab_e", workspace_id: "ws-3", label: "shell", number: 6 };
  leaves[0].tabs.push("tab_e");
  panes.renderWorkspacePanes();
  assert.equal(panes.foreignWorkspacePrefix("tab_e"), "", "empty name chain keeps the bare number");
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(strip.__innerHTML.includes('<span class="pane-tab-label">6</span>'), "nameless workspace renders a bare number");
  assert.ok(!strip.__innerHTML.includes('data-ws-prefix=""'), "no empty prefix attribute ever renders");
});

// The workspace label carries the prefix when the worktree display name
// chain yields nothing (a workspace without a worktree or branch entry
// keeps its configured label as the origin cue).
test("a foreign workspace without a worktree prefixes with its label", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  // No worktreeDisplayName stub and no worktree fields: the label is the
  // only name source left.
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  panes.renderWorkspacePanes();

  assert.equal(panes.foreignWorkspacePrefix("tab_9"), "feat ", "label is the prefix without a worktree");
  assert.equal(panes.panelVisibleLabel(ctx.state.tabsById.tab_9, 0), "feat 1");
  const strips = nodes.container.querySelectorAll(".pane-tab-strip");
  assert.ok(strips[1].__innerHTML.includes('data-ws-prefix="feat"'), "strip carries the label prefix");
});

// panelNumberLabel fallbacks, pinned directly: the tree may hold rows the
// backend never numbered (a stored tree restored before the tabs snapshot
// lands). A finite positive number wins; without one the index (or the
// tabs lookup when the index is unknown) numbers the tab; a miss on both
// renders 1 rather than NaN or "undefined".
test("panelNumberLabel falls back to index and then to the tabs position", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [
    { tab_id: "t1", label: "shell", number: 1 },
    { tab_id: "t2", label: "shell", number: 2 },
    { tab_id: "t3", label: "shell" },
  ];
  assert.equal(panes.panelNumberLabel({ label: "shell", number: 3 }, 2), "3", "finite positive number wins");
  assert.equal(panes.panelNumberLabel({ label: "shell", number: 0 }, 1), "2", "zero is not a panel number, index wins");
  assert.equal(panes.panelNumberLabel({ label: "shell", number: -1 }, 1), "2", "negative falls back to index");
  assert.equal(panes.panelNumberLabel({ label: "shell", number: "x" }, 1), "2", "non-numeric falls back to index");
  assert.equal(panes.panelNumberLabel({ label: "shell" }, 1), "2", "missing number uses the index");
  assert.equal(panes.panelNumberLabel(ctx.state.tabs[2], undefined, ctx.state.tabs), "3", "unknown index resolves through tabs");
  assert.equal(panes.panelNumberLabel({ tab_id: "nope", label: "shell" }, undefined, ctx.state.tabs), "1", "full miss renders 1");
  assert.equal(panes.panelVisibleLabel({ tab_id: "t2", label: "tab 9", number: 9 }, 1), "9", "backend default \"tab N\" renders as N");
});

// Editor and git tabs never carry the prefix machinery: they are not
// panels, the file name or view name is the identity, and paneTabButtonHtml
// (the prefix renderer) is only on the terminal kind. On a mixed tree the
// strip renders all three kinds together, so this pins the kind routing.
test("editor and git tabs stay unprefixed on a mixed tree", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  // ws-2's row only lives in the unfiltered map, so the strip filter
  // (paneTabsForTree -> terminalTabKnown) must accept it before the
  // prefix question even arises: this pins the kind routing on the same
  // filtered-snapshot shape the sync sees. allTabs keeps the row alive
  // across the per-leaf sync (ws-1's panel list would otherwise drop a
  // foreign id from every leaf).
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 2 },
  };
  ctx.state.allTabs = [{ tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 2 }];
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  // Sync seeded leaf 1 with the placeholder, and the placeholder splice
  // already pulled tab_9 (via allTabs) into leaf 0. The editor and git ids
  // join leaf 1 (client-owned ids, exactly how paneEnsureEditorTab /
  // paneEnsureGitTab enter the tree), leaving all three kinds split across
  // the two strips: the D7.1 one-home rule keeps tab_9 in leaf 0.
  leaves[1].tabs = ["editor:src/feature.py", "git:changes"];
  leaves[1].active = "editor:src/feature.py";
  panes.renderWorkspacePanes();

  const strips = nodes.container.querySelectorAll(".pane-tab-strip");
  const foreign = Array.from(strips).find((s) => s.__innerHTML.includes('data-tab-id="tab_9"'));
  assert.ok(foreign, "foreign default panel renders");
  const editorAndGit = Array.from(strips).find((s) => s.__innerHTML.includes('data-tab-kind="editor"'));
  assert.ok(editorAndGit, "editor and git tabs render");
  // Foreign default panel prefixes; the editor and git rows never do:
  // paneTabButtonHtml renders the prefix, the other two kinds never touch
  // it.
  assert.ok(foreign.__innerHTML.includes('data-ws-prefix="feat"'), "foreign default panel carries the prefix");
  assert.ok(!editorAndGit.__innerHTML.includes("data-ws-prefix"), "editor and git rows carry no prefix attribute");
  assert.ok(editorAndGit.__innerHTML.includes('data-tab-kind="git"'), "git tab renders beside the editor tab");
});

// Rename input (the paneTabButtonHtml editing branch) lives in app_load's
// suite (inputAttrs ships with shared/core.js, which only that bundle loads).
// Here the same branch is pinned at the function level: a default panel
// seeds "" and a custom panel seeds its own name, the exact strings the
// strip's ondblclick hands to startTabRename.
test("panelRenameInitialLabel seeds empty for defaults and the name for customs", () => {
  const { document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.tabs = [
    { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    { tab_id: "tab_c", workspace_id: "ws-1", label: "build", number: 2 },
  ];
  ctx.panelRenameInitialLabel = (tab) => panes.panelRenameInitialLabel(tab);
  assert.equal(panes.panelRenameInitialLabel(ctx.state.tabs[0]), "", "default panel seeds a fresh name");
  assert.equal(panes.panelRenameInitialLabel(ctx.state.tabs[1]), "build", "custom panel seeds its name");
  // The strip wires the seed into the double-click handler.
  ctx.state.tab = "tab_2";
  panes.renderWorkspacePanes();
  const strip = nodesStripHtml(ctx, panes);
  assert.ok(strip.includes("startTabRename('tab_c','build')"), "custom tab's double-click seeds its name");
  assert.ok(strip.includes("startTabRename('tab_2','')"), "default tab's double-click seeds empty");
});

function nodesStripHtml(ctx, panes) {
  const root = panes.paneRoot();
  const first = panes.paneLeaves(root)[0];
  const paneEl = paneElementFor(ctx, first);
  return paneEl.querySelector(".pane-tab-strip").__innerHTML;
}

function paneElementFor(ctx, leaf) {
  const el = ctx.el("workspacePanes");
  const panes = Array.from(el.querySelectorAll(".workspace-pane"));
  return panes.find((p) => p.dataset.paneId === leaf.paneId) || panes[0];
}

// The prefix must reach the rail too: a maximized leaf hides its
// siblings, and the rail re-renders their strips through renderLeafInto,
// so the paneTabButtonHtml prefix path must run there as well. A user who
// maximizes a foreign panel and reads the rail must see the same origin
// cue as the normal layout, or the rail reads as a different app.
test("the maximized-pane rail keeps the foreign prefix on sibling strips", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main" },
    { workspace_id: "ws-2", label: "feat" },
  ];
  ctx.state.tabs = [{ tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 }];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
  };
  panes.renderWorkspacePanes();
  panes.splitPaneRight();
  const leaves = panes.paneLeaves(panes.paneRoot());
  leaves[0].tabs = ["tab_2"];
  leaves[0].active = "tab_2";
  leaves[1].tabs = ["tab_9"];
  leaves[1].active = "tab_9";
  panes.renderWorkspacePanes();

  assert.equal(panes.maximizePaneFor(leaves[0].paneId), true, "maximize accepted");
  const rails = nodes.container.querySelectorAll(".pane-strip-rail");
  assert.equal(rails.length, 1, "rail holds the hidden sibling");
  const stub = rails[0].querySelector(".workspace-pane");
  const strip = stub.querySelector(".pane-tab-strip");
  assert.ok(strip, "rail renders the sibling strip");
  assert.ok(strip.__innerHTML.includes('data-ws-prefix="feat"'), "rail strip carries the foreign prefix");
  assert.ok(strip.__innerHTML.includes('<span class="pane-tab-label" data-ws-prefix="feat">1</span>'), "rail strip renders number plus prefix");
  assert.ok(strip.__innerHTML.includes('aria-label="Panel feat 1"'), "rail accessible name spells the origin");

  panes.maximizePaneFor(leaves[0].paneId);
});

// Mixed tree at the placement layer: the one-home rule routes a foreign
// default tab into the single leaf via state.tabs, and the strip answers
// with the worktree prefix (label semantics from workspace_panes, the
// same language the tab bar speaks).
test("mixed tree renders the one-home foreign tab with its prefix", () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanesModule(document, "ws-1");
  const panes = ctx.HerdrWorkspacePanes;
  ctx.state.ws = "ws-1";
  ctx.state.workspaces = [
    { workspace_id: "ws-1", label: "main", worktree: { repo_name: "herdr", branch: "main" } },
    { workspace_id: "ws-2", label: "feat", worktree: { repo_name: "herdr", branch: "feat/panels" } },
  ];
  ctx.state.tabs = [
    { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
  ];
  ctx.state.tabsById = {
    tab_2: { tab_id: "tab_2", workspace_id: "ws-1", label: "shell", number: 1 },
    tab_9: { tab_id: "tab_9", workspace_id: "ws-2", label: "shell", number: 1 },
  };
  panes.renderWorkspacePanes();

  const leaves = panes.paneLeaves(panes.paneRoot());
  assert.equal(leaves.length, 1, "one-home rule keeps a single leaf");
  deepEqual(leaves[0].tabs, ["tab_2", "tab_9"], "foreign tab rides the same leaf via state.tabs");
  const strip = nodes.container.querySelector(".pane-tab-strip");
  assert.ok(strip.__innerHTML.includes('<span class="pane-tab-label" data-ws-prefix="feat">1</span>'), "strip spells the prefix plus number");
  assert.ok(strip.__innerHTML.includes('aria-label="Panel feat 1"'), "strip accessible name spells the origin");
});
