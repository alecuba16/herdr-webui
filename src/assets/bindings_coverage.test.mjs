import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Coverage batch for desktop bindings.js plus the settings modules it
// never boots (lsp, layout, window layout, git ui) and the git diff-search
// module. bindings.js is exercised through the same app-bundle boot the
// commit-pipeline test uses; the standalone IIFEs run in minimal sandboxes
// because HerdrSettingsModules pushes never reach the desktop bundle in
// this harness.

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
  const listeners = new Map();
  const el = {
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
    offsetParent: {},
    setAttribute(n, v) { this.attributes = this.attributes || {}; this.attributes[n] = v; },
    getAttribute(n) { return (this.attributes && this.attributes[n]) != null ? this.attributes[n] : null; },
    closest() { return this; },
    contains() { return false; },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    children: [],
    focus() { this.focused = true; },
    select() { this.selected = true; },
    click() { if (typeof this.onclick === "function") this.onclick(); },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return true; },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    fire(type, event) {
      const list = (listeners.get(type) || []).slice();
      for (const fn of list) fn(Object.assign({ target: this, currentTarget: this }, event));
    },
    getBoundingClientRect() { return { bottom: 100, height: 100, left: 0, top: 0, width: 100 }; },
    scrollTo() {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    offsetTop: 0,
    querySelector() { return element(); },
    querySelectorAll() { return []; },
  };
  return el;
}

// Minimal DOM stub good enough for bindings.js click/keydown delegation.
// querySelector/[] must answer null/[] at boot (the settings-commit harness
// learned this the hard way: a truthy stub sends core.js down brand-
// replacement paths), so tests override them per case when a listener needs
// a node.
function delegateDocument({ getElement }) {
  const docListeners = new Map();
  return {
    hidden: false,
    title: "",
    getElementById: getElement,
    createElement: () => element(),
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener() {},
    fire(type, event) {
      for (const fn of (docListeners.get(type) || []).slice()) fn(event);
    },
  };
}

function boot({ matchMedia } = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const storageMap = new Map();
  const document = delegateDocument({ getElement });
  document.body = getElement("body");
  document.documentElement = element("html");
  const windowListeners = new Map();
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) {
      // Like app_load's stub: timers are parked, never fired.
      return 1;
    },
    requestAnimationFrame(fn) { if (typeof fn === "function") fn(); return 1; },
    cancelAnimationFrame() {},
    document,
    localStorage: {
      getItem: (key) => storageMap.get(key) || null,
      setItem: (key, value) => storageMap.set(key, String(value)),
      removeItem: (key) => storageMap.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "", reload() { ctx.__reloaded = true; } },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    WebSocket: class {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    addEventListener(type, fn) {
      const list = windowListeners.get(type) || [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener() {},
    fireWindow(type, event) {
      for (const fn of (windowListeners.get(type) || []).slice()) fn(event);
    },
    prompt: () => null,
    confirm: () => true,
    alert() {},
    showBlocking() {},
    hideBlocking() {},
  };
  ctx.terminal = getElement("terminal");
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (matchMedia) ctx.matchMedia = matchMedia;
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

function readOption(ctx, key) {
  return vm.runInContext(`options.${key}`, ctx);
}

// The bundle's handlers close over real bundle functions (options, state,
// saveOptions). Overriding one with vm.runInContext("name = ...") only
// rebinds where the name is a var/let at script top level; captured consts
// refuse assignment. Route every stub through window.__ markers instead.
function windowMarker(ctx, name, fnBody) {
  vm.runInContext(`window.__${name} = (${fnBody});`, ctx);
}

// Delegation targets need a closest() that answers null for unknown
// selectors: the element stub's default returns itself, which would make
// every branch of bindings.js's cascades fire at once.
function makeTarget(id) {
  const el = element(id);
  const closestMap = new Map();
  el.closest = (sel) => closestMap.get(sel) || null;
  el.mapClosest = (sel, node) => { closestMap.set(sel, node); return el; };
  return el;
}

const fakeEvent = (extra = {}) => Object.assign({
  preventDefault() {},
  stopPropagation() {},
  stopImmediatePropagation() {},
}, extra);

describe("bindings.js click delegation", () => {
  it("runs workspace context actions and closes no-sleep menus", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `__calls = [];
      __noSleepModes = [];
      runWorkspaceContextAction = function (action, button, workspaceId) { __calls.push([action, workspaceId || null]); };
      setNoSleepMode = function (mode, wrap) { __noSleepModes.push([mode, wrap && wrap.id || null]); };`,
      ctx,
    );
    const actionEl = getElement("workspaceCardAction");
    actionEl.dataset.workspaceAction = "remove";
    ctx.document.fire("click", fakeEvent({ target: actionEl }));
    assert.deepEqual(vm.runInContext("JSON.stringify(__calls)", ctx), "[[\"remove\",null]]");

    const outside = getElement("plainNode");
    ctx.document.fire("click", fakeEvent({ target: outside }));
    // Closing no-sleep menus ran through document.querySelectorAll, a no-op stub.
    assert.ok(true);

    const option = getElement("noSleepOption");
    option.dataset.mode = "on";
    const control = getElement("noSleepControl");
    // Fake the wrap tree: option/control resolve their wrap and its menu.
    const wrapControl = element("noSleepControl");
    const wrapMenu = element("noSleepMenu");
    const theWrap = element("noSleepWrap");
    theWrap.querySelector = (sel) => (sel.includes("menu") ? wrapMenu : wrapControl);
    // menus start closed like app.html; the first [data-mode] inside the
    // menu is the wrapControl node, so opening focuses a stable target
    wrapMenu.hidden = true;
    wrapMenu.querySelector = () => wrapControl;
    // the delegation resolves the clicked node through .no-sleep-control
    // first, then its .no-sleep-wrap; the option branch matches
    // .no-sleep-menu [data-mode]; answer both per node
    control.closest = (sel) => (sel.includes("control") || sel.includes("wrap") ? (sel.includes("control") ? control : theWrap) : null);
    option.closest = (sel) => (sel.includes("wrap") ? theWrap : sel.includes("menu") && sel.includes("data-mode") ? option : null);
    getElement("plainNode").closest = () => null;
    ctx.document.fire("click", fakeEvent({ target: control }));
    assert.equal(wrapMenu.hidden, false, "closed before the click, so it opens");
    assert.equal(control.attributes["aria-expanded"], "true");
    assert.equal(wrapControl.focused, true, "opening the menu focuses the first option");
    ctx.document.fire("click", fakeEvent({ target: control }));
    assert.equal(wrapMenu.hidden, true, "open before the click, so it closes");
    assert.equal(control.attributes["aria-expanded"], "false");
    ctx.document.fire("click", fakeEvent({ target: option }));
    assert.equal(vm.runInContext("JSON.stringify(__noSleepModes)", ctx), JSON.stringify([["on", "noSleepWrap"]]));
  });
});

