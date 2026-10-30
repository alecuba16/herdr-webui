import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Behavioral tests for desktop/app_js/worktrees.js: the worktree discovery
// modal, create flow, open/remove actions, and rename/close helpers. The
// harness boots the same desktop bundle order app_load.test.mjs uses
// (shared helpers, then app_js chain ending in bindings), so cross-file
// names resolve exactly like the served concat and coverage attributes to
// each real file.

function element(id = "") {
  const classes = new Set();
  const styleProps = {};
  return {
    id,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) { styleProps[name] = String(value); },
      getPropertyValue(name) { return styleProps[name] || ""; },
    },
    dataset: {},
    value: "",
    checked: false,
    focused: false,
    selected: false,
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    disabled: false,
    setAttribute(name, value) {
      this.attributes = this.attributes || {};
      this.attributes[name] = value;
      this[name] = value;
    },
    getAttribute(name) {
      return (this.attributes && this.attributes[name]) != null ? this.attributes[name] : null;
    },
    closest() { return this; },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    children: [],
    focus() { this.focused = true; },
    select() { this.selected = true; },
    click() { if (typeof this.onclick === "function") this.onclick(); },
    addEventListener() {},
    getBoundingClientRect() { return { bottom: 100, height: 100, left: 0, top: 0, width: 100 }; },
    querySelector() { return element(); },
    querySelectorAll() { return []; },
  };
}

// One compiled script per product file, same list and order as the app_load
// bundle, so coverage attributes each file's lines to its real disk path.
const BUNDLE_FILES = [
  "./shared/options.js",
  "./shared/core.js",
  "./shared/actions.js",
  "./shared/terminal_fit.js",
  "./desktop/search.js",
  "./desktop/app_js/core.js",
  "./desktop/app_js/settings_sections.js",
  "./desktop/app_js/workspace_shell.js",
  "./desktop/app_js/right_sidebar.js",
  "./desktop/app_js/search_panel.js",
  "./desktop/app_js/workspace_panes.js",
  "./desktop/app_js/render.js",
  "./desktop/app_js/terminal.js",
  "./desktop/app_js/lens.js",
  "./desktop/app_js/prompt_cards.js",
  "./desktop/app_js/composer.js",
  "./desktop/app_js/worktrees.js",
  "./desktop/app_js/shortcuts.js",
  "./desktop/app_js/workspace_create.js",
  "./desktop/app_js/bindings.js",
];
let bundleScripts = null;
function getBundleScripts() {
  if (!bundleScripts) {
    bundleScripts = BUNDLE_FILES.map((path) => {
      const realPath = fileURLToPath(new URL(path, import.meta.url));
      return new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath });
    });
  }
  return bundleScripts;
}
// Same hoist shim as app_load: the concatenated blob hoisted function
// declarations across files; separate scripts need the names pre-declared.
const HOIST_PRELOAD = new vm.Script(
  "var syncGitWorkspaceToggle = function() {};\n" +
    "var escapeHtml = function(v) { return String(v == null ? \"\" : v); };\n" +
    "var globalShortcutPrefixLabel = function() { return \"Ctrl\"; };\n" +
    "window.syncGitWorkspaceToggle = syncGitWorkspaceToggle;",
  { filename: "hoist-preload.js" },
);
const HOIST_REWIRE = new vm.Script(
  "window.syncGitWorkspaceToggle = syncGitWorkspaceToggle;",
  { filename: "hoist-rewire.js" },
);

function context(fetchImpl) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorage = new Map();
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) { return 1; },
    requestAnimationFrame(fn) { if (typeof fn === "function") fn(); return 1; },
    cancelAnimationFrame() {},
    document: {
      body: getElement("body"),
      documentElement: element("html"),
      title: "",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    WebSocket: class {},
    fetch: fetchImpl,
    addEventListener() {},
    removeEventListener() {},
    prompt: () => null,
    confirm: () => true,
    alert() {},
    showBlocking() {},
    hideBlocking() {},
  };
  ctx.terminal = getElement("terminal");
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const contextObject = vm.createContext(ctx);
  productScript("./shared/http.js").runInContext(contextObject);
  return contextObject;
}

