import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Integration test for the window layout reset: window.resetWindowLayout
// (app_js/render.js) clears the persisted layout stores, rebuilds fresh
// single-pane trees, hides hosted drawers, and expands both sidebars,
// behind the danger confirm modal. The Settings section lives in
// desktop/window_layout_settings.js and calls the same function.

function element(id = "") {
  const classes = new Set();
  const attributes = new Map();
  const styleProps = {};
  const node = {
    id,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : !!force;
        if (active) classes.add(name);
        else classes.delete(name);
        return active;
      },
      contains(name) { return classes.has(name); },
    },
    style: {
      setProperty(name, value) {
        styleProps[name] = String(value);
      },
      getPropertyValue(name) {
        return styleProps[name] || "";
      },
    },
    dataset: {},
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    disabled: false,
    setAttribute(name, value) { attributes.set(String(name), String(value)); },
    getAttribute(name) { return attributes.has(String(name)) ? attributes.get(String(name)) : null; },
    closest() { return this; },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild(child) {
      if (child && typeof child === "object") child.parentNode = node;
      return child;
    },
    removeChild(child) {
      if (child && typeof child === "object") child.parentNode = null;
    },
    replaceWith() {},
    remove() {
      if (node.parentNode && typeof node.parentNode.removeChild === "function")
        node.parentNode.removeChild(node);
      node.parentNode = null;
    },
    children: [],
    focus() {},
    select() {},
    addEventListener() {},
    getBoundingClientRect() { return { width: 100, height: 100 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return node;
}

function context() {
  const elements = new Map();
  const created = [];
  const getElement = (id) => {
    const made = created.find((node) => node.id === id);
    if (made) return made;
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const ctx = {
    console,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) { return 1; },
    requestAnimationFrame(fn) { fn(); },
    document: {
      body: getElement("body"),
      title: "",
      hidden: false,
      createElement: () => {
        const node = element("");
        created.push(node);
        return node;
      },
      execCommand: () => true,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
  };
  ctx.history = { pushState() {}, replaceState() {} };
  ctx.location = { pathname: "/", href: "" };
  ctx.navigator = { clipboard: {} };
  ctx.WebSocket = class {
    constructor() { this.readyState = 1; }
    send() {} close() {} addEventListener() {}
  };
  ctx.fetch = async () => ({ status: 200, ok: true, json: async () => ({}) });
  ctx.addEventListener = () => {};
  ctx.prompt = () => null;
  ctx.confirm = () => true;
  ctx.alert = () => {};
  ctx.encodeURIComponent = encodeURIComponent;
  ctx.decodeURIComponent = decodeURIComponent;
  ctx.TextEncoder = TextEncoder;
  ctx.TextDecoder = TextDecoder;
  ctx.URLSearchParams = URLSearchParams;
  ctx.clearTimeout = clearTimeout;
  ctx.setInterval = () => {};
  ctx.setTimeout = (fn) => (typeof fn === "function" ? (fn(), 1) : 1);
  ctx.requestAnimationFrame = (fn) => (typeof fn === "function" ? (fn(), 1) : 1);
  ctx.console = console;
  ctx.Error = Error;
  ctx.Math = Math;
  ctx.String = String;
  ctx.Object = Object;
  ctx.Array = Array;
  ctx.Promise = Promise;
  ctx.Symbol = Symbol;
  ctx.Map = Map;
  ctx.Set = Set;
  ctx.Date = Date;
  ctx.RegExp = RegExp;
  ctx.Number = Number;
  ctx.Boolean = Boolean;
  ctx.JSON = JSON;
  // Real Storage keeps data as own enumerable properties (methods on
  // the prototype), so Object.keys lists exactly the data keys. The
  // reset's herdr-session-state:* sweep depends on that.
  const storageProto = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(this, String(key)) ? String(this[String(key)]) : null; },
    setItem(key, value) { this[String(key)] = String(value); },
    removeItem(key) { delete this[String(key)]; },
  };
  ctx.localStorage = Object.create(storageProto);
  ctx.terminal = getElement("terminal");
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadSource() {
  // Matches the browser load order: shared scripts first (they set
  // window.HerdrAppHelpers and friends), then the DESKTOP_JS concat from
  // assets.rs (app.js route).
  const files = [
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
    "./desktop/lsp_settings.js",
    "./desktop/layout_settings.js",
    "./desktop/window_layout_settings.js",
    "./desktop/app_js/bindings.js",
  ];
  return files
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
}

// One compiled script per product file, same list and order as loadSource(),
// so coverage attributes each file's lines to its real disk path.
// The concatenated blob hoisted function declarations across every file;
// separate scripts only hoist per file, so core.js's load-time
// window.syncGitWorkspaceToggle assignment needs the name pre-declared, and
// the window copy re-wired to the real function once render.js has loaded.
const LAYOUT_FILES = [
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
  "./desktop/lsp_settings.js",
  "./desktop/layout_settings.js",
  "./desktop/window_layout_settings.js",
  "./desktop/app_js/bindings.js",
];
let layoutScripts = null;
function getLayoutScripts() {
  if (!layoutScripts) {
    layoutScripts = LAYOUT_FILES.map((path) => {
      const realPath = fileURLToPath(new URL(path, import.meta.url));
      return new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath });
    });
  }
  return layoutScripts;
}
const HOIST_PRELOAD = new vm.Script(
  "var syncGitWorkspaceToggle;\n" +
    "window.syncGitWorkspaceToggle = syncGitWorkspaceToggle;",
  { filename: "hoist-preload.js" },
);
const HOIST_REWIRE = new vm.Script(
  "window.syncGitWorkspaceToggle = syncGitWorkspaceToggle;",
  { filename: "hoist-rewire.js" },
);
function runLayoutScripts(ctx) {
  HOIST_PRELOAD.runInContext(ctx);
  for (const script of getLayoutScripts()) script.runInContext(ctx);
  HOIST_REWIRE.runInContext(ctx);
}

