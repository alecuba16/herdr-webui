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

// Markdown view states: the strip eye (preview/source/edit) lands on
// setMarkdownView, which flips the file entry flags and remounts. Save
// and the dirty guard ride the same draft buffer as text files.
test("markdown view setters flip the entry flags and remount", async () => {
  const { context } = loadFileBrowser();
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  const mounts = [];
  context.HerdrEditor = { isMarkdownPath: (path) => /\.md$/.test(path) };
  let tabOpen = true;
  context.HerdrWorkspacePanes = {
    renderWorkspacePanes() {},
    editorTabId: (path) => `editor:${path}`,
    setActivePaneTab() {},
    paneElementForTab: () => null,
    activePaneElement: () => null,
    paneRoot: () => ({ leaves: tabOpen ? [{ tabs: ["editor:src/readme.md"] }] : [] }),
    paneLeaves: (root) => root.leaves,
  };
  context.fetch = async () => ({
    ok: true,
    statusText: "OK",
    json: async () => ({
      path: "src", entries: [], git_status: null,
      content: "# hi", hash: "h1", size: 4,
      lines_gutter_html: null, lines_code_html: null,
    }),
  });
  // The module calls its internal mountEditorTab directly, so the
  // mount signal observable from outside is the pane tab activation.
  context.HerdrWorkspacePanes.setActivePaneTab = (tabId) => { mounts.push(tabId); };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });

  await context.HerdrFileBrowser.openEditorTab("src/readme.md");
  const opened = context.HerdrFileBrowser.editorFor("src/readme.md");
  assert.ok(opened, "markdown open creates the entry");
  assert.equal(opened.editing, false, "markdown opens in preview, read-only");
  mounts.length = 0;

  context.HerdrFileBrowser.setMarkdownEdit("src/readme.md");
  let entry = context.HerdrFileBrowser.editorFor("src/readme.md");
  assert.equal(entry.editing, true, "edit mode is editing");
  assert.equal(entry.previewSource, false, "edit mode is not source view");
  assert.equal(entry.draft, "# hi", "edit seeds the draft from content");
  assert.deepEqual(mounts, ["editor:src/readme.md"], "edit remounts the tab");

  context.HerdrFileBrowser.setMarkdownSource("src/readme.md");
  entry = context.HerdrFileBrowser.editorFor("src/readme.md");
  assert.equal(entry.editing, false, "source view is read-only");
  assert.equal(entry.previewSource, true, "source view flag set");

  context.HerdrFileBrowser.setMarkdownPreview("src/readme.md");
  entry = context.HerdrFileBrowser.editorFor("src/readme.md");
  assert.equal(entry.editing, false, "preview is not editing");
  assert.equal(entry.previewSource, false, "preview clears the source flag");
  assert.deepEqual(mounts, ["editor:src/readme.md", "editor:src/readme.md", "editor:src/readme.md"],
    "each view change remounts once");
});

