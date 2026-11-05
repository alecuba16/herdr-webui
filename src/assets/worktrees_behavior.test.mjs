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

  it("discoverWorktrees transport failure with a path surfaces the error", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => { throw new Error("boom"); },
    });
    getElement("worktreeDiscoverPath").value = "/tmp/plain";
    await ctx.discoverWorktrees();
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /Git discovery failed: boom/,
    );
  });

  it("discoverWorktrees surfaces a backend git_error as a discovery failure", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => ({
        result: {
          source: { repo_name: "app", source_checkout_path: "/repo/main" },
          worktrees: [],
          git_error: "xcrun: error: unable to load libxcrun",
        },
      }),
    });
    getElement("worktreeDiscoverPath").value = "/repo/main";
    await ctx.discoverWorktrees();
    assert.match(
      getElement("worktreeOpenList").innerHTML,
      /Git discovery failed: xcrun: error: unable to load libxcrun/,
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
describe("workspace drag and drop ordering", () => {
  function dragBoot() {
    const { ctx, calls, getElement } = boot({ "/api/workspace-order": { ok: 1 } });
    ctx.state.workspaces = [
      { workspace_id: "ws-1" },
      { workspace_id: "ws-2" },
      { workspace_id: "ws-3" },
    ];
    ctx.state.workspaceOrder = ["ws-1", "ws-2", "ws-3"];
    ctx.state.dragWorkspace = null;
    const card = element();
    const order = [];
    return {
      ctx, calls, getElement, order,
      card,
      evt(overrides = {}) {
        return Object.assign({
          preventDefault() { order.push("preventDefault"); },
          currentTarget: card,
          dataTransfer: { setData() {}, effectAllowed: "" },
        }, overrides);
      },
    };
  }

  it("workspaceDragStart records the source and stamps the drag class", async () => {
    const { ctx, card } = dragBoot();
    const data = {};
    ctx.workspaceDragStart(
      { currentTarget: card, dataTransfer: { setData: (k, v) => (data[k] = v), effectAllowed: "" } },
      "ws-2",
    );
    assert.equal(ctx.state.dragWorkspace, "ws-2");
    assert.ok(card.classList.contains("workspace-drag"));
    assert.equal(data["text/plain"], "ws-2");
  });

  it("workspaceDragStart survives a dataTransfer that throws", async () => {
    const { ctx, card } = dragBoot();
    ctx.workspaceDragStart(
      {
        currentTarget: card,
        dataTransfer: { setData() { throw new Error("detached"); }, effectAllowed: "" },
      },
      "ws-1",
    );
    assert.equal(ctx.state.dragWorkspace, "ws-1");
  });

  it("workspaceDragOver only accepts when a different workspace is being dragged", async () => {
    const { ctx, evt, order } = dragBoot();
    ctx.options.workspaceSort = "drag";
    ctx.state.dragWorkspace = "ws-1";
    ctx.workspaceDragOver(evt(), "ws-2");
    assert.deepEqual(order, ["preventDefault"]);
    ctx.workspaceDragOver(evt(), "ws-1");
    assert.deepEqual(order, ["preventDefault"]);
    ctx.options.workspaceSort = "name";
    ctx.workspaceDragOver(evt(), "ws-2");
    assert.deepEqual(order, ["preventDefault"]);
    ctx.state.dragWorkspace = null;
    ctx.options.workspaceSort = "drag";
    ctx.workspaceDragOver(evt(), "ws-2");
    assert.deepEqual(order, ["preventDefault"]);
  });

  it("workspaceDragLeave and workspaceDragEnd clear the drop markers", async () => {
    const { ctx, card } = dragBoot();
    const dropCards = [element(), element()];
    dropCards[0].classList.add("workspace-drop");
    dropCards[1].classList.add("workspace-drop");
    const qsa = [];
    ctx.document.querySelectorAll = (sel) => { qsa.push(sel); return dropCards; };
    ctx.workspaceDragLeave({ currentTarget: card });
    assert.ok(!card.classList.contains("workspace-drop"));
    ctx.workspaceDragEnd({ currentTarget: card });
    assert.ok(!card.classList.contains("workspace-drag"));
    assert.ok(!dropCards[0].classList.contains("workspace-drop"));
    assert.ok(!dropCards[1].classList.contains("workspace-drop"));
    assert.equal(ctx.state.dragWorkspace, null);
  });

  it("workspaceDrop reorders the persisted order and posts it once", async () => {
    const { ctx, calls, order } = dragBoot();
    ctx.options.workspaceSort = "drag";
    ctx.state.dragWorkspace = "ws-3";
    const target = element();
    const evt = {
      preventDefault() { order.push("drop-preventDefault"); },
      currentTarget: target,
    };
    await ctx.workspaceDrop(evt, "ws-1");
    assert.deepEqual([...ctx.state.workspaceOrder], ["ws-3", "ws-1", "ws-2"]);
    const orderCalls = calls.filter((c) => c.path === "/api/workspace-order");
    assert.equal(orderCalls.length, 1);
    assert.deepEqual(JSON.parse(orderCalls[0].init.body).order, ["ws-3", "ws-1", "ws-2"]);
  });

  it("workspaceDrop ignores a drop without a live drag", async () => {
    const { ctx, calls } = dragBoot();
    await ctx.workspaceDrop({ preventDefault() {}, currentTarget: element() }, "ws-1");
    assert.equal(calls.filter((c) => c.path === "/api/workspace-order").length, 0);
  });
});

describe("openWorktreesForRepo discovery entry", () => {
  it("seeds rows and source from state and opens the modal", async () => {
    const { ctx, getElement, calls } = boot({ "/api/worktrees": DISCOVER_REPLY });
    ctx.state.worktrees = [
      {
        is_linked_worktree: true,
        path: "/repo/worktrees/feat",
        label: "feat",
        branch: "feat",
        source_workspace_id: "ws-1",
        source_repo_key: "/repo",
        source_repo_name: "app",
        source_repo_root: "/repo",
        source_cwd: "/repo/main",
        last_activity: "2024-05-02T10:00:00Z",
      },
      {
        is_linked_worktree: false,
        path: "/repo",
        label: "app",
        branch: "main",
        source_workspace_id: "ws-1",
        source_repo_key: "/repo",
        source_repo_name: "app",
        source_repo_root: "/repo",
        source_cwd: "/repo",
        last_activity: "2024-05-03T10:00:00Z",
      },
    ];
    ctx.openWorktreesForRepo(encodeURIComponent("/repo"));
    assert.equal(getElement("worktreeOpenModal").style.display, "grid");
    assert.equal(ctx.state.openWorktreeSource.repo_name, "app");
    assert.equal(ctx.state.openWorktreeRows.length, 1);
    assert.equal(ctx.state.openWorktreeRows[0].path, "/repo/worktrees/feat");
    assert.equal(getElement("worktreeDiscoverPath").value, "/repo/main");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
  });

  it("falls back to loadWorktreeBranchOptions when no path is set", async () => {
    // With no rows the derived source has no git repo, so branch loading
    // returns early without a fetch; the modal still opens.
    const { ctx, getElement, calls } = boot({ "/api/git-branches": { branches: ["main"] } });
    ctx.state.worktrees = [];
    ctx.state.openWorktreeSource = null;
    ctx.openWorktreesForRepo(encodeURIComponent("/repo"), "");
    assert.equal(ctx.state.openWorktreeSource.cwd, null);
    assert.equal(getElement("worktreeOpenModal").style.display, "grid");
    assert.equal(ctx.state.openWorktreeBranches == null ? 0 : ctx.state.openWorktreeBranches.length, 0);
    assert.equal(calls.filter((c) => c.path === "/api/git-branches").length, 0);
  });
});

describe("worktree create modal paths", () => {
  it("closeWorktreeCreateModal hides the modal and clears the autodiscover timer", async () => {
    const { ctx, getElement } = boot();
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo" }];
    ctx.openWorktreeCreateModal("ws-1");
    assert.equal(getElement("worktreeCreateModal").style.display, "grid");
    ctx.closeWorktreeCreateModal();
    assert.equal(getElement("worktreeCreateModal").style.display, "none");
    assert.equal(ctx.state.createWorktreeWorkspace, null);
    assert.equal(ctx.state.createWorktreeSource, null);
  });

  it("openWorktreesForWorkspace routes into the location bar discovery flow", async () => {
    const { ctx } = boot();
    const routed = [];
    // The real location bar re-syncs asynchronously after routing; the
    // harness has no server, so a stub keeps the test hermetic.
    ctx.window.HerdrLocationBar = {
      openDiscoveryForFolder: (p) => routed.push(p),
      sync: () => {},
    };
    ctx.openWorktreesForWorkspace({ workspace_id: "ws-1", cwd: "/repo" }, "k");
    assert.deepEqual(routed, ["/repo"]);
  });

  it("scheduleCreateWorktreeAutodiscover clears loading when the input empties", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeCreateSource").value = "";
    ctx.scheduleCreateWorktreeAutodiscover();
    const loading = getElement("worktreeCreateLoading");
    assert.equal(loading.classList.contains("show"), false);
  });

  it("discoverCreateWorktreeSource failure leaves the error text and clears source", async () => {
    const { ctx, getElement } = boot({
      "/api/worktrees": () => { throw new Error("boom"); },
    });
    getElement("worktreeCreateSource").value = "/repo";
    await ctx.discoverCreateWorktreeSource();
    assert.equal(getElement("worktreeCreateError").textContent, "boom");
    assert.equal(ctx.state.createWorktreeSource, null);
  });
});