describe("window layout reset integration", () => {
  it("defines resetWindowLayout and exposes it on window", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    assert.equal(typeof ctx.resetWindowLayout, "function");
    assert.equal(typeof ctx.window.resetWindowLayout, "function");
  });

  it("clears persisted layout state and rebuilds a single pane after confirm", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}

    vm.runInContext(`
      state.workspaces = [
        { workspace_id: "ws-a", label: "Alpha", worktree: { checkout_path: "/repo/alpha" } },
      ];
      state.ws = "ws-a";
      state.workspacePanes = {
        "ws-a": {
          root: { type: "split", direction: "horizontal", ratio: 0.5, children: [
            { type: "leaf", paneId: "p1", tabs: [] },
            { type: "leaf", paneId: "p2", tabs: [] },
          ] },
          maximizedPaneId: "p1",
          at: 1,
        },
      };
      state.workspaceShell = { "ws-a": { mode: "git" } };
      state.workspacePanes["ws-a"].maximizedPaneId = "p1";
      localStorage.setItem("herdr-web-workspace-panes", JSON.stringify(state.workspacePanes));
      localStorage.setItem("herdr-web-workspace-shell", JSON.stringify(state.workspaceShell));
      localStorage.setItem("herdr-web-sidebar-collapsed", "1");
      localStorage.setItem("herdr-web-right-sidebar-collapsed", "1");
      localStorage.setItem("herdr-web-options", JSON.stringify({ sidebarWidth: 500, rightSidebarWidth: 490 }));
      localStorage.setItem("herdr-session-state:builtin:default", JSON.stringify({ ws: "ws-a", tab: "t1", pane: "p1" }));
      localStorage.setItem("herdr-session-state:external-herdr:default", JSON.stringify({ ws: "ws-a", tab: "t1", pane: "p1" }));
      // Instrument what the reset drives.
      window.__resetCalls = { gitHide: 0, fileHide: 0, searchClose: 0, renderPanes: 0, fit: 0 };
      window.HerdrGitUi = { hide() { window.__resetCalls.gitHide++; } };
      window.HerdrFileBrowser = { hide() { window.__resetCalls.fileHide++; } };
      window.HerdrSearchPanel = { close() { window.__resetCalls.searchClose++; } };
      (function () {
        const panes = window.HerdrWorkspacePanes;
        if (panes && typeof panes.renderWorkspacePanes === "function") {
          const orig = panes.renderWorkspacePanes;
          panes.renderWorkspacePanes = function () {
            window.__resetCalls.renderPanes++;
            return orig();
          };
        }
      })();
      fitTerminalShell = function() { window.__resetCalls.fit++; };
      fitTerminalSurface = function() { window.__resetCalls.fit++; };
      // askQuestion resolves through the modal: auto-confirm here.
      askQuestion = async function() { return true; };
    `, ctx);

    const done = await vm.runInContext("resetWindowLayout()", ctx);
    assert.equal(done, true);

    const keys = JSON.parse(vm.runInContext(
      "(() => { const out = []; for (const k of Object.keys(localStorage)) out.push(k); return JSON.stringify(out); })()",
      ctx,
    ));
    assert.ok(!keys.includes("herdr-web-workspace-panes"), "panes store cleared");
    // The reset writes the fresh defaults back through the canonical
    // setters on purpose: shell mode "terminal" (same as absent for the
    // restore reads) and sidebar flags "0". The right sidebar reads
    // "0" as expanded while an absent flag means collapsed (fresh-boot
    // rule), the left sidebar reads false for both. The saved split
    // trees, hosted modes, and collapsed states are gone.
    assert.ok(!keys.includes("herdr-web-sidebar-collapsed") || vm.runInContext("localStorage.getItem('herdr-web-sidebar-collapsed')", ctx) === "0", "left sidebar reset to expanded");
    assert.ok(!keys.includes("herdr-web-right-sidebar-collapsed") || vm.runInContext("localStorage.getItem('herdr-web-right-sidebar-collapsed')", ctx) === "0", "right sidebar reset to expanded");
    const storedOptions = JSON.parse(vm.runInContext("localStorage.getItem('herdr-web-options')", ctx) || "{}");
    assert.equal(storedOptions.sidebarWidth, 330, "left sidebar width back to stock 330");
    assert.equal(storedOptions.rightSidebarWidth, 320, "right sidebar width back to stock 320");
    const appNode = ctx.document.getElementById("app");
    assert.equal(appNode.style.getPropertyValue("--sidebar-width"), "330px", "left CSS var back to stock");
    assert.equal(appNode.style.getPropertyValue("--right-sidebar-width"), "320px", "right CSS var back to stock");
    assert.ok(!keys.some((k) => k.startsWith("herdr-session-state:")), "session selection keys cleared");
    const shellRaw = vm.runInContext("localStorage.getItem('herdr-web-workspace-shell')", ctx);
    const shellFresh = !shellRaw || (() => { try { const parsed = JSON.parse(shellRaw); return Object.values(parsed).every((s) => !s || s.mode === "terminal"); } catch { return false; } })();
    assert.ok(shellFresh, "shell store reset to terminal defaults");

    const calls = vm.runInContext("window.__resetCalls", ctx);
    // showTerminalShellMode hides the drawers again after the reset does:
    // idempotent, both passes count.
    assert.ok(calls.gitHide >= 1, "git drawer hidden");
    assert.ok(calls.fileHide >= 1, "file drawer hidden");
    assert.ok(calls.searchClose >= 1, "search panel closed");
    assert.ok(calls.renderPanes >= 1, "pane tree rebuilt");
    assert.ok(calls.fit >= 1, "terminal refit scheduled");

    const panes = vm.runInContext("JSON.stringify(state.workspacePanes)", ctx);
    const parsed = JSON.parse(panes);
    const key = Object.keys(parsed)[0];
    // panesStateFor rebuilds the fresh single-leaf tree: kind "pane",
    // one pane id, no maximized pointer, no split children.
    assert.equal(parsed[key].root.kind, "pane", "single fresh leaf tree");
    assert.ok(!parsed[key].root.children, "no split children");
    assert.equal(parsed[key].maximizedPaneId, undefined);

    const shellMode = vm.runInContext(
      "(() => { const s = state.workspaceShell[state.ws]; return s ? s.mode : null; })()",
      ctx,
    );
    // showTerminalShellMode re-persists terminal for the current ws: the
    // fresh default, not a stale git/files choice.
    assert.equal(shellMode, "terminal");
  });

  it("returns false and clears nothing when the confirm is dismissed", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    vm.runInContext(`
      state.ws = "ws-a";
      state.workspacePanes = { "ws-a": { root: { type: "split", direction: "horizontal", ratio: 0.5, children: [] }, at: 1 } };
      localStorage.setItem("herdr-web-workspace-panes", "keep");
      askQuestion = async function() { return false; };
      window.__resetCalls = { gitHide: 0, fileHide: 0, searchClose: 0, renderPanes: 0, fit: 0 };
      window.HerdrGitUi = { hide() { window.__resetCalls.gitHide++; } };
      window.HerdrFileBrowser = { hide() { window.__resetCalls.fileHide++; } };
      window.HerdrSearchPanel = { close() { window.__resetCalls.searchClose++; } };
      (function () {
        const panes = window.HerdrWorkspacePanes;
        if (panes && typeof panes.renderWorkspacePanes === "function") {
          const orig = panes.renderWorkspacePanes;
          panes.renderWorkspacePanes = function () {
            window.__resetCalls.renderPanes++;
            return orig();
          };
        }
      })();
      fitTerminalShell = function() {};
      fitTerminalSurface = function() {};
    `, ctx);
    const done = await vm.runInContext("resetWindowLayout()", ctx);
    assert.equal(done, false);
    const kept = vm.runInContext("localStorage.getItem('herdr-web-workspace-panes')", ctx);
    assert.equal(kept, "keep");
    const calls = vm.runInContext("window.__resetCalls", ctx);
    assert.equal(calls.gitHide, 0);
    assert.equal(calls.renderPanes, 0);
  });

  it("skips the confirm and still resets when skipConfirm is true", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    vm.runInContext(`
      state.ws = "ws-a";
      localStorage.setItem("herdr-web-workspace-panes", "keep");
      askQuestion = async function() { throw new Error("should not ask"); };
      window.__resetCalls = { gitHide: 0, fileHide: 0, searchClose: 0, renderPanes: 0, fit: 0 };
      window.HerdrGitUi = { hide() { window.__resetCalls.gitHide++; } };
      window.HerdrFileBrowser = { hide() { window.__resetCalls.fileHide++; } };
      window.HerdrSearchPanel = { close() { window.__resetCalls.searchClose++; } };
      (function () {
        const panes = window.HerdrWorkspacePanes;
        if (panes && typeof panes.renderWorkspacePanes === "function") {
          const orig = panes.renderWorkspacePanes;
          panes.renderWorkspacePanes = function () {
            window.__resetCalls.renderPanes++;
            return orig();
          };
        }
      })();
      fitTerminalShell = function() {};
      fitTerminalSurface = function() {};
    `, ctx);
    const done = await vm.runInContext("resetWindowLayout({ skipConfirm: true })", ctx);
    assert.equal(done, true);
    const kept = vm.runInContext("localStorage.getItem('herdr-web-workspace-panes')", ctx);
    assert.equal(kept, null);
  });

  it("the settings module registers a Window layout section calling the reset", () => {
    const sandbox = {
      window: {},
      document: { getElementById: () => null },
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(
      readFileSync(new URL("./desktop/window_layout_settings.js", import.meta.url), "utf8"),
      ctx,
    );
    const modules = ctx.window.HerdrSettingsModules;
    assert.ok(Array.isArray(modules) && modules.length === 1);
    const module = modules[0];
    assert.equal(module.id, "windowLayout");
    assert.match(module.html, /id="windowLayoutReset"/);
    assert.match(module.html, /settings-section-head/);
    assert.equal(typeof module.bind, "function");
  });

  it("the module is concatenated into the desktop bundle after layout_settings", () => {
    const assetsRs = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
    assert.match(assetsRs, /include_str!\("assets\/desktop\/window_layout_settings\.js"\)/);
    const layoutIdx = assetsRs.indexOf("layout_settings.js");
    const moduleIdx = assetsRs.indexOf("window_layout_settings.js");
    assert.ok(layoutIdx > -1 && moduleIdx > layoutIdx, "module loads after layout_settings.js");
  });

  it("dashboard visibility ignores drawer surfaces: only zero workspaces matters", async () => {
    // Boot-clean desktop (no workspace) is the only state where the
    // dashboard shows; drawers never claim the pane slot.
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      state.workspaces = [];
      state.ws = null;
      state.tabs = [];
      state.panes = [];
      state.allTabs = [];
      // No drawer open: dashboard shows.
      syncProjectDashboard();
      window.__probe = { dashHidden: document.getElementById("projectDashboard").hidden };
      // Files drawer open: dashboard stays (drawer is sidebar surface).
      window.HerdrFileBrowser = { isVisible: () => true };
      syncProjectDashboard();
      window.__probe.dashWithFiles = document.getElementById("projectDashboard").hidden;
      // Search open instead of Files (the rail switch): still visible.
      window.HerdrFileBrowser = { isVisible: () => false };
      window.HerdrSearchPanel = { isOpen: () => true };
      syncProjectDashboard();
      window.__probe.dashWithSearch = document.getElementById("projectDashboard").hidden;
      // Git drawer too: same rule for every rail surface.
      window.HerdrGitUi = { isVisible: () => true };
      window.HerdrSearchPanel = { isOpen: () => false };
      syncProjectDashboard();
      window.__probe.dashWithGit = document.getElementById("projectDashboard").hidden;
      // A workspace exists: dashboard hides even with every drawer closed.
      window.HerdrGitUi = { isVisible: () => false };
      state.workspaces = [{ workspace_id: "ws_1", label: "one" }];
      syncProjectDashboard();
      window.__probe.dashWithWorkspace = document.getElementById("projectDashboard").hidden;
    `, ctx);
    const probe = vm.runInContext("window.__probe", ctx);
    assert.equal(probe.dashHidden, false, "no drawer: dashboard shows");
    assert.equal(probe.dashWithFiles, false, "files drawer: dashboard stays visible");
    assert.equal(probe.dashWithSearch, false, "search panel open: dashboard stays visible");
    assert.equal(probe.dashWithGit, false, "git drawer: dashboard stays visible");
    assert.equal(probe.dashWithWorkspace, true, "workspace open: dashboard hides");
  });

  it("state sort ranks grouped workspaces by status, not by list position", async () => {
    // A linked worktree and its main checkout form one group; workspaceSort
    // "state" must order the children inside the group by agent status.
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      state.workspaces = [
        { workspace_id: "main", label: "Main", agent_status: "idle", worktree: { repo_root: "/repo/herdr", repo_name: "herdr", repo_key: "/repo/herdr" } },
        { workspace_id: "wt-a", label: "feature-a", agent_status: "working", worktree: { repo_root: "/repo/herdr", repo_name: "herdr", repo_key: "/repo/herdr", is_linked_worktree: true } },
        { workspace_id: "wt-b", label: "feature-b", agent_status: "blocked", worktree: { repo_root: "/repo/herdr", repo_name: "herdr", repo_key: "/repo/herdr", is_linked_worktree: true } },
      ];
      state.ws = "main";
      state.allTabs = [];
      state.tabs = [];
      state.panes = [];
      state.agents = [];
      options.workspaceSort = "state";
      const html = renderSpaces();
      window.__probe = { html };
    `, ctx);
    const html = vm.runInContext("window.__probe.html", ctx);
    // blocked ranks 0 and working ranks 4 in the priority map, so wt-b
    // renders before wt-a inside the group.
    const posBlocked = html.indexOf('data-workspace-id="wt-b"');
    const posWorking = html.indexOf('data-workspace-id="wt-a"');
    assert.ok(posBlocked > -1 && posWorking > -1, "both children rendered");
    assert.ok(posBlocked < posWorking, "blocked worktree sorts before working one");
    assert.ok(html.includes('workspace-group-main'), "main checkout rendered as group parent");
  });

  it("drag sort falls back to workspaceOrderIndex for unknown ids", async () => {
    // workspaceOrderIndex returns 999999 for ids missing from the saved
    // drag order, so grouped children keep a stable position instead of
    // disappearing from the sidebar.
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      state.workspaces = [
        { workspace_id: "main", label: "Main", worktree: { repo_root: "/repo/herdr", repo_key: "/repo/herdr" } },
        { workspace_id: "wt-a", label: "feature-a", worktree: { repo_root: "/repo/herdr", repo_key: "/repo/herdr", is_linked_worktree: true } },
        { workspace_id: "wt-b", label: "feature-b", worktree: { repo_root: "/repo/herdr", repo_key: "/repo/herdr", is_linked_worktree: true } },
      ];
      state.workspaceOrder = ["wt-b", "wt-a"];
      state.ws = "wt-b";
      state.allTabs = [];
      state.tabs = [];
      state.panes = [];
      state.agents = [];
      options.workspaceSort = "drag";
      const html = renderSpaces();
      window.__probe = { html, unknownIndex: workspaceOrderIndex("nope") };
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.equal(probe.unknownIndex, 999999, "unknown id lands at the end of the drag order");
    const posB = probe.html.indexOf('data-workspace-id="wt-b"');
    const posA = probe.html.indexOf('data-workspace-id="wt-a"');
    assert.ok(posB > -1 && posA > -1, "both children rendered");
    assert.ok(posB < posA, "saved drag order puts wt-b first");
  });

  it("agentAttentionRank without the cache map falls back to order.indexOf", async () => {
    // Direct 2-arg comparator callers hit the uncached rank path; a
    // status outside the four known groups ranks after every group in
    // the configured order.
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      options.agentSortMode = "attention";
      options.stuckWorkingEnabled = true;
      options.agentStatusOrder = ["working", "blocked", "idle"];
      workingDismissals["term-x"] = true;
      window.__probe = {
        workingRank: agentAttentionRank({ agent_status: "working" }, ["working", "blocked", "idle", "done"], null),
        idleRank: agentAttentionRank({ agent_status: "idle" }, ["working", "blocked", "idle", "done"], null),
        otherRank: agentAttentionRank({ agent_status: "weird" }, ["working", "blocked", "idle", "done"], null),
        dismissedRank: agentAttentionRank({ agent_status: "working", terminal_id: "term-x" }, ["working", "blocked", "idle", "done"], null),
      };
      delete workingDismissals["term-x"];
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.equal(probe.workingRank, 0);
    assert.equal(probe.idleRank, 2);
    assert.equal(probe.otherRank, 4, "unknown status ranks after every configured group");
    assert.equal(probe.dismissedRank, 2, "dismissed working agent ranks as idle");
  });

  it("runWorkspaceContextAction dispatches every workspace card action", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      state.workspaces = [
        { workspace_id: "ws-a", label: "Alpha", worktree: { repo_root: "/repo/alpha", checkout_path: "/repo/alpha" }, agent_status: "idle" },
      ];
      state.worktrees = [
        { open_workspace_id: "ws-a", path: "/repo/alpha", branch: "trunk" },
      ];
      state.ws = "ws-a";
      window.__actions = [];
      window.HerdrLocationBar = { openDiscoveryCreateForRepo(root, branch) { window.__actions.push("create:" + root + ":" + branch); } };
      window.HerdrWorktrees = { openForWorkspace(w, key) { window.__actions.push("open:" + w.workspace_id + ":" + key); } };
      openWorktreesForWorkspace = function (w, key) { window.__actions.push("open:" + w.workspace_id + ":" + key); };
      closeWorkspace = function (id) { window.__actions.push("close:" + id); };
      removeWorktree = function (id) { window.__actions.push("remove:" + id); };
      runWorkspaceContextAction("create-worktree", null, "ws-a");
      runWorkspaceContextAction("open-worktrees", { dataset: { key: "tok" } }, "ws-a");
      runWorkspaceContextAction("close", null, "ws-a");
      runWorkspaceContextAction("remove-worktree", null, "ws-a");
      runWorkspaceContextAction("close", null, "missing");
      window.__probe = { actions: window.__actions };
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.deepEqual(probe.actions, [
      "create:/repo/alpha:trunk",
      "open:ws-a:tok",
      "close:ws-a",
      "remove:ws-a",
    ]);
  });

  it("runWorkspaceContextAction falls back to the selected workspace when no id given", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      state.workspaces = [{ workspace_id: "ws-b", label: "Beta" }];
      state.ws = "ws-b";
      window.__actions = [];
      removeWorktree = function (id) { window.__actions.push(id); };
      runWorkspaceContextAction("remove-worktree", null, "");
      window.__probe = { actions: window.__actions };
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.deepEqual(probe.actions, ["ws-b"]);
  });

  it("openWorkspaceGitUi toggles the right sidebar column when git is already visible", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      options.gitUiEnabled = true;
      state.workspaces = [{ workspace_id: "ws-a", label: "Alpha", worktree: { checkout_path: "/repo/alpha" } }];
      state.ws = "ws-a";
      state.workspaceShell = { "ws-a": { mode: "git" } };
      window.__calls = { setCollapsed: [], opens: 0 };
      window.HerdrGitUi = {
        isWorkspaceVisible() { return true; },
        open() { window.__calls.opens++; },
        hide() {},
      };
      let collapsed = true;
      window.HerdrRightSidebar = {
        isHosted() { return true; },
        collapsed() { return collapsed; },
        setCollapsed(v) { window.__calls.setCollapsed.push(v); collapsed = v; },
      };
      workspaceShellKey = function (w) { return "ws-a"; };
      currentWorkspaceShellMode = function () { return "git"; };
      window.__probe = { calls: window.__calls };
    `, ctx);
    const result = await vm.runInContext("openWorkspaceGitUi(\"ws-a\", {})", ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.deepEqual(probe.calls.setCollapsed, [false], "collapsed column expands");
    assert.equal(probe.calls.opens, 0, "git ui not re-opened");
    assert.equal(result, undefined, "toggle branch returns early");
  });

  it("syncGitWorkspaceToggle removes the rail button when git ui is disabled", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      options.gitUiEnabled = false;
      window.__gitCalls = { hide: 0 };
      window.HerdrGitUi = { hide() { window.__gitCalls.hide++; } };
      const button = document.getElementById("rightRailGit");
      document.getElementById("rail").appendChild(button);
      syncGitWorkspaceToggle();
      window.__probe = {
        gitCalls: window.__gitCalls,
        railChildren: document.getElementById("rail").children.length,
        railHasGit: !!Array.from(document.getElementById("rail").children).find((n) => n.id === "rightRailGit"),
      };
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.equal(probe.gitCalls.hide, 1, "git ui hidden once");
    assert.equal(probe.railHasGit, false, "rail git button removed");
  });

  it("syncGitWorkspaceToggle rebuilds the rail when the button is missing", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      options.gitUiEnabled = true;
      state.workspaces = [{ workspace_id: "ws-a", label: "Alpha", worktree: { checkout_path: "/repo/alpha" } }];
      state.ws = "ws-a";
      window.__railBuilds = 0;
      setupRightSidebarRail = function () { window.__railBuilds++; };
      // el() is document.getElementById: a scoped override that only
      // hides the rightRailGit lookup makes the real rail look empty.
      const realGetElementById = document.getElementById;
      document.getElementById = function (id) {
        if (id === "rightRailGit") return null;
        return realGetElementById(id);
      };
      syncGitWorkspaceToggle();
      document.getElementById = realGetElementById;
      window.__probe = { builds: window.__railBuilds };
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.ok(probe.builds >= 1, "rail rebuilt when git button absent");
  });

  it("showFileHistoryPath lazy-loads git ui and opens history for the path", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      window.__hist = { loadedCss: [], loadedScripts: [], opens: [], alerts: [] };
      window.HerdrLoadScript = async function (src) { window.__hist.loadedScripts.push(src); };
      window.HerdrLoadCss = function (href) { window.__hist.loadedCss.push(href); };
      window.alert = function (msg) { window.__hist.alerts.push(msg); };
      window.HerdrGitUi = { openFileHistory(cwd, path) { window.__hist.opens.push([cwd, path]); } };
    `, ctx);
    await vm.runInContext(`
      (async () => {
        await window.HerdrShowFileHistory("/repo/alpha", "src/main.rs");
        // Missing args bail out before any load.
        await window.HerdrShowFileHistory("", "src/main.rs");
      })()
    `, ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__hist)", ctx));
    assert.deepEqual(probe.opens, [["%2Frepo%2Falpha", "src%2Fmain.rs"]], "history opens with encoded cwd and path");
    assert.equal(probe.loadedScripts.length, 0, "HerdrLoadScript bypasses the tag fallback");
    assert.equal(probe.alerts.length, 0);
  });

  it("showFileHistoryPath surfaces load failures through alert", async () => {
    const ctx = context();
    try {
      runLayoutScripts(ctx);
    } catch (e) {}
    await vm.runInContext(`
      window.__hist = { alerts: [] };
      window.HerdrLoadScript = async function () { throw new Error("script boom"); };
      window.HerdrLoadCss = function () {};
      window.alert = function (msg) { window.__hist.alerts.push(msg); };
    `, ctx);
    await vm.runInContext(`
      (async () => {
        await window.HerdrShowFileHistory("/repo/alpha", "src/main.rs");
      })()
    `, ctx);
    await vm.runInContext("window.__probe = { hist: window.__hist }", ctx);
    const probe = JSON.parse(vm.runInContext("JSON.stringify(window.__probe)", ctx));
    assert.deepEqual(probe.hist.alerts, ["script boom"]);
  });
});
