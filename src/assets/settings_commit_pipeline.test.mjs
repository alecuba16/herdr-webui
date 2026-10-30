import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Coverage batch for the desktop settings-commit pipeline and its
// shortcuts helpers: app bundle boot + window.HerdrSettingsCommit, the
// same public path the pencil button and Enter key take in the product.

const APP_BUNDLE_FILES = [
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
  "./desktop/app_js/worktrees.js",
  "./desktop/app_js/shortcuts.js",
  "./desktop/app_js/workspace_create.js",
  "./desktop/app_js/bindings.js",
];
let appBundleScripts = null;
function getAppBundleScripts() {
  if (!appBundleScripts) {
    appBundleScripts = APP_BUNDLE_FILES.map((path) => {
      const realPath = fileURLToPath(new URL(path, import.meta.url));
      return new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath });
    });
  }
  return appBundleScripts;
}

// core.js line 483 assigns window.syncGitWorkspaceToggle from render.js's
// later declaration; preload the name so the per-file scripts boot clean.
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

function element(id = "") {
  const classes = new Set();
  const styleProps = {};
  return {
    id,
    classList: {
      add(n) { classes.add(n); },
      remove(n) { classes.delete(n); },
      contains(n) { return classes.has(n); },
      toggle(n, f) { const nx = f === undefined ? !classes.has(n) : !!f; if (nx) classes.add(n); else classes.delete(n); },
    },
    style: { setProperty(n, v) { styleProps[n] = String(v); }, getPropertyValue(n) { return styleProps[n] || ""; } },
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
    setAttribute(n, v) { this.attributes = this.attributes || {}; this.attributes[n] = v; },
    getAttribute(n) { return (this.attributes && this.attributes[n]) != null ? this.attributes[n] : null; },
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

function boot() {
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
    setTimeout(fn) {
      // Like app_load's stub: timers are parked, never fired. The commit
      // pipeline chains debounces; running them synchronously would recurse
      // forever inside a single tick.
      return 1;
    },
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
    fetch: async () => ({ status: 200, json: async () => ({}) }),
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
  const httpPath = fileURLToPath(new URL("./shared/http.js", import.meta.url));
  new vm.Script(readFileSync(httpPath, "utf8"), { filename: httpPath }).runInContext(contextObject);
  HOIST_PRELOAD.runInContext(contextObject);
  for (const script of getAppBundleScripts()) script.runInContext(contextObject);
  HOIST_REWIRE.runInContext(contextObject);
  // Top-level let bindings never become context properties; mirror them.
  new vm.Script("window.state = state; window.options = options;", { filename: "state-mirror.js" }).runInContext(contextObject);
  return { ctx, getElement };
}

describe("settings commit pipeline (bindings.js)", () => {
  // saveOptions() rebinds the top-level `let options` (normalizeOptions),
  // so every read goes back through the context, never a cached mirror.
  const readOption = (ctx, key) => vm.runInContext(`options.${key}`, ctx);

  it("commits pane tab max chars clamped to 4..60", () => {
    const { ctx, getElement } = boot();
    assert.equal(ctx.HerdrSettingsCommit.has("optPaneTabMaxChars"), true);
    getElement("optPaneTabMaxChars").value = "999";
    ctx.HerdrSettingsCommit.commit("optPaneTabMaxChars");
    assert.equal(readOption(ctx, "paneTabMaxChars"), 60);
    getElement("optPaneTabMaxChars").value = "1";
    ctx.HerdrSettingsCommit.commit("optPaneTabMaxChars");
    assert.equal(readOption(ctx, "paneTabMaxChars"), 4);
    getElement("optPaneTabMaxChars").value = "24";
    ctx.HerdrSettingsCommit.commit("optPaneTabMaxChars");
    assert.equal(readOption(ctx, "paneTabMaxChars"), 24);
    // A raw over-bound value written straight into options must come back
    // clamped through saveOptions()'s normalizeOptions pass too.
    vm.runInContext("options.paneTabMaxChars = 999; saveOptions();", ctx);
    assert.equal(readOption(ctx, "paneTabMaxChars"), 60);
  });

  it("commits tree indent px clamped to 0..40 with a 14 default", () => {
    const { ctx, getElement } = boot();
    // Number("-5") is truthy, clamps to 0, but normalizeOptions applies
    // `|| 14` so zero lands on the 14 default.
    getElement("optTreeIndentPx").value = "-5";
    ctx.HerdrSettingsCommit.commit("optTreeIndentPx");
    assert.equal(readOption(ctx, "treeIndentPx"), 14);
    getElement("optTreeIndentPx").value = "90";
    ctx.HerdrSettingsCommit.commit("optTreeIndentPx");
    assert.equal(readOption(ctx, "treeIndentPx"), 40);
    getElement("optTreeIndentPx").value = "12";
    ctx.HerdrSettingsCommit.commit("optTreeIndentPx");
    assert.equal(readOption(ctx, "treeIndentPx"), 12);
  });

  it("commits scroll lines clamped to 1..20 with a 3 default", () => {
    const { ctx, getElement } = boot();
    // "0" is falsy for ||, so zero falls back to 3; a fractional value
    // exercises the real 1 floor.
    getElement("optScrollLines").value = "0";
    ctx.HerdrSettingsCommit.commit("optScrollLines");
    assert.equal(readOption(ctx, "scrollLines"), 3);
    getElement("optScrollLines").value = "0.5";
    ctx.HerdrSettingsCommit.commit("optScrollLines");
    assert.equal(readOption(ctx, "scrollLines"), 1);
    getElement("optScrollLines").value = "99";
    ctx.HerdrSettingsCommit.commit("optScrollLines");
    assert.equal(readOption(ctx, "scrollLines"), 20);
  });

  it("commits file browser search page size with a floor of 10", () => {
    const { ctx, getElement } = boot();
    assert.equal(ctx.HerdrSettingsCommit.has("optFileBrowserSearchPageSize"), true);
    getElement("optFileBrowserSearchPageSize").value = "3";
    ctx.HerdrSettingsCommit.commit("optFileBrowserSearchPageSize");
    assert.equal(readOption(ctx, "fileBrowserSearchPageSize"), 10);
    getElement("optFileBrowserSearchPageSize").value = "50";
    ctx.HerdrSettingsCommit.commit("optFileBrowserSearchPageSize");
    assert.equal(readOption(ctx, "fileBrowserSearchPageSize"), 50);
  });

  it("commits file content search numeric settings with their clamps", () => {
    const { ctx, getElement } = boot();
    getElement("optFileContentSearchMinChars").value = "0";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchMinChars");
    assert.equal(readOption(ctx, "fileContentSearchMinChars"), 3, "zero falls back to the 3 default");
    getElement("optFileContentSearchMinChars").value = "0.5";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchMinChars");
    assert.equal(readOption(ctx, "fileContentSearchMinChars"), 1);
    getElement("optFileContentSearchPageSize").value = "1";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchPageSize");
    assert.equal(readOption(ctx, "fileContentSearchPageSize"), 10);
    getElement("optFileContentSearchPageSize").value = "9999";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchPageSize");
    assert.equal(readOption(ctx, "fileContentSearchPageSize"), 500);
    // Context lines is Number.isFinite based: garbage keeps the 2 default,
    // huge values clamp to 20, negatives clamp to 0.
    getElement("optFileContentSearchContextLines").value = "garbage";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchContextLines");
    assert.equal(readOption(ctx, "fileContentSearchContextLines"), 2);
    getElement("optFileContentSearchContextLines").value = "1000";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchContextLines");
    assert.equal(readOption(ctx, "fileContentSearchContextLines"), 20);
    getElement("optFileContentSearchMatchesPerFile").value = "0";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchMatchesPerFile");
    assert.equal(readOption(ctx, "fileContentSearchMatchesPerFile"), 5, "zero falls back to the 5 default");
    getElement("optFileContentSearchMatchesPerFile").value = "0.5";
    ctx.HerdrSettingsCommit.commit("optFileContentSearchMatchesPerFile");
    assert.equal(readOption(ctx, "fileContentSearchMatchesPerFile"), 1);
  });

  it("commits worktree and exploration directories into options", () => {
    const { ctx, getElement } = boot();
    getElement("optWorktreeDefaultDirectory").value = "/wt-root";
    ctx.HerdrSettingsCommit.commit("optWorktreeDefaultDirectory");
    assert.equal(readOption(ctx, "worktreeDefaultDirectory"), "/wt-root");
    getElement("optExplorationDefaultDirectory").value = "/explore";
    ctx.HerdrSettingsCommit.commit("optExplorationDefaultDirectory");
    assert.equal(readOption(ctx, "explorationDefaultDirectory"), "/explore");
  });

  it("commits the worktree autodiscover delay clamped to 0..30 seconds", () => {
    const { ctx, getElement } = boot();
    getElement("optWorktreeAutoDiscover").value = "99";
    ctx.HerdrSettingsCommit.commit("optWorktreeAutoDiscover");
    assert.equal(readOption(ctx, "worktreeAutoDiscoverSeconds"), 30);
    getElement("optWorktreeAutoDiscover").value = "7";
    ctx.HerdrSettingsCommit.commit("optWorktreeAutoDiscover");
    assert.equal(readOption(ctx, "worktreeAutoDiscoverSeconds"), 7);
  });

  it("unknown commit ids and has() report honestly", () => {
    const { ctx } = boot();
    assert.equal(ctx.HerdrSettingsCommit.has("optNoSuchControl"), false);
    ctx.HerdrSettingsCommit.commit("optNoSuchControl");
    // Still green: the unknown id is a silent no-op, not a throw.
    assert.equal(ctx.HerdrSettingsCommit.has("optNoSuchControl"), false);
  });
});

describe("shortcut key helpers (core.js)", () => {
  it("shortcutKeyFromEvent builds Shift+ prefixed keys and drops pure modifiers", () => {
    const { ctx } = boot();
    const key = vm.runInContext(
      "shortcutKeyFromEvent({ code: \"KeyK\", shiftKey: false })",
      ctx,
    );
    assert.equal(key, "KeyK");
    const shifted = vm.runInContext(
      "shortcutKeyFromEvent({ code: \"KeyB\", shiftKey: true })",
      ctx,
    );
    assert.equal(shifted, "Shift+KeyB");
    for (const code of ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]) {
      const dropped = vm.runInContext(`shortcutKeyFromEvent({ code: "${code}" })`, ctx);
      assert.equal(dropped, "");
    }
    assert.equal(vm.runInContext('shortcutKeyFromEvent({ code: "" })', ctx), "");
  });

  it("defaultShortcutMap returns the map for each known scope", () => {
    const { ctx } = boot();
    const git = vm.runInContext("defaultShortcutMap(\"gitShortcuts\")", ctx);
    assert.equal(git.changes, "Digit1");
    assert.equal(git.history, "KeyH");
    const browser = vm.runInContext("defaultShortcutMap(\"fileBrowserShortcuts\")", ctx);
    assert.equal(browser.filter, "Slash");
    assert.equal(browser.nextMatch, "ArrowDown");
    const webui = vm.runInContext("defaultShortcutMap(\"anythingElse\")", ctx);
    assert.equal(webui.search, "Slash");
    assert.equal(webui.help, "Shift+Slash");
  });

  it("normalizeShortcutMap keeps trimmed strings for known actions only", () => {
    const { ctx } = boot();
    const normalized = vm.runInContext(
      "normalizeShortcutMap({ search: \"  Slash  \", bogus: \"KeyX\", help: 7 }, defaultShortcutMap())",
      ctx,
    );
    assert.equal(normalized.search, "Slash");
    assert.equal(normalized.bogus, undefined);
    assert.equal(normalized.help, "Shift+Slash");
    const fromGarbage = vm.runInContext("normalizeShortcutMap(null, defaultShortcutMap())", ctx);
    assert.equal(fromGarbage.search, "Slash");
  });

  it("shortcutCollisionFor lists the group and label of a duplicate key", () => {
    const { ctx } = boot();
    const collisions = vm.runInContext(
      "shortcutCollisionFor(\"gitShortcuts\", \"changes\", \"KeyC\")",
      ctx,
    );
    assert.equal(collisions.length, 1);
    assert.match(collisions[0], /Commit/);
    const none = vm.runInContext(
      "shortcutCollisionFor(\"gitShortcuts\", \"changes\", \"F13\")",
      ctx,
    );
    assert.equal(none.length, 0);
  });

  it("normalizeShortcutPrefix maps modifier aliases and falls back to Ctrl+B", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('normalizeShortcutPrefix("Ctrl+B")', ctx), "Ctrl+B");
    assert.equal(vm.runInContext('normalizeShortcutPrefix("Control+Alt+KeyB")', ctx), "Ctrl+Alt+KeyB");
    assert.equal(vm.runInContext('normalizeShortcutPrefix("cmd+b")', ctx), "Meta+B");
    assert.equal(vm.runInContext('normalizeShortcutPrefix("bogus")', ctx), "Ctrl+B");
    assert.equal(vm.runInContext('normalizeShortcutPrefix("")', ctx), "Ctrl+B");
  });

  it("normalizeThemeMode maps legacy names and rejects unknown values", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('normalizeThemeMode("night")', ctx), "dark");
    assert.equal(vm.runInContext('normalizeThemeMode("day")', ctx), "light");
    assert.equal(vm.runInContext('normalizeThemeMode("auto")', ctx), "auto");
    assert.equal(vm.runInContext('normalizeThemeMode("bogus")', ctx), "auto");
  });
});

