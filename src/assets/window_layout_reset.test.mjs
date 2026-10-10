import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Integration test for the window layout reset: window.resetWindowLayout
// (app_js/render.js) clears the persisted layout stores, rebuilds fresh
// single-pane trees, hides hosted drawers, and expands both sidebars,
// behind the danger confirm modal. The Settings section lives in
// desktop/window_layout_settings.js and calls the same function.

function element(id = "") {
  const classes = new Set();
  const attributes = new Map();
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
    style: {},
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

describe("window layout reset integration", () => {
  it("defines resetWindowLayout and exposes it on window", async () => {
    const ctx = context();
    try {
      vm.runInContext(loadSource(), ctx);
    } catch (e) {}
    assert.equal(typeof ctx.resetWindowLayout, "function");
    assert.equal(typeof ctx.window.resetWindowLayout, "function");
  });

  it("clears persisted layout state and rebuilds a single pane after confirm", async () => {
    const ctx = context();
    try {
      vm.runInContext(loadSource(), ctx);
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
    // restore reads) and sidebar flags "0" (storedFlag reads false for
    // both absent and "0"). The saved split trees, hosted modes, and
    // collapsed states are gone.
    assert.ok(!keys.includes("herdr-web-sidebar-collapsed") || vm.runInContext("localStorage.getItem('herdr-web-sidebar-collapsed')", ctx) === "0", "left sidebar reset to expanded");
    assert.ok(!keys.includes("herdr-web-right-sidebar-collapsed") || vm.runInContext("localStorage.getItem('herdr-web-right-sidebar-collapsed')", ctx) === "0", "right sidebar reset to expanded");
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
      vm.runInContext(loadSource(), ctx);
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
      vm.runInContext(loadSource(), ctx);
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

  it("drawerSurfaceVisible counts the search panel, not just Files and Git", async () => {
    // Boot-clean desktop (no workspace), the exact surface the search rail
    // opens on: switching Files to Search must keep the drawer visible so
    // syncProjectDashboard never flips into dashboard mode mid-session.
    const ctx = context();
    try {
      vm.runInContext(loadSource(), ctx);
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
      // Files drawer open: dashboard hides.
      window.HerdrFileBrowser = { isVisible: () => true };
      syncProjectDashboard();
      window.__probe.dashWithFiles = document.getElementById("projectDashboard").hidden;
      // Files hidden, Search open instead (the rail switch): the dashboard
      // must stay hidden. This is the regression: drawerSurfaceVisible used
      // to answer false here.
      window.HerdrFileBrowser = { isVisible: () => false };
      window.HerdrSearchPanel = { isOpen: () => true };
      syncProjectDashboard();
      window.__probe.dashWithSearch = document.getElementById("projectDashboard").hidden;
      // Search closed too: dashboard comes back.
      window.HerdrSearchPanel = { isOpen: () => false };
      syncProjectDashboard();
      window.__probe.dashAfterClose = document.getElementById("projectDashboard").hidden;
    `, ctx);
    const probe = vm.runInContext("window.__probe", ctx);
    assert.equal(probe.dashHidden, false, "no drawer: dashboard shows");
    assert.equal(probe.dashWithFiles, true, "files drawer: dashboard hides");
    assert.equal(probe.dashWithSearch, true, "search panel is a drawer surface: dashboard stays hidden");
    assert.equal(probe.dashAfterClose, false, "search closed: dashboard returns");
  });
});