describe("smart modal workspace creation", () => {
  it("createWorkspaceFromSmartModal requires a folder", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeDiscoverPath").value = "";
    await ctx.createWorkspaceFromSmartModal();
    assert.equal(getElement("worktreeOpenError").textContent, "Folder is required.");
  });

  it("createWorkspaceFromSmartModal requires a name", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeDiscoverPath").value = "/repo";
    getElement("worktreeWorkspaceLabel").value = "";
    await ctx.createWorkspaceFromSmartModal();
    assert.equal(getElement("worktreeOpenError").textContent, "Workspace name is required.");
  });

  it("createWorkspaceFromSmartModal posts the workspace and the recent entry, then navigates", async () => {
    const navigations = [];
    const { ctx, getElement, calls } = boot({
      "/api/workspaces": { result: { workspace: { workspace_id: "ws-new" } } },
      "/api/recent-workspaces": { ok: 1 },
    });
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    getElement("worktreeDiscoverPath").value = "/repo";
    getElement("worktreeWorkspaceLabel").value = "app";
    await ctx.createWorkspaceFromSmartModal();
    const wsPost = calls.find((c) => c.path === "/api/workspaces" && c.init && c.init.method === "POST");
    assert.ok(wsPost, "must POST /api/workspaces");
    assert.equal(JSON.parse(wsPost.init.body).cwd, "/repo");
    assert.ok(calls.some((c) => c.path === "/api/recent-workspaces"));
    assert.equal(getElement("worktreeOpenModal").style.display, "none");
    assert.deepEqual(navigations, [["ws-new", undefined, undefined]]);
  });

  it("createWorkspaceFromSmartModal surfaces a backend error and re-enables the submit", async () => {
    const { ctx, getElement, calls } = boot({
      "/api/workspaces": () => { throw new Error("nope"); },
    });
    getElement("worktreeDiscoverPath").value = "/repo";
    getElement("worktreeWorkspaceLabel").value = "app";
    await ctx.createWorkspaceFromSmartModal();
    assert.equal(getElement("worktreeOpenError").textContent, "nope");
    assert.equal(getElement("worktreeWorkspaceSubmit").disabled, false);
    assert.equal(calls.filter((c) => c.path === "/api/workspaces").length, 1);
  });
});