describe("sidebar width and workspace percent helpers (core.js)", () => {
  it("normalizeSidebarWidth floors at the fallback and rounds", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext("normalizeSidebarWidth(200, 330)", ctx), 330, "below fallback snaps to fallback");
    assert.equal(vm.runInContext("normalizeSidebarWidth(345.6, 330)", ctx), 346);
    assert.equal(vm.runInContext("normalizeSidebarWidth(\"garbage\", 320)", ctx), 320);
  });

  it("normalizeSidebarWorkspacePercent clamps to 20..80", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext("normalizeSidebarWorkspacePercent(5)", ctx), 20);
    assert.equal(vm.runInContext("normalizeSidebarWorkspacePercent(99)", ctx), 80);
    assert.equal(vm.runInContext("normalizeSidebarWorkspacePercent(42)", ctx), 42);
  });
});

describe("applyLayoutUpdated and currentTabLayout (core.js)", () => {
  it("stores the layout and resizes only the matching tab pane", () => {
    const { ctx } = boot();
    ctx.state.ws = "ws-1";
    ctx.state.tab = "tab-1";
    ctx.state.pane = "pane-a";
    ctx.state.termCols = 80;
    ctx.state.termRows = 24;
    let connects = 0;
    let fits = 0;
    vm.runInContext(
      "connectTerminal = () => { connectTerminal.count = (connectTerminal.count||0)+1; };",
      ctx,
    );
    // Layout for another tab: stored but never applied to the current pane.
    vm.runInContext(
      'applyLayoutUpdated({ workspace_id: "ws-2", tab_id: "tab-2", panes: [], area: { width: 10, height: 10 } });',
      ctx,
    );
    assert.ok(ctx.state.layouts["ws-2/tab-2"]);
    assert.equal(ctx.state.termCols, 80, "other tab layout does not resize this tab");
    vm.runInContext(
      'applyLayoutUpdated({ workspace_id: "ws-1", tab_id: "tab-1", panes: [{ pane_id: "pane-a", rect: { width: 120, height: 30 } }], area: { width: 240, height: 60 } });',
      ctx,
    );
    assert.equal(ctx.state.termCols, 120);
    assert.equal(ctx.state.termRows, 30);
    assert.equal(ctx.state.layoutPaneCount, 1);
    const stored = vm.runInContext("currentTabLayout()", ctx);
    assert.equal(stored.workspace_id, "ws-1");
    vm.runInContext('applyLayoutUpdated({ workspace_id: "ws-1", tab_id: "tab-9" });', ctx);
    assert.equal(ctx.state.termCols, 120, "pane not in layout leaves sizing alone");
  });

  it("currentTabLayout returns null without a selected tab", () => {
    const { ctx } = boot();
    ctx.state.ws = null;
    assert.equal(vm.runInContext("currentTabLayout()", ctx), null);
  });
});