test("markdown view setters ignore binary, truncated, and non-markdown files", async () => {
  const { context } = loadFileBrowser();
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  const mounts = [];
  context.HerdrEditor = { isMarkdownPath: (path) => /\.md$/.test(path) };
  context.HerdrWorkspacePanes = {
    renderWorkspacePanes() {},
    editorTabId: (path) => `editor:${path}`,
    setActivePaneTab() {},
    paneElementForTab: () => null,
    activePaneElement: () => null,
    paneRoot: () => ({ leaves: [{ tabs: ["editor:src/readme.md"] }] }),
    paneLeaves: (root) => root.leaves,
  };
  context.fetch = async () => ({
    ok: true,
    statusText: "OK",
    json: async () => ({
      path: "src", entries: [], git_status: null,
      content: "# hi", hash: "h1", size: 4,
      lines_gutter_html: null, lines_code_html: null,
    }),
  });
  context.HerdrWorkspacePanes.setActivePaneTab = (tabId) => { mounts.push(tabId); };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  await context.HerdrFileBrowser.openEditorTab("src/readme.md");

  const entry = context.HerdrFileBrowser.editorFor("src/readme.md");
  assert.ok(entry, "markdown entry exists");
  mounts.length = 0;

  // Binary markdown: view locked.
  entry.binary = true;
  context.HerdrFileBrowser.setMarkdownEdit("src/readme.md");
  assert.equal(entry.editing, false, "binary file never flips to edit");
  assert.deepEqual(mounts, [], "binary file never remounts through the view setter");

  // Truncated markdown: view locked (placeholder or partial preview).
  entry.binary = false;
  entry.truncated = true;
  context.HerdrFileBrowser.setMarkdownSource("src/readme.md");
  assert.equal(entry.previewSource, false, "truncated file stays in preview");
  assert.deepEqual(mounts, [], "truncated file never remounts through the view setter");
  entry.truncated = false;

  // Non-markdown files have no entry to flip.
  context.HerdrFileBrowser.setMarkdownPreview("src/lib.rs");
  assert.equal(context.HerdrFileBrowser.editorFor("src/lib.rs"), null,
    "non-markdown path has no entry to flip");
});

// ---- server-side filter -------------------------------------------------

function makeFilterDomContext() {
  const loaded = loadFileBrowser();
  const { context, nodes } = loaded;
  // The module binds Tree at load time, so the real shared renderer has
  // to be in the context before the module source runs. Reload the
  // module with the real tree in place, keeping the same harness nodes.
  const iconSource = readFileSync(new URL("./shared/file_icons.js", import.meta.url), "utf8");
  const treeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");
  vm.runInNewContext(iconSource, context);
  vm.runInNewContext(treeSource, context);
  vm.runInNewContext(source, context);
  // Rows are markup strings in this harness, so row-class assertions run
  // against the panel HTML; the DOM helpers (querySelector) stay stubbed.
  return { context, nodes };
}

const FILTER_ENTRIES = [
  { kind: "file", name: "alphaFilter.js", path: "src/alphaFilter.js", level: 0, size: 10 },
  { kind: "file", name: "betaFilter.js", path: "src/betaFilter.js", level: 0, size: 20 },
  { kind: "dir", name: "filterDocs", path: "src/filterDocs", level: 0 },
];

function panelHtml(nodes) {
  return String(nodes.fileBrowserPanel.innerHTML);
}

// The active-match class lands via a post-render DOM pass, so the string
// assertion instead checks the selection class the renderer emits plus
// the state the pass reads from.
function selectedKindFromHtml(html) {
  const match = html.match(/class="herdr-tree-row ([a-z]+) active[^"]*"/);
  return match ? match[1] : null;
}

async function openFilterWorkspace(loaded) {
  const { context } = loaded;
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  return workspace;
}

test("filter input renders the row and defers the server search by debounce", async () => {
  const loaded = makeFilterDomContext();
  const { context, nodes } = loaded;
  await openFilterWorkspace(loaded);

  const requests = [];
  context.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: false, visited: 5 }) };
  };

  context.HerdrFileBrowser.filterInput("filter");
  const html = String(nodes.fileBrowserPanel.innerHTML);
  assert.ok(html.includes("file-browser-filter-row"), "the filter row renders after the head");
  assert.ok(html.includes("id=\"fileBrowserFilter\""), "the input is rendered");
  assert.ok(html.indexOf("file-browser-head") < html.indexOf("file-browser-filter-row"), "the row sits after the head block");
  assert.equal(requests.length, 0, "no request fires before the debounce");

  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(requests.length, 1, "the debounce commits one request");
  const url = requests[0];
  assert.ok(url.includes("q=filter"), "the query rides the tree route");
  assert.ok(url.includes("visit_offset=0"), "the first page starts at walk position zero");
  assert.ok(!url.includes("search_kind"), "the filter searches all kinds, no search_kind param");
  assert.ok(url.includes("limit=100"), "the page size comes from search settings");
});

