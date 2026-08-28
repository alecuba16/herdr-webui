import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Integration test: verify shell mode restoration when switching workspaces.
// Loads the real desktop JS source into a VM and simulates the workspace-switch
// flow (go -> parseRoute -> refresh -> refreshOnline) to confirm the correct
// shell surface (terminal/git/files) is applied for the target workspace.

function element(id = "") {
  return {
    id,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    disabled: false,
    setAttribute() {},
    closest() { return this; },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    focus() {},
    select() {},
    addEventListener() {},
    getBoundingClientRect() { return { width: 100, height: 100 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function context() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorage = new Map();
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
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => null,
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
    WebSocket: class {
      constructor() { this.readyState = 1; }
      send() {} close() {} addEventListener() {}
    },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    addEventListener() {},
    prompt: () => null,
    confirm: () => true,
    alert: () => {},
    encodeURIComponent,
    decodeURIComponent,
    JSON,
    Error,
    Math,
    String,
    Object,
    Array,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
    RegExp,
    Number,
    Boolean,
  };
  ctx.terminal = getElement("terminal");
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadSource() {
  // Match the actual DESKTOP_JS concat order from assets.rs,
  // plus search.js which is loaded as a separate file in the browser
  const files = [
    "./shared/core.js",
    "./shared/actions.js",
    "./shared/terminal_fit.js",
    "./desktop/search.js",
    "./desktop/app_js/core.js",
    "./desktop/app_js/workspace_shell.js",
    "./desktop/app_js/legacy_polling.js",
    "./desktop/app_js/panel_switcher.js",
    "./desktop/app_js/render.js",
    "./desktop/app_js/terminal.js",
    "./desktop/app_js/worktrees.js",
    "./desktop/app_js/shortcuts.js",
    "./desktop/app_js/workspace_create.js",
    "./desktop/app_js/bindings.js",
  ];
  return files
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
}

describe("workspace shell restoration integration", () => {
  it("restores the correct shell mode when switching workspaces after async refresh", async () => {
    const ctx = context();

    // Load source - some functions may fail during init due to missing DOM,
    // but function declarations are hoisted and will be available for testing.
    try {
      vm.runInContext(loadSource(), ctx);
    } catch (e) {
      // Expected: some init code may fail without full DOM. The functions
      // we need to test (refreshOnline, goSession, applyWorkspaceShellForSelection)
      // should still be defined and callable.
    }

    // Verify the functions we need are defined
    assert.equal(typeof ctx.refreshOnline, "function", "refreshOnline should be defined");
    assert.equal(typeof ctx.goSession, "function", "goSession should be defined");
    assert.equal(typeof ctx.applyWorkspaceShellForSelection, "function", "applyWorkspaceShellForSelection should be defined");

    // Set up state with two workspaces that have different shell modes
    vm.runInContext(`
      state.workspaces = [
        { workspace_id: "ws-a", label: "Alpha", worktree: { checkout_path: "/repo/alpha" } },
        { workspace_id: "ws-b", label: "Beta", worktree: { checkout_path: "/repo/beta" } },
      ];
      state.allTabs = [
        { tab_id: "tab-a1", workspace_id: "ws-a", label: "Tab A1" },
        { tab_id: "tab-b1", workspace_id: "ws-b", label: "Tab B1" },
      ];
      state.panes = [
        { pane_id: "pane-a1", tab_id: "tab-a1", workspace_id: "ws-a" },
        { pane_id: "pane-b1", tab_id: "tab-b1", workspace_id: "ws-b" },
      ];
      state.terminalId = "term-b";
      state.workspaceShell = {
        "ws-a": { mode: "files", minimized: false },
        "ws-b": { mode: "git", minimized: false },
      };
      state.ws = "ws-b";
      state.tab = "tab-b1";
      state.pane = "pane-b1";
      // Reset lastShellWorkspace to force shell application on next refresh
      lastShellWorkspace = null;
    `, ctx);

    // Track which shell mode gets applied by wrapping applyWorkspaceShellForSelection
    vm.runInContext(`
      window.__shellCalls = { git: 0, files: 0, terminal: 0 };
      window.__appliedWorkspaces = [];
      var _origApply = applyWorkspaceShellForSelection;
      applyWorkspaceShellForSelection = function(id) {
        window.__appliedWorkspaces.push(id);
        var shell = state.workspaceShell[id] || { mode: "terminal" };
        if (shell.mode === "git") window.__shellCalls.git++;
        else if (shell.mode === "files") window.__shellCalls.files++;
        else window.__shellCalls.terminal++;
        // Don't call the original to avoid DOM operations
      };
      // Mock render and connectTerminal to avoid DOM/WS issues
      render = function() {};
      connectTerminal = function() {};
      // Mock api() to return data that refreshOnline expects
      api = async function(url) {
        if (url === "/api/workspaces") return { result: { workspaces: state.workspaces } };
        if (url.startsWith("/api/tabs?workspace_id")) return { result: { tabs: state.tabs || state.allTabs.filter(function(t) { return t.workspace_id === state.ws; }) } };
        if (url === "/api/tabs") return { result: { tabs: state.allTabs } };
        if (url.startsWith("/api/panes")) return { result: { panes: state.panes } };
        if (url === "/api/agents") return { result: { agents: [] } };
        if (url.startsWith("/api/worktrees")) return { result: { worktrees: [] } };
        if (url.startsWith("/api/pane-layout")) return { result: { layout: null } };
        if (url === "/api/options") return { result: {} };
        if (url.startsWith("/api/sessions")) return { result: { sessions: [] } };
        return { result: {} };
      };
      // Mock other functions that refreshOnline calls
      parseRoute = function() {};
      resetTerminalConnection = function() {};
      setTerminalLoading = function() {};
      selectionPath = function() { return "/"; };
      sessionPrefix = function() { return "/"; };
      worktreeSourceWorkspaceIds = function() { return []; };
      handleAttentionSound = function() {};
      shouldFitFocusedWebTerminal = function() { return false; };
      shouldAutoFitDetachedTerminal = function() { return false; };
      browserTerminalSize = function() { return null; };
      pruneWorkspaceShellStates = function() {};
      currentTabLayout = function() { return null; };
      fitTerminalShell = function() {};
      fitTerminalSurface = function() {};
    `, ctx);

    // Simulate refreshOnline completing after go("ws-b")
    vm.runInContext(`refreshSeq = (refreshSeq || 0) + 1;`, ctx);
    try {
      await vm.runInContext(`refreshOnline(refreshSeq)`, ctx);
    } catch (e) {
      // Some parts of refreshOnline may fail without full API, but
      // the shell restoration runs after render() which we mocked
    }

    const appliedWorkspaces = vm.runInContext("window.__appliedWorkspaces", ctx);
    const shellCalls = vm.runInContext("window.__shellCalls", ctx);
    const lastShell = vm.runInContext("lastShellWorkspace", ctx);

    // Verify: applyWorkspaceShellForSelection was called with "ws-b"
    assert.equal(appliedWorkspaces.length, 1,
      "applyWorkspaceShellForSelection should be called once when workspace changes");
    assert.equal(appliedWorkspaces[0], "ws-b",
      "should apply shell for the new workspace (ws-b)");

    // Verify: git mode was applied (ws-b has git mode)
    assert.equal(shellCalls.git, 1, "git should be opened for ws-b (which has git mode)");
    assert.equal(shellCalls.files, 0, "files should NOT be opened");

    // Verify: lastShellWorkspace was updated
    assert.equal(lastShell, "ws-b", "lastShellWorkspace should be ws-b");

    // Simulate a poll refresh (same workspace) - should NOT re-apply
    const beforePoll = vm.runInContext("window.__appliedWorkspaces.length", ctx);
    vm.runInContext(`refreshSeq = (refreshSeq || 0) + 1;`, ctx);
    try {
      await vm.runInContext(`refreshOnline(refreshSeq)`, ctx);
    } catch (e) {}

    const afterPoll = vm.runInContext("window.__appliedWorkspaces.length", ctx);
    assert.equal(afterPoll, beforePoll,
      "applyWorkspaceShellForSelection should NOT be called on poll refresh (same workspace)");
  });

  it("resets lastShellWorkspace when switching sessions", () => {
    const ctx = context();

    try {
      vm.runInContext(loadSource(), ctx);
    } catch (e) {
      // Expected: some init code may fail without full DOM
    }

    assert.equal(typeof ctx.goSession, "function", "goSession should be defined");

    // Set lastShellWorkspace to simulate being on a workspace
    vm.runInContext(`
      lastShellWorkspace = "ws-a";
      state.ws = "ws-a";
      state.workspaceShell = { "ws-a": { mode: "git", minimized: false } };
      // Prevent async refresh from running after the test
      refresh = function() { return Promise.resolve(); };
      refreshSeq = 0;
    `, ctx);

    vm.runInContext(`goSession("test-session")`, ctx);

    const lastShell = vm.runInContext("lastShellWorkspace", ctx);
    const ws = vm.runInContext("state.ws", ctx);
    const shellState = vm.runInContext("state.workspaceShell", ctx);

    assert.equal(lastShell, null, "lastShellWorkspace should be null after goSession");
    assert.equal(ws, null, "state.ws should be null after goSession");
    // goSession resets to {} but syncWorkspaceShellRestoreControl may add __default_folder__
    assert.ok(!shellState["ws-a"], "ws-a shell state should be cleared after goSession");
    assert.ok(Object.keys(shellState).length <= 1, "workspaceShell should be reset (only default may exist)");
  });

  it("does not call applyWorkspaceShellForSelection when state.ws is null", async () => {
    const ctx = context();
    try {
      vm.runInContext(loadSource(), ctx);
    } catch (e) {}

    vm.runInContext(`
      window.__appliedWorkspaces = [];
      applyWorkspaceShellForSelection = function(id) {
        window.__appliedWorkspaces.push(id);
      };
      render = function() {};
      connectTerminal = function() {};
      api = async function() { return { result: {} }; };
      parseRoute = function() {};
      resetTerminalConnection = function() {};
      setTerminalLoading = function() {};
      selectionPath = function() { return "/"; };
      sessionPrefix = function() { return "/"; };
      worktreeSourceWorkspaceIds = function() { return []; };
      handleAttentionSound = function() {};
      shouldFitFocusedWebTerminal = function() { return false; };
      shouldAutoFitDetachedTerminal = function() { return false; };
      browserTerminalSize = function() { return null; };
      pruneWorkspaceShellStates = function() {};
      currentTabLayout = function() { return null; };
      fitTerminalShell = function() {};
      fitTerminalSurface = function() {};
      // Set ws to null and lastShellWorkspace to a value to test the guard
      state.ws = null;
      lastShellWorkspace = "some-workspace";
      state.workspaces = [];
      state.workspaceShell = {};
    `, ctx);

    vm.runInContext(`refreshSeq = (refreshSeq || 0) + 1;`, ctx);
    try {
      await vm.runInContext(`refreshOnline(refreshSeq)`, ctx);
    } catch (e) {}

    const applied = vm.runInContext("window.__appliedWorkspaces", ctx);
    assert.equal(applied.length, 0,
      "applyWorkspaceShellForSelection should NOT be called when state.ws is null");
  });

  it("does not call applyWorkspaceShellForSelection from navigateSelection", () => {
    const source = loadSource();

    // The old race-prone call should NOT be in navigateSelection
    const navMatch = source.match(/function navigateSelection[\s\S]*?function go\(/);
    assert.ok(navMatch, "navigateSelection function should exist in source");
    // Remove comments before checking for actual function calls
    const navWithoutComments = navMatch[0].replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(
      navWithoutComments,
      /\bapplyWorkspaceShellForSelection\s*\(/,
      "navigateSelection must not call applyWorkspaceShellForSelection (it's now in refreshOnline)",
    );

    // The new call SHOULD be in refreshOnline
    const refreshOnlineMatch = source.match(/async function refreshOnline[\s\S]*?\n\}/);
    assert.ok(refreshOnlineMatch, "refreshOnline function should exist in source");
    assert.match(
      refreshOnlineMatch[0],
      /applyWorkspaceShellForSelection\(state\.ws\)/,
      "refreshOnline should call applyWorkspaceShellForSelection(state.ws)",
    );
    assert.match(
      refreshOnlineMatch[0],
      /state\.ws !== lastShellWorkspace/,
      "refreshOnline should guard with lastShellWorkspace check",
    );
  });
});