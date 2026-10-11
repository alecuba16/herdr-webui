// Phase 2 regression test for the right sidebar host module
// (desktop/app_js/right_sidebar.js). Pins the hosting contract the drawers
// rely on:
//   - openView claims a drawer panel (created on demand through the
//     ensurePanel factory) into #rightSidebarContent and remembers the
//     per-workspace shell mode, without touching the global collapse flag.
//   - Temp overlay suppression (HerdrTempOverlays.suppressingGit/Files)
//     declines the claim: the panel stays where the overlay put it and the
//     workspace mode is untouched.
//   - Phase 3c removed the center handoff: git main views render into
//     center pane tabs, so the host module no longer ships a release
//     function and the hosted panel never leaves the column.
//   - applyRightSidebarHost toggles the column visibility from mode +
//     collapse + visible children, and always keeps the terminal visible
//     (the m1/m2 contract; the old drawer swap hid it).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    hidden: false,
    attributes: {},
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
    insertBefore(child, ref) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      const at = node.children.indexOf(ref);
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
  };
  Object.defineProperty(node, "childNodes", {
    get() {
      return node.children;
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
  const body = makeNode("body", "");
  const app = makeNode("app", "");
  const rail = makeNode("rightSidebarRail", "right-sidebar-rail");
  const content = makeNode("rightSidebarContent", "right-sidebar-content");
  const shell = makeNode("terminalShell", "terminal-shell");
  app.appendChild(rail);
  app.appendChild(content);
  app.appendChild(shell);
  body.appendChild(app);
  const nodes = { body, app, rightSidebarRail: rail, rightSidebarContent: content, terminalShell: shell };
  const document = {
    createElement: () => makeNode("", ""),
    getElementById: (id) => (nodes[id] ? nodes[id] : null),
  };
  return { nodes, document };
}

function loadHost(document, ctxOverrides = {}) {
  const ctx = {
    document,
    localStorage: { getItem: () => null, setItem() {} },
    state: { ws: "ws-1" },
    el: (id) => document.getElementById(id),
    currentWorkspaceShellMode: () => ctx.__mode || "terminal",
    rememberWorkspaceShellMode: (mode, id) => {
      ctx.__remembered = { mode, id };
    },
    syncRightSidebarRail: () => {
      ctx.__railSynced = (ctx.__railSynced || 0) + 1;
    },
    HerdrScheduleTerminalResize: () => {
      ctx.__resized = (ctx.__resized || 0) + 1;
    },
    ...ctxOverrides,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const source = readFileSync(new URL("./desktop/app_js/right_sidebar.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));
  return ctx;
}

function makeDrawerPanelFactory(document, nodes, panelId, className) {
  return () => {
    let panel = document.getElementById(panelId);
    if (!panel) {
      panel = makeNode(panelId, className);
      nodes[panelId] = panel;
    }
    return panel;
  };
}

test("openView hosts a drawer panel and remembers the mode without un-collapsing", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadHost(document);
  ctx.__mode = "git";
  ctx.__herdrRightSidebarCollapsed = true;
  const ensurePanel = makeDrawerPanelFactory(document, nodes, "gitUiPanel", "git-ui-panel");
  nodes.gitUiPanel = ensurePanel();

  const result = await ctx.HerdrRightSidebar.openView("git", "ws-1", ensurePanel);
  assert.equal(result, "hosted");
  assert.equal(nodes.gitUiPanel.parentNode, nodes.rightSidebarContent, "panel moved into the content column");
  assert.equal(ctx.__remembered.mode, "git", "shell mode remembered");
  assert.equal(ctx.__remembered.id, "ws-1");
  // The collapse flag is global and caller-owned; openView must not expand.
  assert.equal(ctx.HerdrRightSidebar.collapsed(), true, "collapse flag untouched");
  assert.equal(ctx.HerdrRightSidebar.isHosted("gitUiPanel"), true);
  // Host claim drops the legacy inline display override so the hosted CSS owns it.
  assert.equal(nodes.gitUiPanel.style.display, "");
});

test("the center release handoff is gone: hosted panels never leave the column", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadHost(document);
  ctx.__mode = "files";
  const ensurePanel = makeDrawerPanelFactory(document, nodes, "fileBrowserPanel", "file-browser-panel");
  await ctx.HerdrRightSidebar.openView("files", "ws-1", ensurePanel);
  assert.equal(ctx.HerdrRightSidebar.isHosted("fileBrowserPanel"), true);
  assert.equal(
    ctx.HerdrRightSidebar.releaseToCenter,
    undefined,
    "the release handoff died with the Phase 2 center fallback surface",
  );
  assert.equal(nodes.fileBrowserPanel.parentNode, nodes.rightSidebarContent, "panel stays hosted");
});

test("applyRightSidebarHost toggles column visibility and keeps the terminal visible", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadHost(document);
  ctx.__mode = "terminal";
  const ensurePanel = makeDrawerPanelFactory(document, nodes, "gitUiPanel", "git-ui-panel");
  await ctx.HerdrRightSidebar.openView("git", "ws-1", ensurePanel);

  // Mode git + expanded + hosted panel: column visible, terminal visible.
  ctx.__mode = "git";
  ctx.__herdrRightSidebarCollapsed = false;
  ctx.HerdrRightSidebar.apply();
  assert.equal(nodes.rightSidebarContent.hidden, false, "column visible while hosting");
  assert.equal(nodes.terminalShell.style.display, "", "terminal stays visible next to the column");
  assert.ok(ctx.__railSynced >= 1, "rail re-synced");

  // Collapsed column hides the content but keeps the terminal.
  ctx.__herdrRightSidebarCollapsed = true;
  ctx.HerdrRightSidebar.apply();
  assert.equal(nodes.rightSidebarContent.hidden, true, "collapsed column hidden");
  assert.equal(nodes.terminalShell.style.display, "", "terminal visible while collapsed");

  // Terminal mode hides the column even with a leftover hosted panel.
  ctx.__herdrRightSidebarCollapsed = false;
  ctx.__mode = "terminal";
  ctx.HerdrRightSidebar.apply();
  assert.equal(nodes.rightSidebarContent.hidden, true, "terminal mode hides the column");

  // A display:none hosted panel does not count as visible content.
  ctx.__mode = "git";
  nodes.gitUiPanel.style.display = "none";
  ctx.HerdrRightSidebar.apply();
  assert.equal(nodes.rightSidebarContent.hidden, true, "empty column must not hold grid space");
});

test("hostPanel claims a live panel element, not just an id", () => {
  const { nodes, document } = buildDom();
  const ctx = loadHost(document);
  const panel = makeNode("fileBrowserPanel", "file-browser-panel");
  // Not registered in the document yet (first-open state before render).
  const claimed = ctx.HerdrRightSidebar.hostPanel(panel);
  assert.equal(claimed, true, "panel element claim works before getElementById can find it");
  assert.equal(panel.parentNode, nodes.rightSidebarContent);
});

test("openView hosts the search panel like files and git", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadHost(document);
  ctx.__mode = "search";
  const ensurePanel = makeDrawerPanelFactory(document, nodes, "searchPanel", "search-panel");

  const result = await ctx.HerdrRightSidebar.openView("search", "ws-1", ensurePanel);
  assert.equal(result, "hosted", "search is a hostable mode");
  assert.equal(nodes.searchPanel.parentNode, nodes.rightSidebarContent, "search panel moves into the column");
  assert.equal(ctx.__remembered.mode, "search", "search mode remembered");
  assert.equal(ctx.HerdrRightSidebar.mode(), "search", "mode() resolves search");
  assert.equal(ctx.HerdrRightSidebar.visible(), true, "search mode keeps the column visible");
  // The old modal contract kept the Search rail button inactive; the
  // hosted mode reads it like files/git do.
  assert.equal(ctx.HerdrRightSidebar.isHosted("searchPanel"), true);
});