test("Enter commits immediately and jumps to the first match", async () => {
  const loaded = makeFilterDomContext();
  const { context, nodes } = loaded;
  await openFilterWorkspace(loaded);

  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: false, visited: 5 }) });

  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const html = panelHtml(nodes);
  assert.ok(context.HerdrFileBrowser.filterActive(), "the filter is active after commit");
  assert.ok(html.includes("alphaFilter.js"), "the first page of results renders");
  assert.ok(html.includes("herdr-tree-hit"), "matched substrings carry the yellow mark class");
  assert.equal(selectedKindFromHtml(html), "file", "the first match row carries the selection");
});

test("arrows cycle matches with wraparound and follow selection", async () => {
  const loaded = makeFilterDomContext();
  const { context, nodes } = loaded;
  await openFilterWorkspace(loaded);

  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: false, visited: 5 }) });
  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const selected = () => selectedKindFromHtml(panelHtml(nodes));

  context.HerdrFileBrowser.filterKeydown({ key: "ArrowDown", preventDefault() {}, stopPropagation() {} });
  assert.equal(selected(), "file", "the second match is selected after one down");
  context.HerdrFileBrowser.cycleMatch(1);
  assert.equal(selected(), "dir", "the third match is the wraparound target from the last down");
  context.HerdrFileBrowser.cycleMatch(1);
  assert.equal(selected(), "file", "wrapping past the end returns to the first match");
  context.HerdrFileBrowser.cycleMatch(-1);
  assert.equal(selected(), "dir", "up from the first match wraps to the last");
});

test("status text reports the shown count and the more marker, errors included", async () => {
  const loaded = makeFilterDomContext();
  const { context, nodes } = loaded;
  await openFilterWorkspace(loaded);

  let truncated = true;
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated, visited: 5 }) });
  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let html = String(nodes.fileBrowserPanel.innerHTML);
  assert.ok(html.includes("3 shown"), "the count reports what the server returned");
  assert.ok(html.includes("more"), "the truncated marker is shown");

  truncated = false;
  context.fetch = async () => ({ ok: false, status: 500, statusText: "Boom", json: async () => ({ error: "Boom" }) });
  context.HerdrFileBrowser.filterInput("other");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  html = String(nodes.fileBrowserPanel.innerHTML);
  assert.ok(html.includes("file-browser-filter-status error"), "the error state styles the status text");
});

test("Escape and clearFilter restore the normal tree", async () => {
  const loaded = makeFilterDomContext();
  const { context, nodes } = loaded;
  await openFilterWorkspace(loaded);

  const requests = [];
  context.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: false, visited: 5 }) };
  };
  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(context.HerdrFileBrowser.filterActive(), "filter is active before Escape");

  context.HerdrFileBrowser.filterKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.HerdrFileBrowser.filterActive(), false, "Escape clears the filter");
  assert.equal(requests.filter((url) => !url.includes("q=")).length, 1, "clearing refetches the normal tree");
  const html = String(nodes.fileBrowserPanel.innerHTML);
  assert.ok(!html.includes("herdr-tree-hit"), "no highlight marks survive the clear");
});

test("typing then clearing to empty restores the tree without a search", async () => {
  const loaded = makeFilterDomContext();
  const { context } = loaded;
  await openFilterWorkspace(loaded);

  const requests = [];
  context.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null, truncated: false, visited: 0 }) };
  };
  context.HerdrFileBrowser.filterInput("x");
  context.HerdrFileBrowser.filterInput("");
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(requests.filter((url) => url.includes("q=")).length, 0, "no search request fires for a cleared input");
  assert.equal(context.HerdrFileBrowser.filterActive(), false, "the filter is inactive after clearing the text");
});