function productScript(relPath) {
  productScript.cache = productScript.cache || new Map();
  if (!productScript.cache.has(relPath)) {
    const realPath = fileURLToPath(new URL(relPath, import.meta.url));
    productScript.cache.set(
      relPath,
      new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath }),
    );
  }
  return productScript.cache.get(relPath);
}

function runSource(ctx) {
  HOIST_PRELOAD.runInContext(ctx);
  for (const script of getBundleScripts()) script.runInContext(ctx);
  HOIST_REWIRE.runInContext(ctx);
  // Top-level `let state/options` in core.js never become context properties;
  // mirror them onto window so the harness can read and seed them directly.
  new vm.Script(
    "window.state = state; window.options = options;",
    { filename: "state-mirror.js" },
  ).runInContext(ctx);
}

// jsonByPath: map url path prefix -> json body (or (params, init) => body).
function boot(responses = {}, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const raw = String(url);
    const path = raw.split("?")[0];
    const params = new URLSearchParams(raw.split("?")[1] || "");
    calls.push({ path, params, raw, init });
    let handler = responses[path];
    if (typeof handler === "function") handler = handler(params, init);
    if (handler) return { ok: true, status: 200, statusText: "OK", json: async () => handler };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const ctx = context(fetchImpl);
  if (options.workspaceSort) {
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ workspaceSort: options.workspaceSort }));
  }
  runSource(ctx);
  return { ctx, calls, getElement: (id) => ctx.document.getElementById(id) };
}

const DISCOVER_REPLY = {
  result: {
    source: {
      source_workspace_id: "ws-1",
      source_checkout_path: "/repo/main",
      repo_name: "app",
      repo_root: "/repo",
      default_worktree_directory: "../worktrees",
    },
    worktrees: [
      {
        is_linked_worktree: true,
        path: "/repo/../worktrees/feature-a",
        label: "feature-a",
        branch: "feature-a",
        source_workspace_id: "ws-1",
        source_repo_name: "app",
        source_repo_root: "/repo",
        source_cwd: "/repo/main",
        last_activity: "2024-05-02T10:00:00Z",
      },
    ],
  },
};

describe("worktree discovery modal", () => {
  it("openWorktreeOpenModal shows the modal and resets transient state", async () => {
    const { ctx, getElement, calls } = boot({ "/api/worktrees": DISCOVER_REPLY });
    ctx.openWorktreeOpenModal("/repo", true);
    assert.equal(getElement("worktreeOpenModal").style.display, "grid");
    assert.equal(getElement("worktreeDiscoverPath").value, "/repo");
    // openWorktreeOpenModal(path, discoverNow=true) fires the discovery call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
    ctx.closeWorktreeOpenModal();
    assert.equal(getElement("worktreeOpenModal").style.display, "none");
  });

  it("discoverWorktrees stamps source and renders linked worktree rows", async () => {
    const { ctx, getElement, calls } = boot({ "/api/worktrees": DISCOVER_REPLY });
    getElement("worktreeDiscoverPath").value = "/repo";
    await ctx.discoverWorktrees();
    const listHtml = getElement("worktreeOpenList").innerHTML;
    assert.match(listHtml, /worktree-open-row/);
    assert.match(listHtml, /feature-a/);
    assert.equal(getElement("worktreeOpenError").textContent, "");
    assert.equal(ctx.state.openWorktreeSource.repo_name, "app");
    assert.equal(ctx.state.openWorktreeSource.cwd, "/repo/main");
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
  });

  it("discoverWorktrees with no path posts without cwd and finds no rows", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": (params) => {
        assert.equal(params.get("cwd"), null);
        return { result: { source: {}, worktrees: [] } };
      },
    });
    await ctx.discoverWorktrees();
    // Success always stamps a source object, so the empty list reads as a
    // repo without linked worktrees.
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /Git repo found\. No linked worktrees found/,
    );
  });

  it("renderWorktreeOpenList shows the entry hint before any discovery", async () => {
    const { ctx, getElement } = boot();
    ctx.renderWorktreeOpenList();
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /Enter a folder\. Git repos are discovered automatically\./,
    );
  });

  it("discoverWorktrees failure with a path shows the no-worktrees hint", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => { throw new Error("boom"); },
    });
    getElement("worktreeDiscoverPath").value = "/tmp/plain";
    await ctx.discoverWorktrees();
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /No Git worktrees available for this folder\. Create a workspace instead\./,
    );
  });

  it("discoverWorktrees on a git repo with no linked worktrees suggests creating one", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": { result: { source: { repo_name: "app", source_checkout_path: "/repo/main" }, worktrees: [] } },
    });
    getElement("worktreeDiscoverPath").value = "/repo";
    await ctx.discoverWorktrees();
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /Git repo found\. No linked worktrees found/,
    );
  });

  it("discoverWorktrees failure clears source and rows without leaving an error string", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => { throw new Error("boom"); },
    });
    getElement("worktreeDiscoverPath").value = "/repo";
    await ctx.discoverWorktrees();
    assert.equal(ctx.state.openWorktreeSource, null);
    assert.equal(ctx.state.openWorktreeRows.length, 0);
    assert.equal(getElement("worktreeOpenError").textContent, "");
  });
});