describe("agent attention helpers (core.js)", () => {
  it("notificationTitle and body name the agent and workspace", () => {
    const { ctx } = boot();
    vm.runInContext('state.workspaces = [{ workspace_id: "ws-1", label: "Alpha" }];', ctx);
    const title = vm.runInContext(
      'notificationTitle({ agent_status: "blocked" })',
      ctx,
    );
    assert.equal(title, "Agent blocked");
    const doneTitle = vm.runInContext(
      'notificationTitle({ agent_status: "done" })',
      ctx,
    );
    assert.equal(doneTitle, "Agent done");
    const body = vm.runInContext(
      'notificationBody({ name: "builder", workspace_id: "ws-1" })',
      ctx,
    );
    assert.equal(body, "builder in Alpha");
    const fallbackBody = vm.runInContext(
      'notificationBody({ name: "builder", workspace_id: "ws-x" })',
      ctx,
    );
    assert.equal(fallbackBody, "builder in ws-x", "unknown workspace falls back to the id");
  });
});

describe("storeFlag and applySidebarCollapsed (core.js)", () => {
  it("storeFlag writes 1/0 strings into localStorage", () => {
    const { ctx } = boot();
    vm.runInContext('storeFlag("flag-a", true); storeFlag("flag-b", false);', ctx);
    assert.equal(ctx.localStorage.getItem("flag-a"), "1");
    assert.equal(ctx.localStorage.getItem("flag-b"), "0");
  });

  it("applySidebarCollapsed toggles the app class and re-renders the toggle", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("sidebarCollapsed = true; applySidebarCollapsed();", ctx);
    assert.equal(getElement("app").classList.contains("sidebar-collapsed"), true);
    assert.match(getElement("sidebarToggle").innerHTML, /sidebar-toggle-arrow/);
    vm.runInContext("sidebarCollapsed = false; applySidebarCollapsed();", ctx);
    assert.equal(getElement("app").classList.contains("sidebar-collapsed"), false);
  });

  it("applyRightSidebarCollapsed mirrors the right rail", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("rightSidebarCollapsed = true; applyRightSidebarCollapsed();", ctx);
    assert.equal(getElement("app").classList.contains("right-sidebar-collapsed"), true);
    assert.match(getElement("rightSidebarToggle").innerHTML, /‹/);
    vm.runInContext("rightSidebarCollapsed = false; applyRightSidebarCollapsed();", ctx);
    assert.equal(getElement("app").classList.contains("right-sidebar-collapsed"), false);
    assert.match(getElement("rightSidebarToggle").innerHTML, /›/);
  });
});