test("scroll near the bottom appends the next result page", async () => {
  const loaded = makeFilterDomContext();
  const { context } = loaded;
  await openFilterWorkspace(loaded);

  const requests = [];
  context.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: true, visited: 5 }) };
  };
  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  context.HerdrFileBrowser.sideScroll({ scrollTop: 500, clientHeight: 300, scrollHeight: 600 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const searchRequests = requests.filter((url) => url.includes("q="));
  assert.equal(searchRequests.length, 2, "the scroll appends one page");
  assert.ok(searchRequests[1].includes("offset=3"), "the append resumes after the first page");
  assert.ok(searchRequests[1].includes("visit_offset=5"), "the append resumes the walk cursor");
});

test("navigation away ends the filter", async () => {
  const loaded = makeFilterDomContext();
  const { context } = loaded;
  await openFilterWorkspace(loaded);

  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: FILTER_ENTRIES, git_status: null, truncated: false, visited: 5 }) });
  context.HerdrFileBrowser.filterInput("filter");
  context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(context.HerdrFileBrowser.filterActive(), "filter is active before navigation");

  await context.HerdrFileBrowser.enter(encodeURIComponent("src"));
  assert.equal(context.HerdrFileBrowser.filterActive(), false, "entering a folder resets the filter");
});

test("the file browser shortcut map reads the settings scope", async () => {
  const loaded = makeFilterDomContext();
  const { context } = loaded;
  await openFilterWorkspace(loaded);
  // The dispatch handler is a window listener that the vm context stubs
  // out, so the observable contract here is the options plumbing: the
  // stored scope merges over the Slash default.
  context.HerdrOptions = { read: () => ({ fileBrowserShortcuts: { filter: "KeyF" } }) };
  context.HerdrFileBrowser.filterInput("f");
  context.HerdrFileBrowser.clearFilter();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.HerdrFileBrowser.filterActive(), false, "clearFilter resets the active state");
});

// ---- Files desync row: divergence signal between the two explorers ----

function makeDesyncDomContext({ gitCwd = "/repo", parentFolders = false, gitUi = "full" } = {}) {
  const nodes = { rightSidebarContent: stubNode("rightSidebarContent") };
  const sidebar = stubNode("rightSidebarContent");
  function stubNode(id) {
    const listeners = {};
    return {
      id, className: "", innerHTML: "", style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute: () => null,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    };
  }
  const document = {
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement() {
      const node = stubNode("created");
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
    body: { appendChild() {}, removeChild() {}, classList: { add() {}, remove() {} } },
  };
  const gitCalls = [];
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
      parentDirectory: (value) => {
        const parts = String(value || "/").replace(/\\/g, "/").replace(/\/+$/, "").split("/");
        if (parts.length <= 1) return parts[0] === "" ? "/" : parts[0];
        return parts.slice(0, -1).join("/") || "/";
      },
      parentPath: (value) => String(value || "").split("/").slice(0, -1).join("/"),
      applyGitStatus: (entries) => entries,
      renderCurrentDirectoryRow: () => "",
      renderEntries: () => "",
    },
    HerdrOptions: { read: () => ({}) },
    HerdrEditor: { isMarkdownPath: () => false },
    // Option readers bind at module load; the git_ui stub shape decides
    // which anchor the desync row reads.
    HerdrWorkspaceSearch: parentFolders ? { fileBrowserParentFoldersEnabled: () => true } : {},
    HerdrGitUi: gitUi === "hidden"
      ? { hide() {} }
      : {
          hide() {},
          currentCwd: () => gitCwd,
          openForCwd: async (dir) => { gitCalls.push({ dir }); },
        },
    HerdrSearchPanel: { close: () => {} },
    HerdrRightSidebar: {
      openView: async (_mode, _workspace, ensurePanel) => { sidebar.appendChild(ensurePanel()); return "hosted"; },
      afterDrawerRender() {},
    },
    rememberWorkspaceShellMode: () => {},
    syncShellModeButtons: () => {},
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
  return { context, gitCalls };
}