describe("worktree create modal", () => {
  it("openWorktreeCreateModal prefills the source path for a normal workspace", async () => {
    const { ctx, getElement } = boot();
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo/main" }];
    ctx.openWorktreeCreateModal("ws-1");
    assert.equal(getElement("worktreeCreateModal").style.display, "grid");
    assert.equal(getElement("worktreeCreateSource").value, "/repo/main");
    assert.equal(getElement("worktreePullBase").checked, false);
    ctx.closeWorktreeCreateModal();
    assert.equal(getElement("worktreeCreateModal").style.display, "none");
  });

  it("openWorktreeCreateModal refuses a linked worktree", async () => {
    const { ctx, getElement } = boot();
    ctx.state.workspaces = [
      { workspace_id: "wt-1", label: "feature-a", worktree: { is_linked_worktree: true, checkout_path: "/wt/a" } },
    ];
    ctx.openWorktreeCreateModal("wt-1");
    assert.equal(getElement("worktreeCreateModal").style.display, undefined);
    assert.equal(ctx.state.createWorktreeWorkspace, undefined);
  });

  it("setCreateWorktreeLoading toggles the loading text and class", async () => {
    const { ctx, getElement } = boot();
    ctx.setCreateWorktreeLoading(true, "Discovering...");
    assert.equal(getElement("worktreeCreateLoading").textContent, "Discovering...");
    assert.equal(getElement("worktreeCreateLoading").classList.contains("show"), true);
    ctx.setCreateWorktreeLoading(false);
    assert.equal(getElement("worktreeCreateLoading").classList.contains("show"), false);
  });

  it("syncCreateWorktreeCheckoutPath builds the default path from source, repo, and branch", async () => {
    const { ctx, getElement } = boot();
    ctx.state.createWorktreeSource = {
      repo_root: "/repo",
      repo_name: "app",
      default_worktree_directory: "../worktrees",
    };
    getElement("worktreeBranch").value = "Feature B";
    getElement("worktreePath").value = "";
    ctx.syncCreateWorktreeCheckoutPath();
    assert.equal(getElement("worktreePath").value, "/worktrees/app/feature-b");
    assert.equal(ctx.state.createWorktreeDefaultPath, "/worktrees/app/feature-b");
  });

  it("discoverCreateWorktreeSource stamps the source from the api reply", async () => {
    const { ctx, getElement, calls } = boot({ "/api/worktrees": DISCOVER_REPLY });
    getElement("worktreeCreateSource").value = "/repo/main";
    await ctx.discoverCreateWorktreeSource();
    assert.equal(ctx.state.createWorktreeSource.cwd, "/repo/main");
    assert.equal(ctx.state.createWorktreeSource.repo_name, "app");
    assert.equal(getElement("worktreeCreateError").textContent, "");
    assert.ok(calls.some((c) => c.path === "/api/worktrees" && c.params.get("cwd") === "/repo/main"));
  });

  it("discoverCreateWorktreeSource failure surfaces the error text", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => { throw new Error("no repo"); },
    });
    getElement("worktreeCreateSource").value = "/tmp/x";
    await ctx.discoverCreateWorktreeSource();
    assert.equal(ctx.state.createWorktreeSource, null);
    assert.equal(getElement("worktreeCreateError").textContent, "no repo");
  });
});