describe("selection path helpers (core.js)", () => {
  it("selectionPath builds the routed session path and sessionPrefix the key", () => {
    const { ctx } = boot();
    assert.equal(
      vm.runInContext('selectionPath("a", "b", "c")', ctx),
      "/session/default/workspace/a/tab/b/pane/c",
    );
    assert.equal(
      vm.runInContext('selectionPath("a", "b", null)', ctx),
      "/session/default/workspace/a/tab/b",
    );
    assert.equal(typeof vm.runInContext("sessionPrefix()", ctx), "string");
  });

  it("statusMark and statusDot label working and blocked states", () => {
    const { ctx } = boot();
    assert.match(vm.runInContext('statusMark("working")', ctx), /herdr-spinner/);
    assert.equal(vm.runInContext('statusMark("blocked")', ctx), "");
    assert.match(vm.runInContext('statusMark("blocked", true)', ctx), /blocked-text/);
    assert.match(vm.runInContext('statusDot("working")', ctx), /dot working/);
  });
});
describe("close shortcut chord (shortcuts.js)", () => {
  it("altw closes the current panel and off mode does nothing", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        if (url.endsWith("/close")) return { result: {} };
        return { result: {} };
      };
      refresh = () => {};
      removeClosedTabFromState = () => {};
      state.ws = "ws1";
      state.tab = "tab1";
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "one" }];
      state.allTabs = state.tabs;`,
      ctx,
    );
    // off mode: no state.tab anyway, returns false before any close call.
    assert.equal(
      vm.runInContext('closeCurrentPanelShortcut()', ctx),
      false,
    );
    assert.equal(vm.runInContext("calls.length", ctx), 0);
    // altw mode + a current tab: the close fires the question modal, the
    // confirmed close posts one /close.
    vm.runInContext('options.closeShortcut = "altw";', ctx);
    const booted = vm.runInContext(
      'handleCloseShortcut({ key: "w", code: "KeyW", altKey: true })',
      ctx,
    );
    assert.equal(booted, true);
    // W by key name alone (no e.code) must still arm the close: the
    // product matches either the key label or the physical code.
    vm.runInContext("state.tab = 'tab2';", ctx);
    const byName = vm.runInContext(
      'handleCloseShortcut({ key: "w", altKey: true })',
      ctx,
    );
    assert.equal(byName, true);
    await vm.runInContext("closeQuestion(true); 0", ctx, { timeout: 1000 });
    await new Promise((r) => setImmediate(r));
    const closeCalls = await vm.runInContext(
      "calls.filter((c) => c.url.endsWith('/close')).length",
      ctx,
    );
    assert.equal(closeCalls, 1);
    assert.equal(getElement("questionModal").style.display, "none");
  });

  it("shift+space arms the chord and w within the window closes", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        if (url.startsWith("/api/workspaces"))
          return { result: { workspaces: [{ workspace_id: "ws1", label: "one" }] } };
        return { result: {} };
      };
      refresh = () => {};
      removeClosedTabFromState = () => {};
      state.ws = "ws1";
      state.tab = "tab1";
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "one" }];
      state.allTabs = state.tabs;
      options.closeShortcut = "shiftspacew";`,
      ctx,
    );
    // Drain the boot's own refresh chain first: it re-reads state from the
    // api stub, and a workspace-less snapshot would clear state.tab under
    // the test's feet mid-chord.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    vm.runInContext("state.tab = 'tab1'; state.tabs = [{ workspace_id: 'ws1', tab_id: 'tab1', label: 'one' }]; state.allTabs = state.tabs;", ctx);
    // Shift+Space arms the chord (returns true, no close yet).
    const armed = vm.runInContext(
      'handleCloseShortcut({ key: " ", code: "Space", shiftKey: true })',
      ctx,
    );
    assert.equal(armed, true);
    // No close call yet: the api log holds only the boot's own fetches,
    // none of them a /close.
    assert.equal(
      vm.runInContext("calls.filter((c) => c.url.endsWith('/close')).length", ctx),
      0,
    );
    // W inside the chord window closes the current panel.
    const closed = vm.runInContext(
      'handleCloseShortcut({ key: "w", code: "KeyW" })',
      ctx,
    );
    assert.equal(closed, true);
    // The armed window spans 1500ms: Time.now inside the context reads the
    // real clock, so arming at t and closing at t+1600 must miss the chord.
    vm.runInContext(
      "closeChordUntil = Date.now() - 101; options.closeShortcut = 'shiftspacew'; state.tab = 'tab3';",
      ctx,
    );
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: "w", code: "KeyW" })', ctx),
      false,
    );
    // The chord window is long enough that a 250ms pause between Shift+Space
    // and W still closes (a 200ms window would have expired).
    vm.runInContext("closeChordUntil = 0; state.tab = 'tab4';", ctx);
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: " ", code: "Space", shiftKey: true })', ctx),
      true,
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: "w", code: "KeyW" })', ctx),
      true,
    );
    await vm.runInContext("closeQuestion(true); 0", ctx, { timeout: 1000 });
    await new Promise((r) => setImmediate(r));
    const closeCalls = await vm.runInContext(
      "calls.filter((c) => c.url.endsWith('/close')).length",
      ctx,
    );
    assert.equal(closeCalls, 1);
  });

  it("chord resets on a non-shift non-w keypress", () => {
    const { ctx } = boot();
    vm.runInContext(
      `calls = [];
      api = async () => ({ result: {} });
      refresh = () => {};
      removeClosedTabFromState = () => {};
      state.ws = "ws1";
      state.tab = "tab1";
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "one" }];
      state.allTabs = state.tabs;
      options.closeShortcut = "shiftspacew";`,
      ctx,
    );
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: " ", code: "Space", shiftKey: true })', ctx),
      true,
    );
    // A plain X resets the chord window without closing anything.
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: "x", code: "KeyX" })', ctx),
      false,
    );
    // The chord is gone: w alone no longer closes.
    assert.equal(
      vm.runInContext('handleCloseShortcut({ key: "w", code: "KeyW" })', ctx),
      false,
    );
    assert.equal(vm.runInContext("calls.length", ctx), 0);
  });
});