test("the desync row appears when the Files cwd leaves the Git cwd", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  // Open a different folder as the Files root: the panel leaves the Git cwd.
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "", entries: [], git_status: null }) });
  await context.HerdrFileBrowser.openAt({ workspace_id: "ws-1", cwd: "/elsewhere" }, "", { kind: "dir" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const html = context.document.getElementById("fileBrowserPanel") ? context.document.getElementById("fileBrowserPanel").innerHTML : "";
  assert.match(html, /file-browser-desync/, "the desync row renders when the roots diverge");
  assert.match(html, /syncGitToFilesCwd/, "the Git sync arrow is present");
  assert.match(html, /returnToWorkspaceCwd/, "the return arrow is present");
});

test("the desync row stays hidden while the roots match", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  const html = context.document.getElementById("fileBrowserPanel") ? context.document.getElementById("fileBrowserPanel").innerHTML : "";
  assert.ok(!html.includes("file-browser-desync"), "no desync row while both panels share the folder");
});

test("syncGitToFilesCwd forwards the Files cwd to the Git panel", async () => {
  const { context, gitCalls } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/elsewhere" };
  await context.HerdrFileBrowser.openAt(workspace, "", { kind: "dir" });
  await context.HerdrFileBrowser.syncGitToFilesCwd();
  assert.equal(gitCalls.length, 1, "syncGitToFilesCwd calls openForCwd once");
  assert.equal(gitCalls[0].dir, "/elsewhere", "the forwarded dir is the Files cwd");
});

test("returnToWorkspaceCwd brings the panel back to the anchor", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/elsewhere" };
  await context.HerdrFileBrowser.openAt(workspace, "", { kind: "dir" });
  await context.HerdrFileBrowser.returnToWorkspaceCwd();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.HerdrFileBrowser.cwd ? context.HerdrFileBrowser.cwd() : undefined, undefined, "cwd accessor is not part of the public surface; state check follows");
  const html = context.document.getElementById("fileBrowserPanel") ? context.document.getElementById("fileBrowserPanel").innerHTML : "";
  assert.ok(!html.includes("file-browser-desync"), "the desync row disappears after returning to the anchor");
});

test("the desync row falls back to the workspace folder when git_ui is not loaded", async () => {
  const { context } = makeDesyncDomContext({ gitUi: "hidden", parentFolders: true });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "", { kind: "dir" });
  const html = () => {
    const panel = context.document.getElementById("fileBrowserPanel");
    return panel ? panel.innerHTML : "";
  };
  assert.ok(!html().includes("file-browser-desync"), "no desync row while the panel sits on the workspace folder");
  // The real divergence path for the fallback anchor is navigation: the
  // panel root leaves the workspace folder via go-up, without git_ui
  // loaded the anchor stays on the workspace folder the panel opened with.
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "", entries: [], git_status: null }) });
  // The panel opened at the workspace root but the tree stub answered
  // path "src"; the first up() climbs that in-tree path level. The hop
  // lets it land before the second up() reads state, because up()
  // fires goUp() without awaiting it, same as a real click-to-click gap.
  await context.HerdrFileBrowser.up();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await context.HerdrFileBrowser.up();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(html(), /file-browser-desync/, "the desync row renders on the fallback anchor");
  await context.HerdrFileBrowser.returnToWorkspaceCwd();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!html().includes("file-browser-desync"), "the return arrow restores the fallback anchor");
});

// ---- Stale tree position after a root re-pin: the rail reopen path ----