describe("bindings.js keydown delegation (Enter/Space on span role=button)", () => {
  it("synthesizes click on span buttons and keeps Enter off native buttons", () => {
    const { ctx, getElement } = boot();
    let clicks = 0;
    const spanButton = getElement("agentUndo");
    spanButton.tagName = "SPAN";
    spanButton.setAttribute("role", "button");
    spanButton.setAttribute("tabindex", "0");
    spanButton.click = function () { clicks++; };
    spanButton.closest = () => spanButton;
    ctx.document.fire("keydown", fakeEvent({ key: "Enter", target: spanButton }));
    assert.equal(clicks, 1);

    const buttonEl = getElement("nativeButton");
    buttonEl.tagName = "BUTTON";
    buttonEl.closest = () => buttonEl;
    let buttonClicks = 0;
    buttonEl.click = function () { buttonClicks++; };
    ctx.document.fire("keydown", fakeEvent({ key: "Enter", target: buttonEl }));
    assert.equal(buttonClicks, 0, "native buttons keep their own Enter path");

    ctx.document.fire("keydown", fakeEvent({ key: "x", target: spanButton }));
    assert.equal(clicks, 1, "unrelated keys never synthesize clicks");
  });

  it("Enter on the empty workspace surface creates the first terminal", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__newTab = 0;
      newTab = function () { window.__newTab++; };
      state.ws = "ws1";
      state.tab = null;
      workspaceHasOpenFileOrGitTab = function () { return false; };
      modalOpen = function () { return false; };`,
      ctx,
    );
    const bodyTarget = getElement("workspacePanes");
    // scope the surface branch: answering every selector would make the
    // span-button lookup hijack the Enter press first
    bodyTarget.closest = (sel) => (sel === "#workspacePanes" ? bodyTarget : null);
    ctx.document.fire("keydown", fakeEvent({ key: "Enter", target: bodyTarget }));
    assert.equal(ctx.window.__newTab, 1);
    // Modal open: Enter passes through.
    vm.runInContext("modalOpen = function () { return true; };", ctx);
    ctx.document.fire("keydown", fakeEvent({ key: "Enter", target: bodyTarget }));
    assert.equal(ctx.window.__newTab, 1);
    // Workspace without an open git/file tab: the workspace itself gates it.
    vm.runInContext("modalOpen = function () { return false; }; state.tab = 'tab1';", ctx);
    ctx.document.fire("keydown", fakeEvent({ key: "Enter", target: bodyTarget }));
    assert.equal(ctx.window.__newTab, 1, "a selected tab blocks the boot Enter");
  });
});

describe("bindings.js matchMedia and visibilitychange", () => {
  it("registers the color-scheme listener when matchMedia exists", () => {
    // boot() accepts a matchMedia so the registration branch runs once
    // during the bundle load; re-running bindings.js in the same context
    // would re-declare its top-level lets and throw.
    let changeFns = [];
    // Only the prefers-color-scheme registration is collected; the
    // terminal DPR watcher also matches, so filter by query text.
    const { ctx } = boot({ matchMedia: (query) => ({
      addEventListener(type, fn) { if (query.includes("prefers-color-scheme")) changeFns.push(fn); },
    }) });
    assert.equal(changeFns.length, 1);
    vm.runInContext("themeMode = 'auto'; applyThemeCount = 0; applyTheme = function () { applyThemeCount++; };", ctx);
    changeFns[0]();
    assert.equal(vm.runInContext("applyThemeCount", ctx), 1, "auto mode re-applies the theme on change");
    // legacy addListener fallback
    const legacyFns = [];
    const { ctx: ctx2 } = boot({ matchMedia: (query) => ({ addListener(fn) { if (query.includes("prefers-color-scheme")) legacyFns.push(fn); } }) });
    assert.equal(legacyFns.length, 1);
    vm.runInContext("themeMode = 'light'; applyThemeCount = 0; applyTheme = function () { applyThemeCount++; };", ctx2);
    legacyFns[0]();
    assert.equal(vm.runInContext("applyThemeCount", ctx2), 0, "non-auto never re-applies");
  });

  it("favicon sync runs on visibilitychange", () => {
    const { ctx } = boot();
    vm.runInContext("syncBrowserFaviconCount = 0; syncBrowserFavicon = function () { syncBrowserFaviconCount++; };", ctx);
    ctx.document.fire("visibilitychange", fakeEvent({}));
    assert.equal(vm.runInContext("syncBrowserFaviconCount", ctx), 1);
  });
});

describe("bindings.js chrome buttons", () => {
  it("settingsToggle and shortcutsToggle route through their modules", () => {
    // onclick closures capture the real bundle functions; vm rebinding
    // cannot rewire them, so assert the real side effects instead
    const { ctx, getElement } = boot();
    const modal = getElement("settingsModal");
    modal.style.display = "none";
    const remembered = [];
    ctx.window.HerdrModalFocus = {
      rememberModalOpener: (id) => remembered.push(id),
      restoreModalOpener: () => {},
    };
    getElement("settingsToggle").click();
    assert.equal(modal.style.display, "grid", "settingsToggle opens the modal");
    assert.deepEqual(remembered, ["settingsModal"]);
    modal.style.display = "none";
    remembered.length = 0;
    getElement("shortcutsToggle").click();
    assert.equal(modal.style.display, "grid", "shortcutsToggle falls back to the plain open when no sections api");
    assert.deepEqual(remembered, ["settingsModal"], "fallback path remembers the opener too");
    // with the sections api installed, shortcutsToggle routes through it
    modal.style.display = "none";
    ctx.window.HerdrSettingsSections = {
      HELP_SECTION_SELECTOR: "#help",
      openSettingsModalAt: (sel) => { ctx.window.__helpSel = sel; },
    };
    getElement("shortcutsToggle").click();
    assert.equal(ctx.window.__helpSel, "#help");
    assert.notEqual(modal.style.display, "grid", "the sections api owns the open when present");
  });

  it("settingsClose hides the modal and resets drag and focus", () => {
    const { ctx, getElement } = boot();
    let resetByBackdrop = null;
    let restoredOpener = null;
    ctx.window.HerdrModalDrag = { resetByBackdrop: (m) => { resetByBackdrop = m; } };
    ctx.window.HerdrModalFocus = { restoreModalOpener: (id) => { restoredOpener = id; } };
    getElement("settingsClose").click();
    assert.equal(getElement("settingsModal").style.display, "none");
    assert.equal(resetByBackdrop, getElement("settingsModal"));
    assert.equal(restoredOpener, "settingsModal");
  });

  it("backdrop pointerdown plus click closes the settings modal", () => {
    const { ctx, getElement } = boot();
    const modal = getElement("settingsModal");
    // inner content and the modal itself must answer null to the
    // shortcut-record/reset lookups, the default this-returning closest
    // crashes the split at line 154
    const neutral = () => null;
    modal.closest = neutral;
    getElement("someChild").closest = neutral;
    getElement("someOtherChild").closest = neutral;
    modal.fire("pointerdown", fakeEvent({ target: modal }));
    modal.fire("click", fakeEvent({ target: modal }));
    assert.equal(modal.style.display, "none");
    // A click on inner content (target mismatch) never closes.
    modal.style.display = "grid";
    modal.fire("pointerdown", fakeEvent({ target: getElement("someChild") }));
    modal.fire("click", fakeEvent({ target: getElement("someOtherChild") }));
    assert.equal(modal.style.display, "grid");
  });

  it("search palette close paths", () => {
    // the click listener captured the real closeSearchPalette at boot;
    // assert its real effects: hidden palette, drag/focus reset, timer kept
    const { ctx, getElement } = boot();
    const palette = getElement("searchPalette");
    palette.style.display = "grid";
    let dragReset = null;
    let focusRestored = null;
    ctx.window.HerdrModalDrag = { resetByBackdrop: (m) => { dragReset = m; } };
    ctx.window.HerdrModalFocus = { restoreModalOpener: (id) => { focusRestored = id; } };
    getElement("searchPaletteClose").click();
    assert.equal(palette.style.display, "none", "close button hides the palette");
    assert.equal(dragReset, palette);
    assert.equal(focusRestored, "searchPalette");
    palette.style.display = "grid";
    dragReset = null;
    palette.fire("click", fakeEvent({ target: palette }));
    assert.equal(palette.style.display, "none", "backdrop click hides the palette");
    assert.equal(dragReset, palette);
    palette.style.display = "grid";
    palette.fire("click", fakeEvent({ target: getElement("paletteRow") }));
    assert.equal(palette.style.display, "grid", "inner clicks stay inside the palette");
  });

  it("shortcut record and reset rows in the settings modal", () => {
    // rows answer only their own delegation selector; the default
    // this-returning closest would hijack the record branch for the
    // reset row and crash the dataset split
    const { ctx, getElement } = boot();
    vm.runInContext(
      "recordShortcut = function (scope, action) { window.__recorded = scope + ':' + action; }; " +
        "resetShortcut = function (scope, action) { window.__reset = scope + ':' + action; };",
      ctx,
    );
    const recordRow = getElement("recordRow");
    recordRow.dataset.shortcutRecord = "gitShortcuts:changes";
    recordRow.closest = (sel) => (sel === "[data-shortcut-record]" ? recordRow : null);
    const modal = getElement("settingsModal");
    modal.fire("click", fakeEvent({ target: recordRow }));
    assert.equal(ctx.window.__recorded, "gitShortcuts:changes");
    const resetRow = getElement("resetRow");
    resetRow.dataset.shortcutReset = "gitShortcuts:changes";
    resetRow.closest = (sel) => (sel === "[data-shortcut-reset]" ? resetRow : null);
    modal.fire("click", fakeEvent({ target: resetRow }));
    assert.equal(ctx.window.__reset, "gitShortcuts:changes");
  });
});

describe("bindings.js select and checkbox handlers", () => {
  it("theme, density, and overflow handlers persist and apply", () => {
    const { ctx, getElement } = boot();
    getElement("optTheme").value = "dark";
    getElement("optTheme").onchange();
    assert.equal(vm.runInContext("themeMode", ctx), "dark");
    getElement("optDensity").value = "compact";
    getElement("optDensity").onchange();
    assert.equal(readOption(ctx, "density"), "compact");
    const overflow = getElement("optOverflow");
    overflow.checked = true;
    overflow.onchange();
    assert.equal(readOption(ctx, "overflow"), true);
    assert.equal(readOption(ctx, "terminalOverflowOptIn"), true);
    getElement("optFit").checked = true;
    getElement("optFit").onchange();
    assert.equal(readOption(ctx, "fitToBrowser"), true);
    getElement("optShiftEnterNewline").checked = true;
    getElement("optShiftEnterNewline").onchange();
    assert.equal(readOption(ctx, "shiftEnterNewline"), true);
    getElement("optGlobalShortcutsEnabled").checked = true;
    getElement("optGlobalShortcutsEnabled").onchange();
    assert.equal(readOption(ctx, "globalShortcutsEnabled"), true);
    getElement("optShortcutHintToasts").checked = false;
    getElement("optShortcutHintToasts").onchange();
    assert.equal(readOption(ctx, "shortcutHintToasts"), false);
  });

  it("close shortcut select saves through its own helper", () => {
    // onchange captured the real helper; assert its real effects on
    // options.closeShortcut and the close-chord cooldown
    const { ctx, getElement } = boot();
    vm.runInContext("closeChordUntil = 12345;", ctx);
    getElement("optCloseShortcut").value = "altw";
    getElement("optCloseShortcut").onchange();
    assert.equal(readOption(ctx, "closeShortcut"), "altw");
    assert.equal(vm.runInContext("closeChordUntil", ctx), 0, "changing the shortcut clears the active close chord");
  });

  it("global shortcut prefix capture records a pressed chord", () => {
    const { ctx, getElement } = boot();
    const button = getElement("optGlobalShortcutPrefixCapture");
    const input = getElement("optGlobalShortcutPrefix");
    button.click();
    assert.equal(button.textContent, "Press keys...");
    assert.equal(input.value, "Press keys...");
    vm.runInContext("applyOptions = function () { window.__applyCount = (window.__applyCount || 0) + 1; };", ctx);
    ctx.fireWindow("keydown", fakeEvent({ key: "p", code: "KeyP", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }));
    assert.equal(readOption(ctx, "globalShortcutPrefix"), "Ctrl+P");
    assert.equal(button.textContent, "Record");
    assert.equal(vm.runInContext("window.__applyCount", ctx), 1);
  });
});

describe("bindings.js terminal settings handlers", () => {
  it("font family and size handlers write options and refit", () => {
    // font family saves through the settings-commit chrome, not onchange
    const { ctx, getElement } = boot();
    vm.runInContext("fitTerminalShell = function () {}; resetTerminalConnection = function () {}; connectTerminal = function () {};", ctx);
    getElement("optTerminalFontFamily").value = "MonoFont, monospace";
    ctx.HerdrSettingsCommit.commit("optTerminalFontFamily");
    assert.equal(readOption(ctx, "terminalFontFamily"), "MonoFont, monospace");
    getElement("optTerminalFontSize").value = "99";
    getElement("optTerminalFontSize").oninput();
    assert.equal(readOption(ctx, "terminalFontSize"), 22, "size clamps to 22");
    getElement("optTerminalFontSize").value = "2";
    getElement("optTerminalFontSize").oninput();
    assert.equal(readOption(ctx, "terminalFontSize"), 10, "size floors at 10");
    ctx.HerdrSettingsCommit.commit("optTerminalFontSize");
    assert.equal(readOption(ctx, "terminalFontSize"), 10);
    const core = getElement("optTerminalCore");
    // resolveTerminalCore keeps only wterm; every other value lands on ghostty
    core.value = "wterm";
    core.onchange();
    assert.equal(readOption(ctx, "terminalCore"), "wterm");
    assert.equal(readOption(ctx, "terminalCoreGhosttyMigrated"), true);
    getElement("optTerminalLinks").checked = true;
    getElement("optTerminalLinks").onchange();
    assert.equal(readOption(ctx, "terminalLinks"), true);
    getElement("optTerminalMouseReporting").checked = true;
    getElement("optTerminalMouseReporting").onchange();
    assert.equal(readOption(ctx, "terminalMouseReporting"), true);
  });

  it("agent sort select drives the status order default", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("render = function () {};", ctx);
    const sort = getElement("optAgentSortMode");
    sort.onchange();
    assert.equal(readOption(ctx, "agentSortMode"), "off", "the empty select normalizes to the off default");
    assert.ok(Array.isArray(readOption(ctx, "agentStatusOrder")));
    sort.value = "attention_inverted";
    sort.onchange();
    assert.equal(readOption(ctx, "agentSortMode"), "attention_inverted");
  });

  it("sidebar workspace percent commit", () => {
    const { ctx, getElement } = boot();
    getElement("optSidebarWorkspacePercent").value = "90";
    ctx.HerdrSettingsCommit.commit("optSidebarWorkspacePercent");
    assert.equal(readOption(ctx, "sidebarWorkspacePercent"), 80);
  });
});

describe("bindings.js drag strips (wireSidebarWidthDrag)", () => {
  function bootDrag() {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `expandLeftSidebarFromDrag = function () { window.__expandLeft = (window.__expandLeft || 0) + 1; return true; };
      collapseLeftSidebarFromDrag = function () { window.__collapseLeft = (window.__collapseLeft || 0) + 1; return true; };
      expandRightSidebarFromDrag = function () { window.__expandRight = (window.__expandRight || 0) + 1; return true; };
      collapseRightSidebarFromDrag = function () { window.__collapseRight = (window.__collapseRight || 0) + 1; return true; };`,
      ctx,
    );
    return { ctx, getElement };
  }

  it("pointer drag past the threshold previews and commits a width", () => {
    const d = bootDrag();
    const strip = d.getElement("sidebarToggle");
    // app.html ships the ghost hidden; the element factory defaults visible
    d.getElement("sidebarPreview").hidden = true;
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 1 }));
    // Below threshold: no drag yet.
    strip.fire("pointermove", fakeEvent({ clientX: 102, pointerId: 1, buttons: 1 }));
    assert.equal(d.getElement("sidebarPreview").hidden, true, "below threshold nothing previews");
    assert.equal(strip.classList.contains("dragging"), false);
    strip.fire("pointermove", fakeEvent({ clientX: 140, pointerId: 1, buttons: 1 }));
    assert.equal(strip.classList.contains("dragging"), true);
    const ghost = d.getElement("sidebarPreview");
    assert.equal(ghost.hidden, false, "the ghost shows the pending width");
    assert.equal(ghost.style.getPropertyValue("width"), "370px");
    strip.fire("pointerup", fakeEvent({ pointerId: 1 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 370, "release commits base 330 plus delta");
    assert.equal(strip.classList.contains("dragging"), false);
    assert.equal(ghost.classList.contains("fading"), true, "ghost fades on release");
    assert.equal(d.getElement("app").classList.contains("sidebar-resizing"), true, "commit transition armed");
  });

  it("collapsed-to-open drag sizes the reopened column and expands", () => {
    const d = bootDrag();
    const strip = d.getElement("sidebarToggle");
    d.getElement("sidebarPreview").hidden = true;
    vm.runInContext("sidebarCollapsed = true; options.sidebarWidth = 330;", d.ctx);
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 2 }));
    // Inward drag from collapsed: no preview, no commit.
    strip.fire("pointermove", fakeEvent({ clientX: 90, pointerId: 2, buttons: 1 }));
    assert.equal(d.getElement("sidebarPreview").hidden, true);
    // Outward drag: preview then commit; expand runs before the width lands.
    strip.fire("pointermove", fakeEvent({ clientX: 160, pointerId: 2, buttons: 1 }));
    assert.equal(d.getElement("sidebarPreview").hidden, false);
    strip.fire("pointerup", fakeEvent({ pointerId: 2 }));
    // the reopened column floors at the stock minimum, the drag distance
    // alone (60px here) cannot go below it
    assert.equal(readOption(d.ctx, "sidebarWidth"), 330);
    assert.equal(d.ctx.window.__expandLeft, 1);
  });

  it("drag toward the collapse zone snaps to the closer edge", () => {
    const d = bootDrag();
    const strip = d.getElement("sidebarToggle");
    d.getElement("sidebarPreview").hidden = true;
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 3 }));
    // -290px: below the 330 minimum, closer to collapsed than the minimum.
    strip.fire("pointermove", fakeEvent({ clientX: -190, pointerId: 3, buttons: 1 }));
    assert.equal(d.getElement("sidebarPreview").classList.contains("closing"), true, "the closing hint shows");
    strip.fire("pointerup", fakeEvent({ pointerId: 3 }));
    assert.equal(d.ctx.window.__collapseLeft, 1, "the release collapses");
    assert.equal(readOption(d.ctx, "sidebarWidth"), 330, "collapse keeps the stored width");
    // -230px: below minimum but closer to the minimum, so the commit is a
    // plain width that floors at 330 (clientX 0 puts next at 230, whose
    // distance to collapsed beats its distance to the minimum)
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 4 }));
    strip.fire("pointermove", fakeEvent({ clientX: 0, pointerId: 4, buttons: 1 }));
    assert.equal(d.getElement("sidebarPreview").classList.contains("closing"), false);
    strip.fire("pointerup", fakeEvent({ pointerId: 4 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 330, "width floors at the stock minimum");
    // window pointermove with buttons 0 (missed release) commits pending.
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 5 }));
    strip.fire("pointermove", fakeEvent({ clientX: 150, pointerId: 5, buttons: 1 }));
    d.ctx.fireWindow("pointermove", fakeEvent({ clientX: 160, pointerId: 5, buttons: 0 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 380);
    // pointercancel runs the same stop path, so a pending width commits.
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 6 }));
    strip.fire("pointermove", fakeEvent({ clientX: 150, pointerId: 6, buttons: 1 }));
    strip.fire("pointercancel", fakeEvent({ pointerId: 6 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 430, "cancel commits the pending width");
    // a right-button pointerdown never arms the drag
    strip.fire("pointerdown", fakeEvent({ button: 2, clientX: 100, pointerId: 8 }));
    strip.fire("pointermove", fakeEvent({ clientX: 150, pointerId: 8, buttons: 2 }));
    strip.fire("pointerup", fakeEvent({ pointerId: 8 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 430, "non-primary buttons never drag");
    // window pointerup commits a pending drag too
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 9 }));
    strip.fire("pointermove", fakeEvent({ clientX: 150, pointerId: 9, buttons: 1 }));
    d.ctx.fireWindow("pointerup", fakeEvent({ pointerId: 9 }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 480);
  });

  it("keyboard arrows and dblclick resize the left and right strips", () => {
    const d = bootDrag();
    const left = d.getElement("sidebarToggle");
    left.fire("keydown", fakeEvent({ key: "ArrowRight" }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 338);
    left.fire("keydown", fakeEvent({ key: "ArrowLeft" }));
    assert.equal(readOption(d.ctx, "sidebarWidth"), 330);
    const right = d.getElement("rightSidebarToggle");
    right.fire("keydown", fakeEvent({ key: "ArrowLeft" }));
    assert.equal(readOption(d.ctx, "rightSidebarWidth"), 328);
    right.fire("keydown", fakeEvent({ key: "ArrowRight" }));
    assert.equal(readOption(d.ctx, "rightSidebarWidth"), 320);
    right.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(readOption(d.ctx, "rightSidebarWidth"), 320, "unrelated keys never resize");
    right.fire("dblclick", fakeEvent({}));
    assert.equal(readOption(d.ctx, "rightSidebarWidth"), 320, "dblclick resets to stock");
  });

  it("the drag-suppressed click swallows the trailing click once", () => {
    const d = bootDrag();
    const strip = d.getElement("sidebarToggle");
    strip.fire("pointerdown", fakeEvent({ button: 0, clientX: 100, pointerId: 7 }));
    strip.fire("pointermove", fakeEvent({ clientX: 150, pointerId: 7, buttons: 1 }));
    let swallowed = false;
    strip.fire("click", fakeEvent({ stopImmediatePropagation() { swallowed = true; } }));
    assert.equal(swallowed, true);
    // The suppressor is one-shot.
    swallowed = false;
    strip.fire("click", fakeEvent({ stopImmediatePropagation() { swallowed = true; } }));
    assert.equal(swallowed, false);
  });
});

describe("bindings.js misc option handlers", () => {
  it("parent close mode, workspace open terminal, and stuck working", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("render = function () {};", ctx);
    // normalizeOptions keeps only panels/close for parentCloseMode and
    // default/drag/state for workspaceSort; use legal values.
    getElement("optParentCloseMode").value = "close";
    getElement("optParentCloseMode").onchange();
    assert.equal(readOption(ctx, "parentCloseMode"), "close");
    getElement("optWorkspaceOpenTerminal").checked = true;
    getElement("optWorkspaceOpenTerminal").onchange();
    assert.equal(readOption(ctx, "workspaceOpenTerminal"), true);
    getElement("optCloseWorkspaceOnLastTerminal").checked = false;
    getElement("optCloseWorkspaceOnLastTerminal").onchange();
    assert.equal(readOption(ctx, "closeWorkspaceOnLastTerminal"), false);
    getElement("optStuckWorkingEnabled").checked = true;
    getElement("optStuckWorkingEnabled").onchange();
    assert.equal(readOption(ctx, "stuckWorkingEnabled"), true);
    getElement("optPromptCardsEnabled").checked = true;
    getElement("optPromptCardsEnabled").onchange();
    assert.equal(readOption(ctx, "promptCardsEnabled"), true);
  });

  it("working dismiss minutes commit clamps 1..1440", () => {
    const { ctx, getElement } = boot();
    getElement("optWorkingDismissMinutes").value = "9999";
    ctx.HerdrSettingsCommit.commit("optWorkingDismissMinutes");
    assert.equal(readOption(ctx, "workingDismissMinutes"), 1440);
    getElement("optWorkingDismissMinutes").value = "0";
    ctx.HerdrSettingsCommit.commit("optWorkingDismissMinutes");
    assert.equal(readOption(ctx, "workingDismissMinutes"), 30, "zero falls back to 30");
  });

  it("workspace sort and sound scope selects persist", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("render = function () {};", ctx);
    getElement("optWorkspaceSort").value = "drag";
    getElement("optWorkspaceSort").onchange();
    assert.equal(readOption(ctx, "workspaceSort"), "drag");
    getElement("optSoundScope").value = "all";
    getElement("optSoundScope").onchange();
    assert.equal(readOption(ctx, "soundScope"), "all");
  });

  it("notification volume and scroll lines inputs clamp", () => {
    const { ctx, getElement } = boot();
    const volume = getElement("optNotificationVolume");
    volume.value = "150";
    volume.oninput();
    assert.equal(readOption(ctx, "notificationVolume"), 1);
    volume.value = "40";
    volume.oninput();
    assert.equal(readOption(ctx, "notificationVolume"), 0.4);
    getElement("optScrollLines").value = "99";
    getElement("optScrollLines").oninput();
    assert.equal(readOption(ctx, "scrollLines"), 20);
    getElement("optScrollLines").value = "2";
    getElement("optScrollLines").oninput();
    assert.equal(readOption(ctx, "scrollLines"), 2);
  });

  it("editor checkboxes and tab size commit", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("render = function () {};", ctx);
    for (const [id, key] of [
      ["optEditorEnabled", "editorEnabled"],
      ["optEditorWordWrap", "editorWordWrap"],
      ["optEditorBracketMatching", "editorBracketMatching"],
      ["optEditorFolding", "editorFolding"],
      ["optEditorActiveLine", "editorActiveLine"],
      ["optEditorWhitespace", "editorWhitespace"],
    ]) {
      const el = getElement(id);
      el.checked = true;
      el.onchange();
      assert.equal(readOption(ctx, key), true, `${id} persists`);
    }
    getElement("optEditorTabSize").value = "99";
    ctx.HerdrSettingsCommit.commit("optEditorTabSize");
    assert.equal(readOption(ctx, "editorTabSize"), 8);
    getElement("optEditorTabSize").value = "4";
    ctx.HerdrSettingsCommit.commit("optEditorTabSize");
    assert.equal(readOption(ctx, "editorTabSize"), 4);
    getElement("optHeaderSearchEnabled").checked = true;
    getElement("optHeaderSearchEnabled").onchange();
    assert.equal(readOption(ctx, "headerSearchEnabled"), true);
  });

  it("file browser toggles persist without extra applies", () => {
    const { ctx, getElement } = boot();
    getElement("optFileBrowserGitStatus").checked = true;
    getElement("optFileBrowserGitStatus").onchange();
    assert.equal(readOption(ctx, "fileBrowserGitStatus"), true);
    getElement("optFileBrowserLineNumbers").checked = true;
    getElement("optFileBrowserLineNumbers").onchange();
    assert.equal(readOption(ctx, "fileBrowserLineNumbers"), true);
    getElement("optEditorFindShortcutEnabled").checked = true;
    getElement("optEditorFindShortcutEnabled").onchange();
    assert.equal(readOption(ctx, "editorFindShortcutEnabled"), true);
    getElement("optFileContentSearchDefaultExpanded").checked = true;
    getElement("optFileContentSearchDefaultExpanded").onchange();
    assert.equal(readOption(ctx, "fileContentSearchDefaultExpanded"), true);
    getElement("optFileContentSearchMatchCase").checked = true;
    getElement("optFileContentSearchMatchCase").onchange();
    assert.equal(readOption(ctx, "fileContentSearchMatchCase"), true);
    getElement("optFileContentSearchRegex").checked = true;
    getElement("optFileContentSearchRegex").onchange();
    assert.equal(readOption(ctx, "fileContentSearchRegex"), true);
    getElement("optGenerateWorktreeNames").checked = false;
    getElement("optGenerateWorktreeNames").onchange();
    assert.equal(readOption(ctx, "generateWorktreeNames"), false);
  });

  it("worktree autodiscover commit clamps to 0..30 seconds", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("scheduleWorktreeAutodiscover = function () {};", ctx);
    getElement("optWorktreeAutoDiscover").value = "99";
    ctx.HerdrSettingsCommit.commit("optWorktreeAutoDiscover");
    assert.equal(readOption(ctx, "worktreeAutoDiscoverSeconds"), 30);
    getElement("optWorktreeAutoDiscover").value = "0";
    ctx.HerdrSettingsCommit.commit("optWorktreeAutoDiscover");
    assert.equal(readOption(ctx, "worktreeAutoDiscoverSeconds"), 0);
  });

  it("worktree and exploration directory commits trim their values", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("syncWorktreeCheckoutPath = function () {}; ", ctx);
    getElement("optWorktreeDefaultDirectory").value = "  /wt  ";
    ctx.HerdrSettingsCommit.commit("optWorktreeDefaultDirectory");
    assert.equal(readOption(ctx, "worktreeDefaultDirectory"), "/wt");
    getElement("optExplorationDefaultDirectory").value = "  /exp  ";
    ctx.HerdrSettingsCommit.commit("optExplorationDefaultDirectory");
    assert.equal(readOption(ctx, "explorationDefaultDirectory"), "/exp");
  });

  it("sound and browser notification toggles", () => {
    const { ctx, getElement } = boot();
    getElement("optSound").checked = true;
    getElement("optSound").onchange();
    assert.equal(readOption(ctx, "sound"), true);
    getElement("optBrowserNotifications").checked = true;
    getElement("optBrowserNotifications").onchange();
    assert.ok(true, "setBrowserNotifications ran without throwing");
  });
});

describe("bindings.js worktree modal wiring", () => {
  it("create modal buttons and inputs call their helpers", async () => {
    // listeners captured the real helpers at boot; assert their real state
    // effects instead of vm-stub call counters
    const { ctx, getElement } = boot();
    vm.runInContext(
      `scheduleCreateWorktreeAutodiscover = function () { window.__sched = (window.__sched || 0) + 1; };
      clearCreateWorktreeSuggestions = function () { window.__cleared = true; };
      discoverCreateWorktreeSource = async function () { window.__discovered = true; };`,
      ctx,
    );
    getElement("worktreeCreateClose").click();
    getElement("worktreeCreateCancel").click();
    assert.equal(getElement("worktreeCreateModal").style.display, "none");
    getElement("worktreeCreateSource").oninput();
    assert.equal(ctx.window.__sched, 1);
    getElement("worktreeCreateSource").fire("keydown", fakeEvent({ key: "Enter" }));
    assert.equal(ctx.window.__cleared, true);
    assert.equal(ctx.window.__discovered, true);
    // branch edits sync the checkout path default: with no source repo the
    // pending default clears
    vm.runInContext("state.createWorktreeDefaultPath = 'old/default';", ctx);
    getElement("worktreeBranch").fire("input", fakeEvent({}));
    getElement("worktreeBranch").fire("change", fakeEvent({}));
    assert.equal(vm.runInContext("state.createWorktreeDefaultPath", ctx), "");
    // base edits derive the branch name and record it as pending
    getElement("worktreeNewBase").value = "feature/login";
    getElement("worktreeNewBase").fire("input", fakeEvent({}));
    getElement("worktreeNewBase").fire("change", fakeEvent({}));
    assert.equal(getElement("worktreeNewBranch").value, "feature/login");
    assert.equal(vm.runInContext("state.openWorktreeBaseBranchName", ctx), "feature/login");
    getElement("worktreeOpenClose").click();
    assert.equal(getElement("worktreeOpenModal").style.display, "none");
    await new Promise((r) => setImmediate(r));
  });

  it("create form submit routes through resolveWorktreeSource and submitWorktreeCreate", async () => {
    const { ctx, getElement } = boot();
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `resolveWorktreeSource = function (info) { return { workspace_id: info.workspaceId, cwd: info.sourcePath, from: info.originalSource }; };
      submitWorktreeCreate = async function (args) { window.__submitted = args; };
      closeWorktreeCreateModal = function () {};`,
      ctx,
    );
    getElement("worktreePullBase").checked = true;
    getElement("worktreeCreateSource").value = "/src/path";
    const form = getElement("worktreeCreateForm");
    form.onsubmit(fakeEvent({}));
    await new Promise((r) => setImmediate(r));
    const args = ctx.window.__submitted;
    assert.ok(args, "the form submitted");
    assert.equal(args.branch, "");
    assert.equal(args.pullBase, true);
    assert.equal(args.source.cwd, "/src/path");
    assert.equal(args.source.workspace_id, null);
  });

  it("worktree open modal refresh and new form", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `refresh = async function () { window.__refreshed = true; };
      discoverWorktrees = async function () { window.__discovered = true; };
      syncWorktreePathOptions = function () { window.__synced = true; };
      renderWorktreeOpenList = function () { window.__rendered = (window.__rendered || 0) + 1; };
      validOpenWorktreeRows = function () { return []; };
      createDiscoveredWorktree = function () { window.__createdWt = true; };
      createWorkspaceFromSmartModal = function () { window.__smartWs = (window.__smartWs || 0) + 1; };
      fetchWorktreeRemoteBranches = async function () { window.__fetched = true; };`,
      ctx,
    );
    getElement("worktreeDiscoverPath").value = "";
    await getElement("worktreeOpenRefresh").onclick();
    assert.equal(ctx.window.__refreshed, true);
    assert.equal(ctx.window.__synced, true);
    assert.equal(ctx.window.__rendered, 1);
    getElement("worktreeDiscoverPath").value = "/some/path";
    await getElement("worktreeOpenRefresh").onclick();
    assert.equal(ctx.window.__discovered, true);
    getElement("worktreeNewForm").onsubmit(fakeEvent({}));
    assert.equal(ctx.window.__createdWt, true);
    // submit captured the real smart-modal helper (reference assignment):
    // the filled folder plus empty label early-returns with its error.
    // The label keydown resolves the name dynamically, so it reaches the
    // vm stub instead; one real call, one stub call.
    const err = getElement("worktreeOpenError");
    getElement("worktreeWorkspaceSubmit").click();
    assert.equal(err.textContent, "Workspace name is required.");
    getElement("worktreeWorkspaceLabel").fire("keydown", fakeEvent({ key: "Enter" }));
    assert.equal(ctx.window.__smartWs, 1);
    // fetch remotes captured the real helper: the remote flag flips on
    getElement("worktreeFetchRemotes").click();
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("state.openWorktreeIncludeRemoteBranches", ctx), true);
  });

  it("discover path input rewires source, selection, and autodiscover", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `syncSmartWorkspaceLabel = function () { window.__label = true; };
      worktreeSourceKey = function (source) { return source; };
      syncWorktreeBranchOptions = function () { window.__branchOpts = true; };
      renderWorktreeOpenList = function () { window.__rendered = true; };
      scheduleWorktreeAutodiscover = function () { window.__scheduled = true; };
      discoverWorktrees = function () { window.__discovered = true; };
      renderPathOptions = function () { window.__pathOpts = true; };`,
      ctx,
    );
    const input = getElement("worktreeDiscoverPath");
    // textValue comes destructured as a const from HerdrAppHelpers, so it
    // cannot be reassigned; feed real row objects instead.
    ctx.state.openWorktreeSource = "other";
    ctx.state.openWorktreeSuggestionLocked = true;
    input.fire("input", fakeEvent({}));
    assert.equal(ctx.state.openWorktreeSuggestionLocked, false, "the lock clears on input");
    input.fire("input", fakeEvent({}));
    assert.equal(ctx.state.openWorktreeSource, null, "changed path rewires the source");
    // vm-realm arrays fail cross-realm deepEqual; length is the observable
    assert.equal(vm.runInContext("state.openWorktreeRows.length", ctx), 0);
    assert.equal(ctx.window.__branchOpts, true);
    assert.equal(ctx.window.__rendered, true);
    assert.equal(ctx.window.__scheduled, true);
    input.fire("keydown", fakeEvent({ key: "Enter" }));
    assert.equal(ctx.state.openWorktreeSuggestionLocked, true);
    assert.equal(ctx.window.__pathOpts, true);
    assert.equal(ctx.window.__discovered, true);
    // a linked worktree row matching the typed path becomes the selection;
    // the first input clears the Enter lock, the second runs the lookup
    ctx.state.openWorktreeRows = [{ path: "/repo", is_linked_worktree: true }];
    input.value = "/repo";
    input.fire("input", fakeEvent({}));
    input.fire("input", fakeEvent({}));
    assert.equal(ctx.state.openWorktreeSelected, 0);
    // a non-matching path leaves the selection empty
    input.value = "/nope";
    input.fire("input", fakeEvent({}));
    assert.equal(ctx.state.openWorktreeSelected, null);
  });
});

describe("bindings.js Escape cascade", () => {
  it("Escape walks no-sleep menu, pane menu, and the modal stack", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `closePaneMenu = function () { window.__paneMenuClosed = true; };
      closeQuestion = function () { window.__questionClosed = true; };
      closeWorkspaceCreateModal = function () { window.__wsCreateClosed = true; };
      closeWorktreeOpenModal = function () { window.__wtOpenClosed = true; };
      closeWorktreeCreateModal = function () { window.__wtCreateClosed = true; };
      closeSearchPalette = function () { window.__paletteClosed = true; };
      hideSessionManager = function () { window.__sessionsHidden = true; };`,
      ctx,
    );
    // No open modal: Escape is a no-op. The auto-creating getElementById
    // would invent a paneMenu and fire the real close, so null it first.
    const menuBackup = ctx.document.getElementById;
    ctx.document.getElementById = (id) => (id === "paneMenu" ? null : menuBackup(id));
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__paneMenuClosed, undefined);
    // Pane menu first.
    ctx.document.getElementById = (id) => (id === "paneMenu" ? getElement("paneMenu") : menuBackup(id));
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__paneMenuClosed, true);
    // every later step must skip the pane-menu branch again: the auto-
    // creating getElementById would re-enter closePaneMenu forever
    ctx.document.getElementById = (id) => (id === "paneMenu" ? null : menuBackup(id));
    // Question modal.
    getElement("questionModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__questionClosed, true);
    // Workspace create modal.
    getElement("questionModal").style.display = "none";
    getElement("workspaceCreateModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__wsCreateClosed, true);
    // Worktree open modal.
    getElement("workspaceCreateModal").style.display = "none";
    getElement("worktreeOpenModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__wtOpenClosed, true);
    // Worktree create modal.
    getElement("worktreeOpenModal").style.display = "none";
    getElement("worktreeCreateModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__wtCreateClosed, true);
    // Search palette.
    getElement("worktreeCreateModal").style.display = "none";
    getElement("searchPalette").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__paletteClosed, true);
    // Settings modal: inline close path.
    getElement("searchPalette").style.display = "none";
    getElement("settingsModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(getElement("settingsModal").style.display, "none");
    // Session manager path.
    getElement("sessionManager").style.display = "block";
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__sessionsHidden, true);
    // Directory picker path.
    getElement("sessionManager").style.display = "none";
    const picker = getElement("directoryPickerModal");
    picker.classList.add("directory-picker-backdrop");
    ctx.window.HerdrDirectoryPicker = { close() { ctx.window.__pickerClosed = true; } };
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(ctx.window.__pickerClosed, true);
    // No-sleep menu path.
    const menu = getElement("theNoSleepMenu");
    menu.classList.add("no-sleep-menu");
    ctx.document.querySelector = (sel) => (sel.includes("no-sleep-menu") ? menu : null);
    const control = getElement("noSleepControlForEscape");
    menu.closest = () => getElement("noSleepWrapForEscape");
    getElement("noSleepWrapForEscape").querySelector = () => control;
    ctx.document.fire("keydown", fakeEvent({ key: "Escape" }));
    assert.equal(menu.hidden, true);
    assert.equal(control.attributes["aria-expanded"], "false");
    assert.equal(control.focused, true);
  });

  it("mousedown outside an open pane menu closes it", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("closePaneMenu = function () { window.__paneMenuClosed = true; };", ctx);
    const menuBackup = ctx.document.getElementById;
    const paneMenu = getElement("paneMenu");
    paneMenu.contains = () => false;
    // the outside target must answer null to the .pane-menu-button
    // lookup, the default this-returning closest would skip the close
    getElement("someButton").closest = () => null;
    getElement("insideMenu").closest = () => null;
    ctx.document.getElementById = (id) => (id === "paneMenu" ? paneMenu : menuBackup(id));
    ctx.document.fire("mousedown", fakeEvent({ target: getElement("someButton") }));
    assert.equal(ctx.window.__paneMenuClosed, true);
    // Click on the pane menu button itself: no close.
    ctx.window.__paneMenuClosed = false;
    const menuButton = getElement("somePaneMenuButton");
    menuButton.closest = () => menuButton;
    ctx.document.fire("mousedown", fakeEvent({ target: menuButton }));
    assert.notEqual(ctx.window.__paneMenuClosed, true);
    // Inside the menu: no close.
    paneMenu.contains = () => true;
    ctx.document.fire("mousedown", fakeEvent({ target: getElement("insideMenu") }));
    assert.notEqual(ctx.window.__paneMenuClosed, true);
  });
});

describe("bindings.js Tab focus trap", () => {
  it("Tab inside an open modal cycles first and last focusable", () => {
    const { ctx, getElement } = boot();
    const first = element("modalFirst");
    const last = element("modalLast");
    const modal = getElement("settingsModal");
    modal.style.display = "grid";
    modal.querySelectorAll = () => [first, last];
    modal.contains = (node) => node === first || node === last;
    let active = null;
    ctx.document.activeElement = last;
    // Forward Tab from the last: focus wraps to first.
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.equal(first.focused, true);
    // Backward Tab from the first: focus wraps to last.
    ctx.document.activeElement = first;
    ctx.document.fire("keydown", fakeEvent({ key: "Tab", shiftKey: true }));
    assert.equal(last.focused, true);
    // Active outside the scope: Tab moves into the first.
    ctx.document.activeElement = getElement("outsideThing");
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.equal(first.focused, true);
    // No focusables: preventDefault only.
    modal.querySelectorAll = () => [];
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.ok(true);
    // All focusables hidden: no focus move.
    const hiddenA = element("hiddenA");
    const hiddenB = element("hiddenB");
    hiddenA.offsetParent = null;
    hiddenB.offsetParent = null;
    modal.querySelectorAll = () => [hiddenA, hiddenB];
    ctx.document.activeElement = null;
    hiddenA.focused = false;
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.equal(hiddenA.focused, false);
  });

  it("question modal, git modal, session manager scopes win over settings", () => {
    const { ctx, getElement } = boot();
    const gitModal = getElement("gitModalScope");
    gitModal.classList.add("git-ui-modal-backdrop");
    ctx.document.querySelector = (sel) => (sel.includes("git-ui-modal-backdrop") ? gitModal : null);
    const first = element("gitFirst");
    const last = element("gitLast");
    gitModal.querySelectorAll = () => [first, last];
    ctx.document.activeElement = null;
    getElement("settingsModal").style.display = "grid";
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.equal(first.focused, true, "the git modal scope wins");
    // Session manager (display block) beats the static modal list.
    gitModal.classList.remove("git-ui-modal-backdrop");
    ctx.document.querySelector = () => null;
    const session = getElement("sessionManager");
    session.style.display = "block";
    const sFirst = element("sessionFirst");
    session.querySelectorAll = () => [sFirst];
    ctx.document.activeElement = null;
    ctx.document.fire("keydown", fakeEvent({ key: "Tab" }));
    assert.equal(sFirst.focused, true);
  });
});

describe("bindings.js terminal follow and clipboard keys", () => {
  it("terminalFollowButton scrolls the terminal to bottom", () => {
    // onclick captured the real helper; assert its real effect: the
    // follow button hides and marks itself aria-hidden when un-pausing
    const { ctx, getElement } = boot();
    const button = getElement("terminalFollowButton");
    button.hidden = false;
    button.click();
    assert.equal(button.hidden, true, "un-pausing hides the follow button");
    assert.equal(button.getAttribute("aria-hidden"), "true");
  });

  it("copy and paste keys route through the terminal", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `copySelection = function () { window.__copied = true; };
      pasteClipboard = function () { window.__pasted = true; };
      term = { getSelection: function () { return "some text"; } };`,
      ctx,
    );
    ctx.document.fire("keydown", fakeEvent({ key: "c", ctrlKey: true, target: getElement("paneSurface") }));
    assert.equal(ctx.window.__copied, true);
    ctx.document.fire("keydown", fakeEvent({ key: "v", ctrlKey: true, target: getElement("paneSurface") }));
    assert.equal(ctx.window.__pasted, true);
    // Lens active: paste never reaches the hidden terminal.
    ctx.globalThis.HerdrLens = { isActive: () => true };
    ctx.window.__pasted = false;
    ctx.document.fire("keydown", fakeEvent({ key: "v", ctrlKey: true, target: getElement("paneSurface") }));
    assert.equal(ctx.window.__pasted, false);
  });
});

describe("bindings.js visibilitychange handlers", () => {
  it("hidden clears timers and visible reconnects", async () => {
    const { ctx, getElement } = boot();
    // boot-time refresh() is still in flight and its continuation calls
    // updateConnectionChip; flush it before stubbing so the count is exact
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `updateConnectionChip = function () { window.__chip = (window.__chip || 0) + 1; };
      loadVersions = function () { window.__versions = true; };
      refresh = function () { window.__refresh = true; };
      connectEvents = function () { window.__events = true; };
      loadNoSleep = function () { window.__sleep = true; };
      eventWs = { close() { window.__eventWsClosed = true; } };
      termWs = { close() { window.__termWsClosed = true; } };
      noSleepPollTimer = 1; hiddenTimer = 0;`,
      ctx,
    );
    ctx.document.hidden = true;
    ctx.document.fire("visibilitychange", fakeEvent({}));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.window.__chip, 1);
    ctx.document.hidden = false;
    ctx.document.fire("visibilitychange", fakeEvent({}));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.window.__versions, true);
    assert.equal(ctx.window.__refresh, true);
    assert.equal(ctx.window.__events, true);
    assert.equal(ctx.window.__sleep, true);
  });
});