describe("shortcut prefix plumbing (shortcuts.js)", () => {
  it("globalShortcutPrefixLabel normalizes the configured prefix", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('globalShortcutPrefixLabel()', ctx), "Ctrl+B");
    vm.runInContext('options.globalShortcutPrefix = "Option+Shift+P";', ctx);
    assert.equal(vm.runInContext('globalShortcutPrefixLabel()', ctx), "Alt+Shift+P");
    vm.runInContext('options.globalShortcutPrefix = "bogus";', ctx);
    assert.equal(vm.runInContext('globalShortcutPrefixLabel()', ctx), "Ctrl+B");
  });

  it("isShortcutPrefix matches the normalized label for the event", () => {
    const { ctx } = boot();
    const yes = vm.runInContext(
      'isShortcutPrefix({ key: "b", code: "KeyB", ctrlKey: true })',
      ctx,
    );
    assert.equal(yes, true);
    const no = vm.runInContext(
      'isShortcutPrefix({ key: "x", code: "KeyX", ctrlKey: true })',
      ctx,
    );
    assert.equal(no, false);
  });

  it("searchShortcutLabel reflects the configured search shortcut", () => {
    const { ctx } = boot();
    // defaultOptions ships searchShortcut "off", rendered as Disabled.
    assert.equal(vm.runInContext('searchShortcutLabel()', ctx), "Disabled");
    vm.runInContext('options.searchShortcut = "Ctrl+P";', ctx);
    assert.equal(vm.runInContext('searchShortcutLabel()', ctx), "Ctrl+P");
  });

  it("keyNameFromEvent maps single characters uppercased and space to Space", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('keyNameFromEvent({ key: "f" })', ctx), "F");
    assert.equal(vm.runInContext('keyNameFromEvent({ key: " " })', ctx), "Space");
    assert.equal(vm.runInContext('keyNameFromEvent({ key: "" })', ctx), "");
    assert.equal(vm.runInContext('keyNameFromEvent({ key: "Shift" })', ctx), "Shift");
  });

  it("shortcutPrefixFromEvent joins modifiers in Ctrl Alt Shift Meta order", () => {
    const { ctx } = boot();
    assert.equal(
      vm.runInContext(
        'shortcutPrefixFromEvent({ key: "p", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })',
        ctx,
      ),
      "Ctrl+Alt+Shift+Meta+P",
    );
    // Pure modifier press yields "".
    assert.equal(
      vm.runInContext('shortcutPrefixFromEvent({ key: "Control", ctrlKey: true })', ctx),
      "",
    );
  });

  it("editableShortcutTarget detects inputs and contenteditable hosts", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext("editableShortcutTarget(null)", ctx), false);
    // A bare object has no closest(): not editable.
    assert.equal(
      vm.runInContext("editableShortcutTarget({})", ctx),
      false,
    );
    // An element stub whose closest() returns itself and whose tagName is
    // input counts as an editable target.
    const inputLike =
      '({ tagName: "input", closest() { return this; } })';
    assert.equal(
      vm.runInContext(`editableShortcutTarget(${inputLike})`, ctx),
      true,
    );
    const divLike =
      '({ tagName: "div", closest() { return this; } })';
    assert.equal(
      vm.runInContext(`editableShortcutTarget(${divLike})`, ctx),
      false,
    );
    // contenteditable attribute wins for non-form tags.
    const editableDiv =
      '({ tagName: "div", closest() { return this; }, getAttribute(n) { return n === "contenteditable" ? "true" : null; } })';
    assert.equal(
      vm.runInContext(`editableShortcutTarget(${editableDiv})`, ctx),
      true,
    );
  });

  it("runPrefixedShortcut executes a mapped action and shows the hint toast", () => {
    const { ctx } = boot();
    vm.runInContext(
      `options.webuiShortcuts = { settings: "KeyS", search: "KeyF" };
      // Distinct markers per entry point: the settings action must route
      // through showSettingsModal, not call openSettingsModal directly.
      showSettingsModal = () => { (window.__viaShow = true); };
      openSettingsModal = () => { (window.__viaOpen = true); };`,
      ctx,
    );
    const ran = vm.runInContext(
      'runPrefixedShortcut({ code: "KeyS" })',
      ctx,
    );
    assert.equal(ran, true);
    assert.equal(vm.runInContext("window.__viaShow", ctx), true);
    assert.equal(vm.runInContext("window.__viaOpen", ctx), undefined);
    // The hint toast is a real node appended to body with the action label
    // and the rendered key, pinned through its known child nodes.
    const toastHtml = vm.runInContext(
      "shortcutHintToastLabelNode.textContent + '|' + shortcutHintToastKeyNode.textContent",
      ctx,
    );
    assert.equal(toastHtml, "Settings|S");
    // An unmapped key does nothing.
    assert.equal(
      vm.runInContext('runPrefixedShortcut({ code: "KeyZ" })', ctx),
      false,
    );
  });

  it("handleGlobalShortcut opens the search palette on the search shortcut", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `options.searchShortcut = "Ctrl+P";
      openSearchPalette = () => { (window.__palette = true); };`,
      ctx,
    );
    // Sanity: the stub replaced the product function.
    vm.runInContext("openSearchPalette()", ctx);
    assert.equal(vm.runInContext("window.__palette", ctx), true);
    const consumed = vm.runInContext(
      'handleGlobalShortcut({ key: "p", code: "KeyP", ctrlKey: true, preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(consumed, true);
    assert.equal(vm.runInContext("window.__palette", ctx), true);
    // With the palette open, modalOpen() sees it and the same search
    // shortcut passes through to the palette's own handlers.
    getElement("searchPalette").style.display = "grid";
    const passthrough = vm.runInContext(
      'handleGlobalShortcut({ key: "p", code: "KeyP", ctrlKey: true, preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(passthrough, false);
    // Ctrl+F while the palette is open refocuses its input instead.
    getElement("searchPaletteInput").focused = false;
    getElement("searchPaletteInput").focus = function () { this.focused = true; };
    const refocus = vm.runInContext(
      'handleGlobalShortcut({ key: "f", code: "KeyF", ctrlKey: true, preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(refocus, true);
    assert.equal(getElement("searchPaletteInput").focused, true);
  });

  it("handleGlobalShortcut returns false while a modal is open", () => {
    const { ctx, getElement } = boot();
    getElement("settingsModal").style.display = "grid";
    const passthrough = vm.runInContext(
      'handleGlobalShortcut({ key: "b", code: "KeyB", ctrlKey: true, preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(passthrough, false);
  });

  it("handleGlobalShortcut shows the prefix overlay on the prefix key", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("openSettingsModal = () => {};", ctx);
    const consumed = vm.runInContext(
      'handleGlobalShortcut({ key: "b", code: "KeyB", ctrlKey: true, preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(consumed, true);
    assert.equal(getElement("shortcutPrefixOverlay").hidden, false);
    // A second prefixed key runs the mapped action while prefix is armed.
    vm.runInContext(
      "options.webuiShortcuts = { settings: 'KeyS' };",
      ctx,
    );
    const action = vm.runInContext(
      'handleGlobalShortcut({ code: "KeyS", preventDefault() {}, stopPropagation() {} })',
      ctx,
    );
    assert.equal(action, true);
  });
});