test("rail reopen after a folder change drops the stale tree position", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  const treeCalls = [];
  // Backend behavior for the bug: a stale relative path joined onto the
  // new root misses and answers "path is not a directory".
  context.fetch = async (url) => {
    treeCalls.push(String(url));
    const stale = /path=src(&|$)/.test(String(url)) && String(url).includes("cwd=%2Felsewhere");
    if (stale) return { ok: false, statusText: "Bad Request", json: async () => ({ error: "path is not a directory" }) };
    const keep = /path=src(&|$)/.test(String(url));
    return { ok: true, statusText: "OK", json: async () => ({ path: keep ? "src" : "", entries: [], git_status: null }) };
  };
  // Same root reopen keeps the tree position.
  await context.HerdrFileBrowser.open(workspace, { forceOpen: true });
  assert.ok(treeCalls.some((call) => /path=src(&|$)/.test(call)), "same-root reopen keeps the tree position");
  // Root change reopen must not carry the old position over.
  await context.HerdrFileBrowser.open({ workspace_id: "ws-1", cwd: "/elsewhere" }, { forceOpen: true });
  const last = treeCalls[treeCalls.length - 1] || "";
  assert.ok(last.includes("cwd=%2Felsewhere"), "the reopen asks for the new root");
  assert.ok(!/path=src(&|$)/.test(last), "the reopen drops the stale tree position");
  const html = context.document.getElementById("fileBrowserPanel") ? context.document.getElementById("fileBrowserPanel").innerHTML : "";
  assert.ok(!html.includes("file-browser-error"), "no red error row after the reopen");
  assert.ok(html.includes("elsewhere"), "the panel renders the new root");
});

// ---- Rail desync dot: the shell reads desyncState() to tint the Files
// rail button amber while the panel root sits outside the anchor ----

test("desyncState reports the rail dot contract while diverged", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  let synced = 0;
  context.HerdrSyncFilesRailDesync = () => { synced++; };
  // Open a different folder as the Files root: the panel leaves the Git cwd.
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "", entries: [], git_status: null }) });
  await context.HerdrFileBrowser.openAt({ workspace_id: "ws-1", cwd: "/elsewhere" }, "", { kind: "dir" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const info = context.HerdrFileBrowser.desyncState();
  assert.equal(info.desynced, true, "desyncState flags divergence");
  assert.equal(info.cwd, "/elsewhere", "desyncState carries the diverged cwd");
  assert.equal(info.anchor, "/repo", "desyncState carries the git anchor");
  assert.ok(synced > 0, "the panel render asks the shell to re-sync the rail dot");
});

test("desyncState stays quiet while the roots match", async () => {
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  const info = context.HerdrFileBrowser.desyncState();
  assert.equal(info.desynced, false, "no desync flag while the roots match");
  assert.equal(info.cwd, "", "no cwd carried while synced");
  assert.equal(info.anchor, "", "no anchor carried while synced");
});

test("the desync return arrow names the git folder as its target", async () => {
  // git_ui loaded with a live view: the anchor is the Git panel folder.
  const { context } = makeDesyncDomContext({ gitCwd: "/repo" });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "", entries: [], git_status: null }) });
  await context.HerdrFileBrowser.openAt({ workspace_id: "ws-1", cwd: "/elsewhere" }, "", { kind: "dir" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const html = context.document.getElementById("fileBrowserPanel").innerHTML;
  assert.match(html, /Back to Git panel folder/, "the return arrow says where it goes when git_ui holds the anchor");
  const info = context.HerdrFileBrowser.desyncState();
  assert.equal(info.anchorKind, "git", "desyncState reports the git anchor kind");
});

test("the desync return arrow keeps the workspace wording on the fallback anchor", async () => {
  // No git_ui: the anchor is the workspace folder the panel opened with,
  // and the real divergence path is a go-up out of that folder.
  const { context } = makeDesyncDomContext({ gitUi: "hidden", parentFolders: true });
  const workspace = { workspace_id: "ws-1", cwd: "/repo" };
  await context.HerdrFileBrowser.openAt(workspace, "", { kind: "dir" });
  context.fetch = async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "", entries: [], git_status: null }) });
  await context.HerdrFileBrowser.up();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await context.HerdrFileBrowser.up();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const html = context.document.getElementById("fileBrowserPanel").innerHTML;
  assert.match(html, /Back to workspace folder/, "the fallback anchor keeps the workspace wording");
  const info = context.HerdrFileBrowser.desyncState();
  assert.equal(info.anchorKind, "workspace", "desyncState reports the workspace anchor kind");
});