describe("worktree open/create actions", () => {
  it("openDiscoveredWorktree posts the linked row and navigates", async () => {
    const navigations = [];
    const { ctx, calls } = boot({
      "/api/worktrees": DISCOVER_REPLY,
      "/api/worktrees/open": { result: { workspace: { workspace_id: "wt-9" }, tab: { tab_id: "t-9" }, root_pane: { pane_id: "p-9" } } },
    });
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    ctx.state.openWorktreeRows = [
      { is_linked_worktree: true, path: "/wt/a", branch: "a", source_workspace_id: "ws-1", source_cwd: "/repo/main" },
    ];
    await ctx.openDiscoveredWorktree(0);
    const openCall = calls.find((c) => c.path === "/api/worktrees/open");
    assert.ok(openCall, "must POST /api/worktrees/open");
    assert.equal(JSON.parse(openCall.init.body).cwd, null, "cwd null when source_workspace_id present");
    assert.deepEqual(navigations, [["wt-9", "t-9", "p-9"]]);
  });

  it("openDiscoveredWorktree ignores a non-linked row", async () => {
    const { ctx, calls } = boot();
    ctx.state.openWorktreeRows = [{ is_linked_worktree: false, path: "/x" }];
    await ctx.openDiscoveredWorktree(0);
    assert.equal(calls.filter((c) => c.path === "/api/worktrees/open").length, 0);
  });

  it("createDiscoveredWorktree requires a branch when generation is off", async () => {
    const { ctx, getElement, calls } = boot();
    getElement("worktreeNewBranch").value = "";
    await ctx.createDiscoveredWorktree();
    assert.match(
      getElement("worktreeOpenError").textContent,
      /Branch name is required\./,
    );
    assert.equal(calls.filter((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST").length, 0);
  });

  it("createDiscoveredWorktree posts the source-resolved body and navigates", async () => {
    const navigations = [];
    const { ctx, getElement, calls } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST") {
          return { result: { workspace: { workspace_id: "wt-new" }, tab: { tab_id: "t-new" }, root_pane: { pane_id: "p-new" } } };
        }
        return DISCOVER_REPLY;
      },
    });
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    ctx.state.openWorktreeSource = { workspace_id: "ws-1", cwd: "/repo/main", repo_name: "app", repo_root: "/repo" };
    getElement("worktreeNewBranch").value = "feature-z";
    getElement("worktreeDiscoverPath").value = "/repo";
    await ctx.createDiscoveredWorktree();
    const post = calls.find((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST");
    assert.ok(post, "must POST /api/worktrees");
    const body = JSON.parse(post.init.body);
    assert.equal(body.branch, "feature-z");
    assert.equal(body.cwd, "/repo/main");
    assert.deepEqual(navigations, [["wt-new", "t-new", "p-new"]]);
  });

  it("removeDiscoveredWorktree confirms, removes, and re-discovers", async () => {
    const questions = [];
    const { ctx, calls } = boot({
      "/api/worktrees": DISCOVER_REPLY,
      "/api/worktrees/remove-path": { ok: true },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    const refreshes = [];
    ctx.refresh = () => refreshes.push(1);
    ctx.state.openWorktreeRows = [
      { is_linked_worktree: true, path: "/wt/a", branch: "a", label: "a", source_repo_root: "/repo", source_workspace_id: null, source_cwd: "/repo/main" },
    ];
    await ctx.removeDiscoveredWorktree(0);
    assert.equal(questions.length, 1);
    assert.match(questions[0].title, /Remove worktree from disk\?/);
    const removeCall = calls.find((c) => c.path === "/api/worktrees/remove-path");
    assert.ok(removeCall, "must POST remove-path");
    assert.equal(JSON.parse(removeCall.init.body).path, "/wt/a");
    assert.ok(refreshes.length >= 1, "refresh after removal");
  });

  it("removeDiscoveredWorktree aborts when the user declines", async () => {
    const { ctx, calls } = boot();
    ctx.askQuestion = async () => false;
    ctx.state.openWorktreeRows = [
      { is_linked_worktree: true, path: "/wt/a", source_repo_root: "/repo" },
    ];
    await ctx.removeDiscoveredWorktree(0);
    assert.equal(calls.filter((c) => c.path === "/api/worktrees/remove-path").length, 0);
  });
});

describe("workspace close and rename helpers", () => {
  it("orderedWorkspaceIds appends unseen workspaces after the persisted order", async () => {
    const { ctx } = boot();
    ctx.state.workspaceOrder = ["ws-2", "ws-1"];
    ctx.state.workspaces = [
      { workspace_id: "ws-1" },
      { workspace_id: "ws-3" },
      { workspace_id: "ws-2" },
    ];
    assert.equal(ctx.orderedWorkspaceIds().join(","), "ws-2,ws-1,ws-3");
  });

  it("closeWorkspace asks once and posts the close call for a plain workspace", async () => {
    const questions = [];
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/close": { ok: true },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    const refreshes = [];
    ctx.refresh = () => refreshes.push(1);
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo/main" }];
    await ctx.closeWorkspace("ws-1");
    assert.equal(questions.length, 1);
    assert.match(questions[0].title, /Close workspace\?/);
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-1/close"));
    assert.ok(refreshes.length >= 1);
  });

  it("closeWorkspace aborts when declined", async () => {
    const { ctx, calls } = boot();
    ctx.askQuestion = async () => false;
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/r" }];
    await ctx.closeWorkspace("ws-1");
    assert.equal(calls.filter((c) => c.path === "/api/workspaces/ws-1/close").length, 0);
  });

  it("workspaceRenameKey commits on Enter with a non-empty label", async () => {
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/rename": { ok: true },
    });
    const refreshes = [];
    ctx.refresh = () => refreshes.push(1);
    ctx.state.editingWorkspace = "ws-1";
    ctx.state.editingWorkspaceValue = "renamed";
    await ctx.workspaceRenameKey({ key: "Enter", preventDefault() {} }, "ws-1");
    const renameCall = calls.find((c) => c.path === "/api/workspaces/ws-1/rename");
    assert.ok(renameCall, "rename POST fired");
    assert.equal(JSON.parse(renameCall.init.body).label, "renamed");
  });

  it("workspaceRenameKey Escape clears the editing state without posting", async () => {
    const { ctx, calls } = boot();
    ctx.state.editingWorkspace = "ws-1";
    ctx.state.editingWorkspaceValue = "x";
    ctx.workspaceRenameKey({ key: "Escape" }, "ws-1");
    assert.equal(ctx.state.editingWorkspace, null);
    assert.equal(ctx.state.editingWorkspaceValue, "");
    assert.equal(calls.filter((c) => c.path === "/api/workspaces/ws-1/rename").length, 0);
  });

  it("newTab posts exactly one create per call and navigates", async () => {
    const navigations = [];
    const { ctx, calls } = boot({
      "/api/tabs": { result: { tab: { tab_id: "t-1" } } },
    });
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    ctx.state.ws = "ws-1";
    await ctx.newTab();
    assert.equal(calls.filter((c) => c.path === "/api/tabs").length, 1);
    assert.deepEqual(navigations, [["ws-1", "t-1", undefined]]);
  });

  it("newTab without a selected workspace is a no-op", async () => {
    const { ctx, calls } = boot();
    ctx.state.ws = null;
    await ctx.newTab();
    assert.equal(calls.filter((c) => c.path === "/api/tabs").length, 0);
  });
});

describe("pure worktree helpers", () => {
  it("localWorktreeBranchName strips origin/ and upstream/ prefixes", async () => {
    const { ctx } = boot();
    assert.equal(ctx.localWorktreeBranchName("origin/feature"), "feature");
    assert.equal(ctx.localWorktreeBranchName("upstream/release"), "release");
    assert.equal(ctx.localWorktreeBranchName("plain"), "plain");
    assert.equal(ctx.localWorktreeBranchName(""), "");
  });

  it("isRemoteWorktreeBranch accepts only origin/ and upstream/", async () => {
    const { ctx } = boot();
    assert.equal(ctx.isRemoteWorktreeBranch("origin/x"), true);
    assert.equal(ctx.isRemoteWorktreeBranch("upstream/y"), true);
    assert.equal(ctx.isRemoteWorktreeBranch("feature/z"), false);
    assert.equal(ctx.isRemoteWorktreeBranch(""), false);
  });

  it("joinPath strips duplicate separators and empty parts", async () => {
    const { ctx } = boot();
    assert.equal(ctx.joinPath("/repo/", "app", "feature-a"), "/repo/app/feature-a");
    assert.equal(ctx.joinPath("/repo", "/app/", "/x/"), "/repo/app/x");
    assert.equal(ctx.joinPath("", "app"), "app");
  });

  it("worktreeRootForSource prefers the option, then the source default, then ../worktrees", async () => {
    const { ctx } = boot();
    ctx.state.createWorktreeSource = { repo_root: "/repo", default_worktree_directory: "../wts" };
    assert.equal(ctx.worktreeRootForSource(ctx.state.createWorktreeSource), "/wts");
    ctx.options.worktreeDefaultDirectory = "~/wt";
    assert.equal(ctx.worktreeRootForSource(ctx.state.createWorktreeSource), "~/wt");
    ctx.options.worktreeDefaultDirectory = "";
    ctx.state.createWorktreeSource = { repo_root: "/repo" };
    assert.equal(ctx.worktreeRootForSource(ctx.state.createWorktreeSource), "/worktrees");
  });

  it("pullFastForwardFailed requires fast-forward plus diverging, impossible, or fatal", async () => {
    const { ctx } = boot();
    assert.equal(ctx.pullFastForwardFailed("Not possible to fast-forward, aborting"), true);
    assert.equal(ctx.pullFastForwardFailed("fast-forward: diverging branches"), true);
    assert.equal(ctx.pullFastForwardFailed("fatal: fast-forward failed"), true);
    assert.equal(ctx.pullFastForwardFailed("fatal: some other fatal"), false);
    assert.equal(ctx.pullFastForwardFailed("fatal: Fast-forward failed"), true);
  });

  it("worktreeOpenRowTitle falls back branch, path basename, label, worktree", async () => {
    const { ctx } = boot();
    assert.equal(ctx.worktreeOpenRowTitle({ branch: "b", path: "/x" }), "b");
    assert.equal(ctx.worktreeOpenRowTitle({ path: "/repo/worktrees/feat" }), "feat");
    assert.equal(ctx.worktreeOpenRowTitle({ label: "L" }), "L");
    assert.equal(ctx.worktreeOpenRowTitle({}), "worktree");
  });

  it("defaultBaseBranch prefers main, then master, then the first branch", async () => {
    const { ctx } = boot();
    ctx.state.openWorktreeBranches = ["dev", "master"];
    assert.equal(ctx.defaultBaseBranch(), "master");
    ctx.state.openWorktreeBranches = ["dev", "main", "master"];
    assert.equal(ctx.defaultBaseBranch(), "main");
    ctx.state.openWorktreeBranches = ["dev"];
    assert.equal(ctx.defaultBaseBranch(), "dev");
    ctx.state.openWorktreeBranches = [];
    assert.equal(ctx.defaultBaseBranch(), "");
  });
});