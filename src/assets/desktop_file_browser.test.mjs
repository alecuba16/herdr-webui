import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8");

function makeNode(id = "") {
  const node = {
    id,
    className: "",
    dataset: {},
    parentNode: null,
    children: [],
    style: {},
    innerHTML: "",
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
      node.parentNode = null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return node;
}

function loadFileBrowser() {
  const body = makeNode("body");
  const app = makeNode("app");
  const shell = makeNode("terminalShell");
  const sidebar = makeNode("rightSidebarContent");
  app.appendChild(sidebar);
  app.appendChild(shell);
  body.appendChild(app);
  const nodes = { body, app, terminalShell: shell, rightSidebarContent: sidebar };
  const document = {
    body,
    visibilityState: "hidden",
    __herdrA6FocusWatcher: true,
    addEventListener() {},
    createElement() {
      const node = makeNode();
      let id = "";
      Object.defineProperty(node, "id", {
        get: () => id,
        set: (value) => {
          id = String(value);
          nodes[id] = node;
        },
      });
      return node;
    },
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const remembered = [];
  let searchClosed = 0;
  const context = {
    window: null,
    globalThis: null,
    document,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null }) }),
    HerdrAppHelpers: { hashId: () => "hash" },
    HerdrFileTree: {
      esc: (value) => String(value == null ? "" : value),
      arg: (value) => encodeURIComponent(String(value == null ? "" : value)),
      formatBytes: (value) => `${value} B`,
      basename: (value) => String(value || "").split("/").pop() || "",
      parentDirectory: (value) => String(value || "/"),
      parentPath: (value) => String(value || "").split("/").slice(0, -1).join("/"),
      applyGitStatus: (entries) => entries,
      renderCurrentDirectoryRow: () => "",
      renderEntries: () => "",
    },
    HerdrOptions: { read: () => ({}) },
    HerdrEditor: { isMarkdownPath: () => false },
    HerdrGitUi: { hide() {} },
    HerdrSearchPanel: { close: () => { searchClosed += 1; } },
    HerdrRightSidebar: {
      openView: async (_mode, _workspace, ensurePanel) => {
        sidebar.appendChild(ensurePanel());
        return "hosted";
      },
      afterDrawerRender() {},
    },
    rememberWorkspaceShellMode: (mode, workspace) => remembered.push({ mode, workspace }),
    syncShellModeButtons() {},
    appRefreshIconButton: () => "",
    confirm: () => true,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    Promise,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { context, nodes, remembered, getSearchClosed: () => searchClosed };
}

test("openAt hosts Files before navigating from another sidebar view", async () => {
  const { context, nodes, remembered, getSearchClosed } = loadFileBrowser();
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };

  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });

  assert.equal(getSearchClosed(), 1, "search panel is removed when Files becomes the active view");
  assert.equal(nodes.fileBrowserPanel.parentNode, nodes.rightSidebarContent, "file browser remains hosted in the sidebar");
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].mode, "files");
  assert.equal(remembered[0].workspace, workspace);
});

test("editor remount after a pane desync lands in the owning pane, not the focused one", async () => {
  // Maximize-restore desync: the editor tab lives in p1 while pane
  // focus sits on p2. The file browser's remount (an open of an already
  // loaded file) resolves the mount target through the pane tree, and
  // the container must follow the tab's owner or p1 renders blank.
  const { context, nodes } = loadFileBrowser();
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  const makePanePair = () => {
    const content = makeNode("content");
    content.parentNode = null;
    const pane = makeNode("pane");
    pane.appendChild(content);
    pane.querySelector = (sel) => (String(sel).includes("pane-content") ? content : null);
    pane.querySelectorAll = () => [];
    return { pane, content };
  };
  const owner = makePanePair();
  const active = makePanePair();
  context.HerdrWorkspacePanes = {
    renderWorkspacePanes() {},
    editorTabId: (path) => `editor:${path}`,
    setActivePaneTab() {},
    paneElementForTab: () => owner.pane,
    activePaneElement: () => active.pane,
    paneRoot: () => ({ leaves: [{ tabs: ["editor:src/lib.rs"] }] }),
    paneLeaves: (root) => root.leaves,
  };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  await context.HerdrFileBrowser.openAt(workspace, "src/lib.rs", { kind: "file" });
  const containerId = `pane-editor-${context.HerdrAppHelpers.hashId("src/lib.rs")}`;
  const container = nodes[containerId];
  assert.ok(container, "the editor container exists");
  assert.ok(
    owner.content.children.includes(container),
    "the container mounts into the owning pane's content slot"
  );
  assert.ok(
    !active.content.children.includes(container),
    "the container does not land in the merely-focused pane"
  );
});

test("openAt routes file opens through the pane tab funnel", async () => {
  const { context, remembered } = loadFileBrowser();
  const routed = [];
  context.HerdrWorkspacePanes = {
    openEditorTab: async (path, highlight) => {
      routed.push({ path, highlight });
    },
  };
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };

  await context.HerdrFileBrowser.openAt(workspace, "src/lib.rs", { kind: "file", highlight: { line: 4 } });

  assert.equal(routed.length, 1, "file open went through the panes funnel");
  assert.equal(routed[0].path, "src/lib.rs");
  assert.deepEqual(routed[0].highlight, { line: 4 }, "search highlight survives the funnel");
  assert.equal(remembered[0].mode, "files");
});

test("closing a tab mid-fetch does not resurrect it when the fetch lands", async () => {
  const { context, nodes } = loadFileBrowser();
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  // The pane stub mirrors the real tree contract closeEditorTab rides on:
  // tab id membership is what the post-fetch guard reads.
  let tabOpen = true;
  context.HerdrWorkspacePanes = {
    paneRoot: () => ({ leaves: tabOpen ? [{ tabs: ["editor:src/lib.rs"] }] : [] }),
    paneLeaves: (root) => root.leaves,
    editorTabId: () => "editor:src/lib.rs",
    setActivePaneTab() { throw new Error("mount attempted for a closed tab"); },
  };
  // The file fetch hangs until the test releases it, simulating a slow
  // open.
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  context.fetch = async () => {
    await gate;
    return {
      ok: true,
      statusText: "OK",
      json: async () => ({
        path: "src",
        entries: [],
        git_status: null,
        content: "fn main() {}",
        hash: "abc123",
        size: 12,
      }),
    };
  };

  let fetchLanded;
  const opened = context.HerdrFileBrowser.openEditorTab("src/lib.rs").then(() => { fetchLanded = true; });
  await new Promise((r) => setTimeout(r, 10));
  // Close mid-flight: drop the tab from the tree (the pane module's
  // closeEditorTab does this via closeEditorTabImmediate), then tear the
  // state as its teardown callback does. Both before the fetch resolves,
  // like a real strip ✕ that wins the race.
  tabOpen = false;
  context.HerdrFileBrowser.closeEditorState("src/lib.rs");
  assert.ok(fetchLanded !== true, "the fetch is still in flight when the tab closes");
  releaseFetch();
  await opened;

  assert.equal(nodes["pane-editor-hash"], undefined, "no editor container is mounted for the closed tab");
  const editor = context.HerdrFileBrowser.editorFor("src/lib.rs");
  assert.equal(editor, null, "no editor state survives for the closed tab");
});