describe("removeWorktree and force-remove flows", () => {
  function row() {
    return {
      is_linked_worktree: true,
      path: "/repo/worktrees/feat",
      label: "feat",
      branch: "feat",
      source_repo_root: "/repo",
      source_workspace_id: null,
      source_cwd: "/repo/main",
      open_workspace_id: null,
    };
  }

  it("removeDiscoveredWorktree force-removes after a refused plain removal", async () => {
    const questions = [];
    let removeAttempts = 0;
    const { ctx, calls } = boot({
      "/api/worktrees": DISCOVER_REPLY,
      "/api/worktrees/remove-path": () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("worktree has modifications");
        return { ok: 1 };
      },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    ctx.refresh = () => {};
    ctx.state.openWorktreeRows = [row()];
    await ctx.removeDiscoveredWorktree(0);
    assert.equal(questions.length, 2);
    assert.match(questions[1].title, /Force remove worktree\?/);
    const removeCalls = calls.filter((c) => c.path === "/api/worktrees/remove-path");
    assert.equal(removeCalls.length, 2);
    assert.equal(JSON.parse(removeCalls[1].init.body).force, true);
  });

  it("removeDiscoveredWorktree keeps the error when force is declined", async () => {
    const { ctx, getElement, calls } = boot({
      "/api/worktrees/remove-path": () => { throw new Error("locked"); },
    });
    let decline = false;
    ctx.askQuestion = async () => { if (decline) return false; decline = true; return true; };
    ctx.state.openWorktreeRows = [row()];
    await ctx.removeDiscoveredWorktree(0);
    assert.equal(getElement("worktreeOpenError").textContent, "locked");
    assert.equal(calls.filter((c) => c.path === "/api/worktrees/remove-path").length, 1);
  });

  it("removeDiscoveredWorktree closes an open workspace through its endpoint", async () => {
    const { ctx, calls } = boot({
      "/api/worktrees": DISCOVER_REPLY,
      "/api/workspaces/ws-9/worktree-remove": { ok: 1 },
    });
    ctx.askQuestion = async () => true;
    ctx.refresh = () => {};
    ctx.state.workspaces = [{ workspace_id: "ws-9", cwd: "/repo/worktrees/feat" }];
    const r = row();
    r.open_workspace_id = "ws-9";
    ctx.state.openWorktreeRows = [r];
    await ctx.removeDiscoveredWorktree(0);
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-9/worktree-remove"));
  });

  it("removeWorktree asks first and posts the close-then-remove call", async () => {
    const questions = [];
    const { ctx, calls } = boot({
      "/api/workspaces/ws-9/worktree-remove": { ok: 1 },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    ctx.refresh = () => {};
    ctx.state.workspaces = [
      { workspace_id: "ws-9", label: "feat", worktree: { is_linked_worktree: true, branch: "feat" } },
    ];
    await ctx.removeWorktree("ws-9");
    assert.equal(questions.length, 1);
    assert.match(questions[0].title, /Remove worktree from disk\?/);
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-9/worktree-remove"));
  });

  it("removeWorktree force-removes when the first call is refused", async () => {
    let removeAttempts = 0;
    const { ctx, calls } = boot({
      "/api/workspaces/ws-9/worktree-remove": () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("dirty");
        return { ok: 1 };
      },
    });
    ctx.askQuestion = async () => true;
    ctx.refresh = () => {};
    ctx.state.workspaces = [
      { workspace_id: "ws-9", label: "feat", worktree: { is_linked_worktree: true } },
    ];
    await ctx.removeWorktree("ws-9");
    const removeCalls = calls.filter((c) => c.path === "/api/workspaces/ws-9/worktree-remove");
    assert.equal(removeCalls.length, 2);
    assert.equal(JSON.parse(removeCalls[1].init.body).force, true);
  });

  it("removeWorktree aborts when the confirm is declined", async () => {
    const { ctx, calls } = boot();
    ctx.askQuestion = async () => false;
    ctx.state.workspaces = [
      { workspace_id: "ws-9", label: "feat", worktree: { is_linked_worktree: true } },
    ];
    await ctx.removeWorktree("ws-9");
    assert.equal(calls.filter((c) => c.path === "/api/workspaces/ws-9/worktree-remove").length, 0);
  });
});

describe("tab and workspace rename flows", () => {
  it("startWorkspaceRename renders an input and selects it", async () => {
    const { ctx } = boot();
    const selected = [];
    const input = element();
    input.select = () => selected.push(1);
    ctx.document.querySelector = () => input;
    const renders = [];
    ctx.render = () => renders.push(1);
    ctx.startWorkspaceRename("ws-1", "main");
    assert.equal(ctx.state.editingWorkspace, "ws-1");
    assert.equal(ctx.state.editingWorkspaceValue, "main");
    // The harness setTimeout is a stub that never fires, so the deferred
    // select() cannot run here; the editing state and the immediate
    // render are the observable contract.
    assert.ok(renders.length >= 1);
  });

  it("workspaceCardKeydown starts rename on F2 and Enter on the selected card", async () => {
    const { ctx } = boot();
    const starts = [];
    ctx.startWorkspaceRename = (id, label) => starts.push([id, label]);
    const target = { closest: () => null };
    ctx.workspaceCardKeydown({ key: "F2", target, preventDefault() {}, stopPropagation() {} }, "ws-1", "main", false);
    ctx.workspaceCardKeydown({ key: "Enter", target, preventDefault() {}, stopPropagation() {} }, "ws-1", "main", true);
    ctx.workspaceCardKeydown({ key: "Enter", target, preventDefault() {}, stopPropagation() {} }, "ws-1", "main", false);
    ctx.workspaceCardKeydown({ key: "F2", ctrlKey: true, target, preventDefault() {}, stopPropagation() {} }, "ws-1", "main", false);
    ctx.workspaceCardKeydown({ key: "F2", target: { closest: () => ({}) }, preventDefault() {}, stopPropagation() {} }, "ws-1", "main", false);
    assert.deepEqual(starts, [["ws-1", "main"], ["ws-1", "main"]]);
  });

  it("commitWorkspaceRename posts the label and refreshes", async () => {
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/rename": { ok: 1 },
    });
    const refreshes = [];
    ctx.refresh = () => refreshes.push(1);
    ctx.state.editingWorkspace = "ws-1";
    ctx.state.editingWorkspaceValue = "renamed";
    await ctx.commitWorkspaceRename("ws-1");
    const rename = calls.find((c) => c.path === "/api/workspaces/ws-1/rename");
    assert.ok(rename, "must POST rename");
    assert.equal(JSON.parse(rename.init.body).label, "renamed");
    assert.ok(refreshes.length >= 1);
  });

  it("commitWorkspaceRename with an empty label posts nothing", async () => {
    const { ctx, calls } = boot();
    ctx.refresh = () => {};
    ctx.state.editingWorkspace = "ws-1";
    ctx.state.editingWorkspaceValue = "  ";
    await ctx.commitWorkspaceRename("ws-1");
    assert.equal(calls.filter((c) => c.path === "/api/workspaces/ws-1/rename").length, 0);
  });

  it("startTabRename and tabRenameKey drive the tab rename flow", async () => {
    const { ctx, calls } = boot({ "/api/tabs/t-1/rename": { ok: 1 } });
    ctx.refresh = () => {};
    ctx.document.querySelector = () => element();
    ctx.startTabRename("t-1", "tab");
    assert.equal(ctx.state.editingTab, "t-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.tabRenameKey({ key: "Escape" }, "t-1");
    assert.equal(ctx.state.editingTab, null);
    ctx.startTabRename("t-1", "tab");
    ctx.state.editingTabValue = "renamed-tab";
    ctx.tabRenameKey({ key: "Enter", preventDefault() {} }, "t-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rename = calls.find((c) => c.path === "/api/tabs/t-1/rename");
    assert.ok(rename, "must POST tab rename");
    assert.equal(JSON.parse(rename.init.body).label, "renamed-tab");
  });

  it("commitTabRename ignores a mismatched tab id", async () => {
    const { ctx, calls } = boot();
    ctx.state.editingTab = "t-9";
    ctx.state.editingTabValue = "x";
    await ctx.commitTabRename("t-1");
    assert.equal(calls.filter((c) => c.path === "/api/tabs/t-1/rename").length, 0);
  });

  it("workspaceRenameKey Escape clears the editing state", async () => {
    const { ctx } = boot();
    ctx.render = () => {};
    ctx.state.editingWorkspace = "ws-1";
    ctx.workspaceRenameKey({ key: "Escape" }, "ws-1");
    assert.equal(ctx.state.editingWorkspace, null);
    assert.equal(ctx.state.editingWorkspaceValue, "");
  });
});

describe("closeTab and closeWorkspace variants", () => {
  it("closeTab confirms, closes the tab, and drops the closed state", async () => {
    const { ctx, calls, getElement } = boot({
      "/api/tabs/t-1/close": { ok: 1 },
    });
    ctx.askQuestion = async () => true;
    ctx.refresh = () => {};
    ctx.state.tabs = [{ tab_id: "t-1", workspace_id: "ws-1", title: "shell" }];
    ctx.state.allTabs = [];
    ctx.state.ws = "ws-1";
    ctx.state.tab = "t-1";
    const renders = [];
    ctx.render = () => renders.push(1);
    await ctx.closeTab("t-1");
    assert.ok(calls.some((c) => c.path === "/api/tabs/t-1/close"));
    assert.equal(ctx.state.tab, null);
    assert.ok(renders.length >= 1);
  });

  it("closeTab swallows a not-found close and still cleans up", async () => {
    const { ctx, calls } = boot({
      "/api/tabs/t-1/close": async () => { throw new Error("tab not found"); },
    });
    ctx.askQuestion = async () => true;
    ctx.refresh = () => {};
    ctx.render = () => {};
    ctx.state.tabs = [{ tab_id: "t-1", workspace_id: "ws-1" }];
    ctx.state.allTabs = [];
    ctx.state.ws = "ws-1";
    ctx.state.tab = "t-1";
    await ctx.closeTab("t-1");
    assert.ok(calls.some((c) => c.path === "/api/tabs/t-1/close"));
    assert.equal(ctx.state.tab, null);
  });

  it("closeTab aborts when the confirm is declined", async () => {
    const { ctx, calls } = boot();
    ctx.askQuestion = async () => false;
    await ctx.closeTab("t-1");
    assert.equal(calls.filter((c) => c.path === "/api/tabs/t-1/close").length, 0);
  });

  it("closeWorkspace close mode also reopens linked worktrees", async () => {
    const questions = [];
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/close": { ok: 1 },
      "/api/worktrees/open": { result: { workspace: { workspace_id: "wt-2" } } },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    ctx.refresh = () => {};
    ctx.state.workspaces = [
      { workspace_id: "ws-1", label: "main", worktree: { repo_root: "/repo" } },
      {
        workspace_id: "wt-2",
        label: "feat",
        worktree: { is_linked_worktree: true, repo_root: "/repo", checkout_path: "/repo/worktrees/feat" },
      },
    ];
    ctx.options.parentCloseMode = "close";
    await ctx.closeWorkspace("ws-1");
    assert.match(questions[0].message, /close 1 linked worktree/);
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-1/close"));
    const reopen = calls.find((c) => c.path === "/api/worktrees/open");
    assert.ok(reopen, "must reopen linked worktrees");
    assert.equal(JSON.parse(reopen.init.body).path, "/repo/worktrees/feat");
  });

  it("closeWorkspace panels mode closes panels only", async () => {
    const questions = [];
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/close": { ok: 1 },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    ctx.refresh = () => {};
    ctx.state.workspaces = [
      { workspace_id: "ws-1", label: "main", worktree: { repo_root: "/repo" } },
      {
        workspace_id: "wt-2",
        label: "feat",
        worktree: { is_linked_worktree: true, repo_root: "/repo", checkout_path: "/repo/worktrees/feat" },
      },
    ];
    ctx.options.parentCloseMode = "panels";
    await ctx.closeWorkspace("ws-1");
    assert.match(questions[0].title, /Close workspace panels\?/);
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-1/close"));
  });

  it("closeWorkspaceById clears selection when the closed workspace was selected", async () => {
    const { ctx, calls } = boot({
      "/api/workspaces/ws-1/close": { ok: 1 },
    });
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main" }];
    ctx.state.ws = "ws-1";
    ctx.state.tab = "t-1";
    ctx.state.pane = "p-1";
    await ctx.closeWorkspaceById("ws-1");
    assert.ok(calls.some((c) => c.path === "/api/workspaces/ws-1/close"));
    assert.equal(ctx.state.ws, null);
    assert.equal(ctx.state.tab, null);
    assert.equal(ctx.state.pane, null);
  });

  it("closePaneById posts the pane close", async () => {
    const { ctx, calls } = boot({ "/api/panes/p-1/close": { ok: 1 } });
    await ctx.closePaneById("p-1");
    assert.ok(calls.some((c) => c.path === "/api/panes/p-1/close"));
  });
});

describe("branch option loading and sync helpers", () => {
  it("loadWorktreeBranchOptions skips fetches for a source without a git repo", async () => {
    const { ctx, calls } = boot();
    ctx.state.openWorktreeSource = { cwd: "/repo", repo_root: "" };
    await ctx.loadWorktreeBranchOptions();
    assert.equal(ctx.state.openWorktreeBranches.length, 0);
    assert.equal(ctx.state.openWorktreeBranchSourceKey, "");
    assert.equal(calls.filter((c) => c.path === "/api/git-branches").length, 0);
  });

  it("loadWorktreeBranchOptions caches per source and remote flag", async () => {
    const { ctx, calls } = boot({ "/api/git-branches": { branches: ["main", "feat"] } });
    ctx.state.openWorktreeSource = { cwd: "/repo", repo_root: "/repo" };
    await ctx.loadWorktreeBranchOptions();
    await ctx.loadWorktreeBranchOptions();
    assert.equal(calls.filter((c) => c.path === "/api/git-branches").length, 1);
    assert.deepEqual(ctx.state.openWorktreeBranches, ["main", "feat"]);
    assert.match(getElement0(ctx, "worktreeBranchOptions").innerHTML, /Fetch remote branches…/);
  });

  it("fetchWorktreeRemoteBranches fetches with remote flags", async () => {
    const { ctx, calls } = boot({ "/api/git-branches": { branches: ["main", "origin/dev"] } });
    ctx.state.openWorktreeSource = { cwd: "/repo", repo_root: "/repo" };
    await ctx.fetchWorktreeRemoteBranches();
    const branchCalls = calls.filter((c) => c.path === "/api/git-branches");
    assert.equal(branchCalls.length, 1);
    assert.equal(branchCalls[0].params.get("remote"), "true");
    assert.equal(branchCalls[0].params.get("fetch"), "true");
    assert.equal(ctx.state.openWorktreeIncludeRemoteBranches, true);
    assert.ok(!getElement0(ctx, "worktreeBranchOptions").innerHTML.includes("Fetch remote branches"));
  });

  it("loadWorktreeBranchOptions clears state on a transport failure", async () => {
    const { ctx } = boot({ "/api/git-branches": () => { throw new Error("x"); } });
    ctx.state.openWorktreeSource = { cwd: "/repo", repo_root: "/repo" };
    await ctx.loadWorktreeBranchOptions();
    assert.equal(ctx.state.openWorktreeBranches.length, 0);
    assert.equal(ctx.state.openWorktreeBranchSourceKey, "");
  });

  it("syncBranchNameFromBase with Fetch remote clears base and loads remotes", async () => {
    const { ctx, calls } = boot({ "/api/git-branches": { branches: ["origin/dev"] } });
    const bar = ctx.document.getElementById("worktreeNewBase");
    bar.value = "Fetch remote branches…";
    ctx.state.openWorktreeSource = { cwd: "/repo", repo_root: "/repo" };
    ctx.syncBranchNameFromBase();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bar.value, "");
    assert.equal(ctx.state.openWorktreeIncludeRemoteBranches, true);
    assert.ok(calls.some((c) => c.path === "/api/git-branches"));
  });

  it("syncBranchNameFromBase mirrors a non-default base into the branch input", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeNewBase").value = "origin/dev";
    getElement("worktreeNewBranch").value = "";
    ctx.state.openWorktreeBranches = ["main", "origin/dev"];
    ctx.state.openWorktreeBaseBranchName = "";
    const synced = [];
    ctx.syncWorktreeCheckoutPath = () => synced.push(1);
    ctx.syncBranchNameFromBase();
    assert.equal(getElement("worktreeNewBranch").value, "dev");
    assert.equal(ctx.state.openWorktreeBaseBranchName, "dev");
    assert.deepEqual(synced, [1]);
  });

  it("syncBranchNameFromBase clears the mirrored branch when the base is the default", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeNewBase").value = "main";
    getElement("worktreeNewBranch").value = "main";
    ctx.state.openWorktreeBranches = ["main"];
    ctx.state.openWorktreeBaseBranchName = "main";
    const synced = [];
    ctx.syncWorktreeCheckoutPath = () => synced.push(1);
    ctx.syncBranchNameFromBase();
    assert.equal(getElement("worktreeNewBranch").value, "");
    assert.equal(ctx.state.openWorktreeBaseBranchName, "");
  });

  it("syncBranchNameFromBase keeps a user-typed branch that differs from the mirror", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeNewBase").value = "origin/dev";
    getElement("worktreeNewBranch").value = "my-own";
    ctx.state.openWorktreeBranches = ["main", "origin/dev"];
    ctx.state.openWorktreeBaseBranchName = "";
    const synced = [];
    ctx.syncWorktreeCheckoutPath = () => synced.push(1);
    ctx.syncBranchNameFromBase();
    assert.equal(getElement("worktreeNewBranch").value, "my-own");
    assert.deepEqual(synced, []);
  });

  it("syncWorktreeCheckoutPath fills the default and clears it when branch empties", async () => {
    const { ctx, getElement } = boot();
    // joinPath normalizes ../ against the repo root, so the default
    // directory ../worktrees resolves to a sibling of the repo root.
    ctx.state.openWorktreeSource = { cwd: "/repo/main", repo_name: "app", repo_root: "/repo", default_worktree_directory: "../worktrees" };
    getElement("worktreeNewBranch").value = "feat";
    ctx.syncWorktreeCheckoutPath();
    assert.equal(getElement("worktreeNewPath").value, "/worktrees/app/feat");
    assert.equal(ctx.state.openWorktreeDefaultPath, "/worktrees/app/feat");
    getElement("worktreeNewBranch").value = "";
    ctx.syncWorktreeCheckoutPath();
    assert.equal(getElement("worktreeNewPath").value, "");
    assert.equal(ctx.state.openWorktreeDefaultPath, "");
  });

  it("worktreeOpenInitialPath prefers the given path, then the configured default", async () => {
    const { ctx } = boot();
    assert.equal(ctx.worktreeOpenInitialPath("/repo"), "/repo");
    ctx.options.explorationDefaultDirectory = "/default";
    assert.equal(ctx.worktreeOpenInitialPath(""), "/default");
    // A bare / is not a useful default, so the option fallback wins again.
    assert.equal(ctx.worktreeOpenInitialPath("/"), "/default");
  });
});

function getElement0(ctx, id) {
  return ctx.document.getElementById(id);
}

describe("submitWorktreeCreate flow", () => {
  function createInput(ctx, getElement, overrides = {}) {
    return Object.assign({
      errEl: getElement("worktreeCreateError"),
      submitEl: getElement("worktreeCreateSubmit"),
      closeFn: () => { getElement("worktreeCreateModal").style.display = "none"; },
      source: { workspace_id: "ws-1", cwd: "/repo/main", repo_name: "app", repo_root: "/repo" },
      branch: "feat-x",
      base: "main",
      label: "",
      path: "",
      pullBase: false,
    }, overrides);
  }

  it("posts the built body, closes the modal, and navigates", async () => {
    const navigations = [];
    const { ctx, getElement, calls } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST")
          return { result: { workspace: { workspace_id: "wt-1" }, tab: { tab_id: "t-1" }, root_pane: { pane_id: "p-1" } } };
        return DISCOVER_REPLY;
      },
    });
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    getElement("worktreeCreateModal").style.display = "grid";
    await ctx.submitWorktreeCreate(createInput(ctx, getElement));
    const post = calls.find((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST");
    assert.ok(post, "must POST /api/worktrees");
    assert.equal(JSON.parse(post.init.body).branch, "feat-x");
    assert.equal(getElement("worktreeCreateModal").style.display, "none");
    assert.deepEqual(navigations, [["wt-1", "t-1", "p-1"]]);
    assert.equal(getElement("worktreeCreateSubmit").disabled, false);
  });

  it("surfaces the validation error without posting", async () => {
    const { ctx, getElement, calls } = boot();
    await ctx.submitWorktreeCreate(createInput(ctx, getElement, { branch: "" }));
    assert.match(getElement("worktreeCreateError").textContent, /Branch name is required/);
    assert.equal(calls.filter((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST").length, 0);
  });

  it("retries once without pull_base after a fast-forward failure when confirmed", async () => {
    const questions = [];
    let posts = 0;
    const { ctx, getElement, calls } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST") {
          posts += 1;
          if (posts === 1) throw new Error("Not possible to fast-forward, aborting");
          return { result: { workspace: { workspace_id: "wt-2" }, tab: { tab_id: "t-2" }, root_pane: { pane_id: "p-2" } } };
        }
        return DISCOVER_REPLY;
      },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    const navigations = [];
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    await ctx.submitWorktreeCreate(createInput(ctx, getElement, { pullBase: true }));
    assert.equal(posts, 2);
    const bodies = calls
      .filter((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST")
      .map((c) => JSON.parse(c.init.body));
    assert.equal(bodies[0].pull_base, true);
    assert.equal(bodies[1].pull_base, false);
    assert.deepEqual(navigations, [["wt-2", "t-2", "p-2"]]);
  });

  it("keeps the error when the continue-without-pull question is declined", async () => {
    const { ctx, getElement, calls } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST") throw new Error("Not possible to fast-forward, aborting");
        return DISCOVER_REPLY;
      },
    });
    ctx.askQuestion = async () => false;
    await ctx.submitWorktreeCreate(createInput(ctx, getElement, { pullBase: true }));
    assert.match(getElement("worktreeCreateError").textContent, /fast-forward/);
    assert.equal(getElement("worktreeCreateSubmit").disabled, false);
  });

  it("surfaces a non-pull error without asking", async () => {
    const questions = [];
    const { ctx, getElement } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST") throw new Error("branch exists");
        return DISCOVER_REPLY;
      },
    });
    ctx.askQuestion = async (q) => { questions.push(q); return true; };
    await ctx.submitWorktreeCreate(createInput(ctx, getElement, { pullBase: true }));
    assert.equal(questions.length, 0);
    assert.equal(getElement("worktreeCreateError").textContent, "branch exists");
  });
});

describe("autodiscover timer and suggestions", () => {
  // Fires the next `count` timer callbacks synchronously inside the call
  // and reverts immediately. A permanently-live firing override would
  // loop boot-time pollers (promise chains that reschedule through
  // setTimeout) into an infinite microtask chain and hang the runner.
  function withFiringTimers(booted, count, run) {
    const inert = booted.ctx.setTimeout;
    let left = count;
    booted.ctx.setTimeout = (fn) => {
      if (left > 0) { left -= 1; fn(); }
      return 1;
    };
    try {
      return run();
    } finally {
      booted.ctx.setTimeout = inert;
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("scheduleCreateWorktreeAutodiscover discovers while the modal is open", async () => {
    const booted = boot({ "/api/worktrees": DISCOVER_REPLY });
    const { ctx, getElement, calls } = booted;
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo" }];
    ctx.openWorktreeCreateModal("ws-1");
    getElement("worktreeCreateSource").value = "/repo";
    withFiringTimers(booted, 1, () => ctx.scheduleCreateWorktreeAutodiscover());
    await tick();
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
    assert.ok(ctx.state.createWorktreeSource, "source discovered through the timer");
  });

  it("scheduleCreateWorktreeAutodiscover skips discovery when the modal closed meanwhile", async () => {
    const booted = boot({ "/api/worktrees": DISCOVER_REPLY });
    const { ctx, getElement } = booted;
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo" }];
    ctx.openWorktreeCreateModal("ws-1");
    getElement("worktreeCreateSource").value = "/repo";
    ctx.closeWorktreeCreateModal();
    withFiringTimers(booted, 1, () => ctx.scheduleCreateWorktreeAutodiscover());
    assert.equal(getElement("worktreeCreateLoading").classList.contains("show"), false);
  });

  it("scheduleWorktreeAutodiscover rediscovers while the open modal is up", async () => {
    const booted = boot({ "/api/worktrees": DISCOVER_REPLY });
    const { ctx, getElement, calls } = booted;
    ctx.openWorktreeOpenModal("/repo");
    getElement("worktreeDiscoverPath").value = "/repo";
    withFiringTimers(booted, 1, () => ctx.scheduleWorktreeAutodiscover());
    await tick();
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
  });

  it("scheduleWorktreeAutodiscover clears loading when the modal closed meanwhile", async () => {
    const booted = boot({ "/api/worktrees": DISCOVER_REPLY });
    const { ctx, getElement } = booted;
    ctx.openWorktreeOpenModal("/repo");
    getElement("worktreeDiscoverPath").value = "/repo";
    ctx.closeWorktreeOpenModal();
    withFiringTimers(booted, 1, () => ctx.scheduleWorktreeAutodiscover());
    assert.equal(getElement("worktreeLoading").classList.contains("show"), false);
  });

  it("clearCreateWorktreeSuggestions empties the datalist options", async () => {
    const { ctx, getElement } = boot();
    getElement("worktreeCreatePathOptions").innerHTML = "<option value='/x'></option>";
    ctx.clearCreateWorktreeSuggestions();
    assert.equal(getElement("worktreeCreatePathOptions").innerHTML, "");
  });
});

describe("rename input focus timers", () => {
  it("startWorkspaceRename focuses the input once the timer fires", async () => {
    const booted = boot();
    const { ctx } = booted;
    const selected = [];
    const input = element();
    input.select = () => selected.push(1);
    ctx.document.querySelector = () => input;
    ctx.render = () => {};
    ctx.setTimeout = ((fn) => { fn(); return 1; });
    try {
      ctx.startWorkspaceRename("ws-1", "main");
    } finally {
      ctx.setTimeout = (fn) => 1;
    }
    assert.deepEqual(selected, [1]);
  });

  it("startWorkspaceRename skips the select when the editing state moved on", async () => {
    const booted = boot();
    const { ctx } = booted;
    const selected = [];
    const input = element();
    input.select = () => selected.push(1);
    ctx.document.querySelector = () => input;
    ctx.render = () => {};
    ctx.setTimeout = ((fn) => {
      ctx.state.editingWorkspace = "ws-2";
      fn();
      return 1;
    });
    try {
      ctx.startWorkspaceRename("ws-1", "main");
    } finally {
      ctx.setTimeout = (fn) => 1;
    }
    assert.deepEqual(selected, []);
  });

  it("startTabRename focuses the tab rename input once the timer fires", async () => {
    const booted = boot();
    const { ctx } = booted;
    const selected = [];
    const input = element();
    input.select = () => selected.push(1);
    ctx.document.querySelector = () => input;
    ctx.render = () => {};
    ctx.setTimeout = ((fn) => { fn(); return 1; });
    try {
      ctx.startTabRename("t-1", "tab");
    } finally {
      ctx.setTimeout = (fn) => 1;
    }
    assert.deepEqual(selected, [1]);
  });
});

describe("create modal and open modal focus timers", () => {
  it("openWorktreeCreateModal focuses the branch field through the timer", async () => {
    const booted = boot();
    const { ctx, getElement } = booted;
    ctx.state.workspaces = [{ workspace_id: "ws-1", label: "main", cwd: "/repo" }];
    ctx.setTimeout = ((fn) => { fn(); return 1; });
    try {
      ctx.openWorktreeCreateModal("ws-1");
    } finally {
      ctx.setTimeout = (fn) => 1;
    }
    assert.equal(getElement("worktreeBranch").focused, true);
  });

  it("openWorktreeOpenModal focuses the discover field through the timer", async () => {
    const booted = boot();
    const { ctx, getElement } = booted;
    ctx.setTimeout = ((fn) => { fn(); return 1; });
    try {
      ctx.openWorktreeOpenModal("/repo");
    } finally {
      ctx.setTimeout = (fn) => 1;
    }
    assert.equal(getElement("worktreeDiscoverPath").focused, true);
  });

  it("openWorktreesForRepo with a discover path value discovers immediately", async () => {
    const { ctx, calls } = boot({ "/api/worktrees": DISCOVER_REPLY });
    ctx.state.worktrees = [];
    ctx.state.worktrees.push({
      is_linked_worktree: false,
      path: "/repo",
      label: "app",
      branch: "main",
      source_workspace_id: "ws-1",
      source_repo_key: "/repo",
      source_repo_name: "app",
      source_repo_root: "/repo",
      source_cwd: "/repo",
    });
    ctx.openWorktreesForRepo(encodeURIComponent("/repo"));
    assert.ok(calls.some((c) => c.path === "/api/worktrees"));
  });
});

describe("createDiscoveredWorktree edge paths", () => {
  it("rejects a branch already checked out in a discovered row", async () => {
    const { ctx, getElement, calls } = boot();
    ctx.state.openWorktreeSource = { workspace_id: "ws-1", cwd: "/repo/main", repo_name: "app", repo_root: "/repo" };
    ctx.state.openWorktreeRows = [
      { is_linked_worktree: true, path: "/repo/worktrees/feat", branch: "feat" },
    ];
    ctx.state.openWorktreeAllRows = [
      { is_linked_worktree: true, path: "/repo/worktrees/feat", branch: "feat" },
    ];
    getElement("worktreeNewBranch").value = "feat";
    getElement("worktreeDiscoverPath").value = "/repo";
    await ctx.createDiscoveredWorktree();
    assert.match(getElement("worktreeOpenError").textContent, /already checked out/);
    assert.equal(calls.filter((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST").length, 0);
  });

  it("retries once without pull_base when the question is confirmed", async () => {
    let posts = 0;
    const { ctx, getElement, calls } = boot({
      "/api/worktrees": (params, init) => {
        if (init && init.method === "POST") {
          posts += 1;
          if (posts === 1) throw new Error("Not possible to fast-forward, aborting");
          return { result: { workspace: { workspace_id: "wt-3" }, tab: { tab_id: "t-3" }, root_pane: { pane_id: "p-3" } } };
        }
        return DISCOVER_REPLY;
      },
    });
    ctx.askQuestion = async () => true;
    const navigations = [];
    ctx.go = (ws, tab, pane) => navigations.push([ws, tab, pane]);
    ctx.state.openWorktreeSource = { workspace_id: "ws-1", cwd: "/repo/main", repo_name: "app", repo_root: "/repo" };
    getElement("worktreeNewBranch").value = "feat2";
    getElement("worktreeDiscoverPath").value = "/repo";
    getElement("worktreeNewPullBase").checked = true;
    await ctx.createDiscoveredWorktree();
    assert.equal(posts, 2);
    assert.equal(getElement("worktreeNewPullBase").checked, false);
    assert.deepEqual(navigations, [["wt-3", "t-3", "p-3"]]);
    const bodies = calls
      .filter((c) => c.path === "/api/worktrees" && c.init && c.init.method === "POST")
      .map((c) => JSON.parse(c.init.body));
    assert.equal(bodies[0].pull_base, true);
    assert.equal(bodies[1].pull_base, false);
  });

  it("forceRemoveDiscoveredWorktree with an open workspace posts force to its endpoint", async () => {
    const { ctx, calls } = boot({
      "/api/workspaces/ws-9/worktree-remove": { ok: 1 },
    });
    await ctx.forceRemoveDiscoveredWorktree({ open_workspace_id: "ws-9", path: "/w" });
    const forceCall = calls.find((c) => c.path === "/api/workspaces/ws-9/worktree-remove");
    assert.ok(forceCall, "must POST the workspace worktree-remove");
    assert.equal(JSON.parse(forceCall.init.body).force, true);
  });

  it("createWorkspaceFromSmartModal closes the modal before navigating", async () => {
    const navigations = [];
    const { ctx, getElement } = boot({
      "/api/workspaces": { result: { workspace: { workspace_id: "ws-n2" } } },
      "/api/recent-workspaces": { ok: 1 },
    });
    ctx.go = (ws) => navigations.push(ws);
    getElement("worktreeDiscoverPath").value = "/repo";
    getElement("worktreeWorkspaceLabel").value = "app2";
    await ctx.createWorkspaceFromSmartModal();
    assert.equal(getElement("worktreeOpenModal").style.display, "none");
    assert.deepEqual(navigations, ["ws-n2"]);
  });
});
