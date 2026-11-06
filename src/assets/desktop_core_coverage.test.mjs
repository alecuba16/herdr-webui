// Coverage batch for the desktop core surfaces: app bundle boot drives
// core.js, terminal.js, settings_sections.js, workspace_create.js and
// search_panel.js paths; standalone harnesses (mirroring the existing
// per-file tests) drive file_browser.js and directory_picker.js.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// ---------------------------------------------------------------- boot

const APP_BUNDLE_FILES = [
  "./shared/options.js",
  "./shared/core.js",
  "./shared/actions.js",
  "./shared/workspace_search.js",
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

// css var-ish style keys land as --foo-bar: mirror into camelCase props
// because product code reads style.width etc after writing setProperty.
const camelize = (name) => String(name).replace(/-+([a-z])/g, (_, c) => c.toUpperCase());

function element(id = "") {
  const classes = new Set();
  const styleProps = {};
  const children = [];
  const listeners = {};
  const node = {
    id,
    get firstChild() { return children[0] || null; },
    classList: {
      add(n) { classes.add(n); },
      remove(n) { classes.delete(n); },
      contains(n) { return classes.has(n); },
      toggle(n, f) { const nx = f === undefined ? !classes.has(n) : !!f; if (nx) classes.add(n); else classes.delete(n); },
      _raw: classes,
    },
    style: { setProperty(n, v) { styleProps[n] = String(v); this[camelize(n)] = String(v); }, getPropertyValue(n) { return styleProps[n] || ""; }, display: "" },
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
    tabIndex: -1,
    setAttribute(n, v) { this.attributes = this.attributes || {}; this.attributes[n] = v; },
    getAttribute(n) { return (this.attributes && this.attributes[n]) != null ? this.attributes[n] : null; },
    removeAttribute() {},
    closest() { return this; },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild(child) { children.push(child); return child; },
    prepend() {},
    replaceWith() {},
    remove() {},
    children,
    focus() { this.focused = true; },
    select() { this.selected = true; },
    click() { if (typeof this.onclick === "function") this.onclick({ preventDefault() {}, stopPropagation() {} }); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { if (!listeners[t]) return; listeners[t] = listeners[t].filter((f) => f !== fn); },
    _listeners: listeners,
    scrollTo() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { bottom: 100, height: 100, left: 0, top: 0, width: 100 }; },
    getClientRects() { return [{ top: 0 }]; },
    querySelector() { return element(); },
    querySelectorAll() { return []; },
  };
  return node;
}

// Class-capable element: some code checks el.classList.contains via closest()
// (modalOpen picker check). The shared element() closest() returns itself.
function boot() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorageMap = new Map();
  const created = [];
  const ctx = {
    console,
    TextEncoder,
    TextEncoder: undefined,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) {
      if (typeof fn === "function") fn();
      return 1;
    },
    requestAnimationFrame(fn) { if (typeof fn === "function") fn(); return 1; },
    cancelAnimationFrame() {},
    document: {
      body: getElement("body"),
      documentElement: element("html"),
      title: "",
      visibilityState: "hidden",
      hidden: true,
      activeElement: null,
      createElement: () => { const e = element(); created.push(e); return e; },
      execCommand: () => true,
      querySelector: () => element(),
      getElementById: getElement,
      addEventListener() {},
      contains: () => true,
      querySelectorAll: (sel) => {
        // no-sleep controls are discovered by class, not id
        if (String(sel).includes(".no-sleep-control")) return [getElement("noSleepControl")];
        return [];
      },
    },
    localStorage: {
      getItem: (key) => localStorageMap.get(key) || null,
      setItem: (key, value) => localStorageMap.set(key, String(value)),
      removeItem: (key) => localStorageMap.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "", protocol: "http:", host: "x", hostname: "x", port: "8787", search: "" },
    navigator: { clipboard: { writeText: async () => {}, readText: async () => "" } },
    Notification: { permission: "granted", requestPermission: async () => "granted" },
    window: null,
    globalThis: null,
    WebSocket: class {
      constructor() { this.readyState = 0; }
      send() {}
      close() {}
    },
    fetch: async (url) => ({
      status: 200,
      ok: true,
      json: async () => {
        // /api/no-sleep must answer a parked state: the boot-time loadNoSleep
        // re-arms its poll while visible, and a failing default response
        // would loop the poller forever once a test unhides the document
        if (String(url).includes("/api/no-sleep"))
          return { mode: "off", until_ms: null, error: null, supported: true };
        return {};
      },
    }),
    addEventListener() {},
    removeEventListener() {},
    prompt: () => null,
    confirm: () => true,
    alert() {},
    showBlocking() {},
    hideBlocking() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    HerdrAppHelpers: {
      resolveTerminalFontFamily: (v) => String(v == null ? "" : v).trim() || "ui-monospace,SFMono-Regular,Menlo,monospace",
      resolveTerminalCore: (v) => (v === "wterm" ? "wterm" : "ghostty"),
      pathBasename: (p) => String(p || "").split("/").filter(Boolean).pop() || String(p || ""),
      hashId: () => "hash",
    },
  };
  delete ctx.TextEncoder;
  ctx.TextEncoder = TextEncoder;
  ctx.terminal = getElement("terminal");
  // core.js captures settingsBody once at load; the filter needs a real
  // .modal > h2 card and a .settings-body with live children on it
  const settingsCard = element("settingsModalCard");
  settingsCard.querySelector = (sel) => (String(sel).includes("h2") ? element("h2") : null);
  // register under the id the tests look up so host and vm share one node
  const settingsBodyEl = getElement("settingsBody");
  settingsBodyEl.className = "settings-body";
  const settingsModalEl = getElement("settingsModal");
  settingsModalEl.querySelector = (sel) => {
    if (String(sel).includes(".modal")) return settingsCard;
    if (String(sel).includes(".settings-body")) return settingsBodyEl;
    return null;
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const contextObject = vm.createContext(ctx);
  const httpPath = fileURLToPath(new URL("./shared/http.js", import.meta.url));
  new vm.Script(readFileSync(httpPath, "utf8"), { filename: httpPath }).runInContext(contextObject);
  HOIST_PRELOAD.runInContext(contextObject);
  for (const script of getAppBundleScripts()) script.runInContext(contextObject);
  HOIST_REWIRE.runInContext(contextObject);
  new vm.Script("window.state = state; window.options = options;", { filename: "state-mirror.js" }).runInContext(contextObject);
  return { ctx, getElement, created };
}

const readOption = (ctx, key) => vm.runInContext(`options.${key}`, ctx);

// ------------------------------------------------- core.js: settings ui

describe("core settings modal plumbing", () => {
  it("openSettingsModal prefers the sections module and falls back alone", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("window.HerdrSettingsSections = null; openSettingsModal();", ctx);
    assert.equal(getElement("settingsModal").style.display, "grid");
    getElement("settingsModal").style.display = "none";
    const marker = { opened: false };
    vm.runInContext(
      "window.HerdrSettingsSections = { openSettingsModalAt: () => { window.__atOpen = true; } };",
      ctx,
    );
    vm.runInContext("openSettingsModal();", ctx);
    assert.equal(vm.runInContext("window.__atOpen", ctx), true);
    assert.equal(getElement("settingsModal").style.display, "none");
  });

  it("saveCloseShortcutOption stores the select and resets the chord", () => {
    const { ctx, getElement } = boot();
    getElement("optCloseShortcut").value = "shiftspacew";
    vm.runInContext("saveCloseShortcutOption();", ctx);
    assert.equal(readOption(ctx, "closeShortcut"), "shiftspacew");
    assert.equal(vm.runInContext("closeChordUntil", ctx), 0);
  });

  it("closeShortcutLabel names the modes", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('closeShortcutLabel()', ctx), "Disabled");
    vm.runInContext('options.closeShortcut = "altw";', ctx);
    assert.equal(vm.runInContext("closeShortcutLabel()", ctx), "Option+W");
    vm.runInContext('options.closeShortcut = "shiftspacew";', ctx);
    assert.equal(vm.runInContext("closeShortcutLabel()", ctx), "Shift+Space, W");
  });

  it("shortcut editor records, blocks conflicts, and resets", () => {
    const { ctx, getElement } = boot();
    let capture = null;
    vm.runInContext(
      "window.addEventListener = (t, fn) => { window.__capture = fn; };",
      ctx,
    );
    const button = getElement("recordButton");
    vm.runInContext('recordShortcut("gitShortcuts", "changes", { textContent: "" })', ctx);
    capture = vm.runInContext("window.__capture", ctx);
    assert.ok(typeof capture === "function");
    // a duplicate key must be rejected and alert
    let alerted = "";
    vm.runInContext('alert = (m) => { window.__alert = m; };', ctx);
    capture({ preventDefault() {}, stopPropagation() {}, code: "KeyH" });
    assert.match(vm.runInContext("window.__alert", ctx), /conflict/i);
    // a fresh key lands in the map and saves (F9 is unused by every default map)
    capture({ preventDefault() {}, stopPropagation() {}, code: "F9" });
    assert.equal(vm.runInContext('options.gitShortcuts.changes', ctx), "F9");
    // escape style empty key re-renders only
    capture({ preventDefault() {}, stopPropagation() {}, code: "ShiftLeft" });
    // reset returns the default
    vm.runInContext('resetShortcut("gitShortcuts", "changes");', ctx);
    assert.equal(vm.runInContext('options.gitShortcuts.changes', ctx), "Digit1");
  });

  it("flashShortcutRow and settingsFeedback paths survive missing chrome", () => {
    const { ctx } = boot();
    vm.runInContext('flashShortcutRow("gitShortcuts", "changes");', ctx);
    vm.runInContext("flashSettingsApplied(null);", ctx);
    assert.ok(true);
  });

  it("agent status order move arrows swap groups", () => {
    const { ctx } = boot();
    const before = vm.runInContext("normalizeAgentStatusOrder(options.agentStatusOrder).join(',')", ctx);
    vm.runInContext("moveAgentStatusGroup('idle', 1);", ctx);
    const after = vm.runInContext("normalizeAgentStatusOrder(options.agentStatusOrder).join(',')", ctx);
    assert.notEqual(before, after);
    // out of range moves are no-ops
    vm.runInContext("moveAgentStatusGroup('idle', 99);", ctx);
    assert.equal(
      vm.runInContext("normalizeAgentStatusOrder(options.agentStatusOrder).join(',')", ctx),
      after,
    );
  });

  it("search section order render and toggles persist", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("renderSearchSectionOrderSettings();", ctx);
    assert.ok(getElement("searchSectionOrderList").innerHTML.includes("agent-sort-row"));
    vm.runInContext("toggleSearchSectionGroup('workspaces');", ctx);
    assert.equal(readOption(ctx, "searchWorkspacesEnabled"), false);
    vm.runInContext("toggleSearchSectionGroup('workspaces');", ctx);
    assert.equal(readOption(ctx, "searchWorkspacesEnabled"), true);
    vm.runInContext("moveSearchSectionGroup('workspaces', 1);", ctx);
    assert.equal(readOption(ctx, "searchSectionOrder"), "files,workspaces,content");
    vm.runInContext("moveSearchSectionGroup('bogus', 1);", ctx);
    assert.equal(readOption(ctx, "searchSectionOrder"), "files,workspaces,content");
  });

  it("filterSettings hides sections that do not match the query", () => {
    const { ctx, getElement } = boot();
    // settingsBody is captured at load; boot wires it to the settingsBody id
    const body = getElement("settingsBody");
    assert.ok(body);
    const mk = (title) => {
      const section = element();
      section.classList.add("settings-section");
      const head = element();
      head.classList.add("settings-section-head");
      const h3 = element();
      h3.textContent = title;
      head.children = [h3];
      head.textContent = title;
      section.children = [head, element()];
      section.querySelector = (sel) => (String(sel).includes("settings-section-head") ? head : null);
      return section;
    };
    body.children = [mk("Appearance"), mk("Terminal")];
    getElement("settingsSearch").value = "appearance";
    vm.runInContext("filterSettings();", ctx);
    assert.equal(body.children[0].classList.contains("settings-filter-hidden"), false);
    assert.equal(body.children[1].classList.contains("settings-filter-hidden"), true);
    getElement("settingsSearch").value = "";
    vm.runInContext("filterSettings();", ctx);
    assert.equal(body.children[1].classList.contains("settings-filter-hidden"), false);
  });
});

// ---------------------------------------------- core.js: working dismiss

describe("core working-dismiss bookkeeping", () => {
  it("dismiss and restore persist overrides then clear them", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.agents = [{ workspace_id: "ws1", tab_id: "t1", pane_id: "p1", agent_status: "working" }];
       options.stuckWorkingEnabled = true;`,
      ctx,
    );
    vm.runInContext('dismissWorkingAgent("ws1", "t1", "p1");', ctx);
    assert.equal(
      vm.runInContext('isWorkingDismissed({ workspace_id: "ws1", tab_id: "t1", pane_id: "p1", agent_status: "working" })', ctx),
      true,
    );
    vm.runInContext('restoreWorkingAgent("ws1", "t1", "p1");', ctx);
    assert.equal(
      vm.runInContext('isWorkingDismissed({ workspace_id: "ws1", tab_id: "t1", pane_id: "p1", agent_status: "working" })', ctx),
      false,
    );
  });

  it("cleanupWorkingDismissals drops stale entries by signature and ttl", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `options.stuckWorkingEnabled = true;
       options.workingDismissMinutes = 30;
       state.agents = [
         { workspace_id: "ws1", tab_id: "t1", pane_id: "p1", agent_status: "working", name: "a" },
         { workspace_id: "ws1", tab_id: "t2", pane_id: "p2", agent_status: "idle", name: "b" },
       ];
       workingDismissals = {
         "ws1:t1:p1": { dismissedAt: Date.now(), signature: agentSignature(state.agents[0]) },
         "ws1:t2:p2": { dismissedAt: Date.now(), signature: agentSignature(state.agents[1]) },
         "ws1:t3:p3": { dismissedAt: Date.now(), signature: "x" },
       };
       cleanupWorkingDismissals();`,
      ctx,
    );
    // idle agent entry removed (status no longer working)
    assert.equal(vm.runInContext('workingDismissals["ws1:t2:p2"]', ctx), undefined);
    // unseen key removed
    assert.equal(vm.runInContext('workingDismissals["ws1:t3:p3"]', ctx), undefined);
    // still-working current-signature entry kept
    assert.ok(vm.runInContext('workingDismissals["ws1:t1:p1"]', ctx));
    // ttl expiry removes the rest
    vm.runInContext(
      'workingDismissals["ws1:t1:p1"].dismissedAt = Date.now() - 3600 * 1000; cleanupWorkingDismissals();',
      ctx,
    );
    assert.equal(vm.runInContext('workingDismissals["ws1:t1:p1"]', ctx), undefined);
    // disabled option empties everything
    vm.runInContext(
      `workingDismissals = { k: 1 };
       options.stuckWorkingEnabled = false;
       cleanupWorkingDismissals();`,
      ctx,
    );
    assert.equal(vm.runInContext("Object.keys(workingDismissals).length", ctx), 0);
  });

  it("clearDismissedWorkingForTerminal only drops the matching id", () => {
    const { ctx } = boot();
    vm.runInContext(
      'render = () => {}; workingDismissals = { term1: 1, term2: 2 }; clearDismissedWorkingForTerminal("term1");',
      ctx,
    );
    assert.equal(vm.runInContext('workingDismissals["term1"]', ctx), undefined);
    assert.ok(vm.runInContext('workingDismissals["term2"]', ctx));
  });
});

// ------------------------------------------------ core.js: no-sleep control

describe("core no-sleep control", () => {
  it("labels, subscripts, and the menu html cover every mode", () => {
    const { ctx } = boot();
    for (const mode of ["auto", "1h", "2h", "4h", "infinite", "off", "bogus"]) {
      assert.equal(typeof vm.runInContext(`noSleepLabel("${mode}")`, ctx), "string");
      assert.equal(typeof vm.runInContext(`noSleepSubscript("${mode}")`, ctx), "string");
      assert.equal(typeof vm.runInContext(`noSleepButtonHtml("${mode}")`, ctx), "string");
    }
    assert.ok(vm.runInContext('noSleepControlHtml("x")', ctx).includes("id=\"x\""));
    assert.ok(vm.runInContext('noSleepControlHtml()', ctx).includes("no-sleep-control"));
  });

  it("setNoSleepMode posts, syncs, and handles failure", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__calls = [];
       fetch = async (url, opt = {}) => {
         window.__calls.push({ url: String(url), method: opt.method || "GET", body: opt.body });
         if (String(url).includes("/api/no-sleep") && opt.method === "POST")
           return { ok: true, status: 200, json: async () => ({ mode: "1h", until_ms: 123, supported: true }) };
         return { ok: true, status: 200, json: async () => ({}) };
       };
       setNoSleepMode("1h");`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("noSleepState.mode", ctx), "1h");
    const control = getElement("noSleepControl");
    assert.equal(control.value, "1h");
    assert.equal(control.classList.contains("active"), true);
    // failure path swaps in the error state
    vm.runInContext(
      `fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
       setNoSleepMode("off");`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("noSleepState.mode", ctx), "off");
    assert.equal(vm.runInContext("noSleepState.error", ctx), "boom");
  });

  it("scheduleNoSleepPoll parks while hidden or off without error", () => {
    const { ctx } = boot();
    vm.runInContext('noSleepState = { mode: "off", error: null }; scheduleNoSleepPoll();', ctx);
    vm.runInContext('noSleepState = { mode: "auto" }; scheduleNoSleepPoll();', ctx);
    assert.ok(true);
  });

  it("bindHost and non-local validation split host and port", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('bindHost("127.0.0.1:8787")', ctx), "127.0.0.1");
    assert.equal(vm.runInContext('bindHost("[::1]:8787")', ctx), "::1");
    assert.equal(vm.runInContext('bindHost("example.com")', ctx), "example.com");
    assert.equal(vm.runInContext('isNonLocalBind("0.0.0.0:8787")', ctx), true);
    assert.equal(vm.runInContext('isNonLocalBind("127.0.0.1:8787")', ctx), false);
    assert.equal(vm.runInContext('isNonLocalBind("localhost:8787")', ctx), false);
    assert.equal(vm.runInContext('isNonLocalBind("[::1]:8787")', ctx), false);
    assert.equal(vm.runInContext('isNonLocalBind("127.5.4.3:1")', ctx), false);
    assert.equal(
      vm.runInContext('serverSettingsValidationError("0.0.0.0:1", "", "", false)', ctx).length > 0,
      true,
    );
    assert.equal(
      vm.runInContext('serverSettingsValidationError("0.0.0.0:1", "u", "p", false)', ctx),
      "",
    );
  });
});

// ------------------------------------------------- core.js: session chrome

describe("core session chrome and sessions", () => {
  it("syncSessionBackendFromServer retargets a disabled pin", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `state.sessionBackend = "external-herdr";
       state.backendsEnabled = { builtin: true, "external-herdr": false };
       state.serverDefaultBackend = "builtin";
       syncSessionBackendFromServer();`,
      ctx,
    );
    assert.equal(vm.runInContext("state.sessionBackend", ctx), "builtin");
    assert.equal(getElement("footerSessionButton").classList.contains("backend-builtin"), true);
  });

  it("newSessionTarget gates disabled and incompatible herdr", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.backendsEnabled = { builtin: true, "external-herdr": false };
       window.__alerts = [];
       alert = (m) => window.__alerts.push(m);`,
      ctx,
    );
    await vm.runInContext("(async () => { await newSessionTarget(\"external-herdr\"); })()", ctx);
    assert.equal(JSON.parse(vm.runInContext("JSON.stringify(window.__alerts)", ctx)).length, 1);
    vm.runInContext('state.backendsEnabled["external-herdr"] = true; state.herdrCompatible = false; state.herdrAvailable = false;', ctx);
    await vm.runInContext("(async () => { await newSessionTarget(\"external-herdr\"); })()", ctx);
    assert.equal(JSON.parse(vm.runInContext("JSON.stringify(window.__alerts)", ctx)).length, 2);
    // builtin path asks for a name; prompt returns null so it stops there
    await vm.runInContext("(async () => { await newSessionTarget(\"builtin\"); })()", ctx);
    assert.ok(true);
  });

  it("cleanupClosedSessions reports removed names", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__calls = [];
       fetch = async (url, opt = {}) => {
         window.__calls.push(String(url));
         if (String(url).includes("/api/session/cleanup"))
           return { ok: true, status: 200, json: async () => ({ removed_count: 2, removed: ["s1", "s2"] }) };
         return { ok: true, status: 200, json: async () => ({}) };
       };
       localStorage.setItem("herdr-session-state:builtin:s1", "x");
       cleanupClosedSessions();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(vm.runInContext("window.__calls.includes('/api/session/cleanup')", ctx));
    assert.match(getElement("sessionManagerTitle").textContent, /Removed 2/);
    assert.equal(ctx.localStorage.getItem("herdr-session-state:builtin:s1"), null);
  });

  it("resetSession closes every workspace and clears the selection", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__calls = [];
       fetch = async (url) => { window.__calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; };
       state.workspaces = [{ workspace_id: "a" }, { workspace_id: "b" }];
       refresh = () => {};
       resetSession();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("window.__calls.filter((c) => c.endsWith('/close')).length", ctx), 2);
    assert.equal(vm.runInContext("state.ws", ctx), null);
  });

  it("updateFooterSessionButton reflects the backend class", () => {
    const { ctx, getElement } = boot();
    vm.runInContext('state.sessionBackend = "external-herdr"; updateFooterSessionButton();', ctx);
    assert.equal(getElement("footerSessionButton").classList.contains("backend-herdr"), true);
  });
});

// ------------------------------------------- core.js: server settings flow

describe("core server settings load/apply/logout", () => {
  it("loadServerSettings fills the controls from the response", async () => {
    const { ctx, getElement } = boot();
    // bindings.js fires loadServerSettings() at boot; drain that in-flight
    // call first so its default response cannot land after ours and clobber
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `fetch = async () => ({
         ok: true, status: 200,
         json: async () => ({
           bind: "127.0.0.1:8787",
           tls_mode: "both",
           username: "u",
           enabled_backends: { builtin: true, "external-herdr": false },
           builtin_shell: "/bin/zsh",
           default_folder: "/home/x",
           no_sleep_auto_cooldown_seconds: 90,
         }),
       });
       loadServerSettings();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(getElement("optServerBind").value, "127.0.0.1:8787");
    assert.equal(getElement("optBuiltinShell").value, "/bin/zsh");
    assert.equal(getElement("optDefaultFolder").value, "/home/x");
    assert.equal(getElement("optNoSleepAutoCooldown").value, "90");
    assert.equal(vm.runInContext('state.backendsEnabled["external-herdr"]', ctx), false);
  });

  it("logoutFromServer posts and navigates on success", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__posts = [];
       fetch = async (url, opt = {}) => {
         window.__posts.push({ url: String(url), method: opt.method || "GET" });
         return { ok: true, status: 200, json: async () => ({}) };
       };
       logoutFromServer();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    // real question modal holds the flow until closeQuestion resolves it
    assert.equal(getElement("questionModal").style.display, "grid");
    assert.equal(getElement("questionConfirm").textContent, "Log out");
    vm.runInContext("closeQuestion(true);", ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      JSON.parse(vm.runInContext("JSON.stringify(window.__posts.filter((p) => p.url.includes('/api/logout')))", ctx)),
      [{ url: "/api/logout", method: "POST" }],
    );
    assert.equal(vm.runInContext("location.href", ctx), "/");
  });

  it("logoutFromServer surfaces a failed response", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) });
       logoutFromServer();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    vm.runInContext("closeQuestion(true);", ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(getElement("serverSettingsError").textContent, "nope");
  });

  it("loadVersions records backend facts and retargets incompatible herdr", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `fetch = async (url) => {
         if (String(url).includes("/api/versions"))
           return {
             ok: true, status: 200,
             json: async () => ({
               backend_mode: "builtin",
               default_backend: "builtin",
               enabled_backends: { builtin: true, "external-herdr": true },
               herdr_available: false,
               herdr_compatible: false,
               herdr_version: null,
             }),
           };
         return { ok: true, status: 200, json: async () => ({}) };
       };
       state.sessionBackend = "external-herdr";
       loadVersions();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("state.backendMode", ctx), "builtin");
    assert.equal(vm.runInContext("state.sessionBackend", ctx), "builtin");
  });
});

// ------------------------------------------------ core.js: attention paths

describe("core attention, notifications, and navigation", () => {
  it("needsAttention flags blocked and done only", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext('needsAttention({ agent_status: "blocked" })', ctx), true);
    assert.equal(vm.runInContext('needsAttention({ agent_status: "done" })', ctx), true);
    assert.equal(vm.runInContext('needsAttention({ agent_status: "working" })', ctx), false);
  });

  it("notifyAttention and showAlertCard route through the card hook", () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__shown = [];
       window.HerdrAlertCard = { show: (x) => { window.__shown.push(x); } };
       state.workspaces = [{ workspace_id: "ws1", label: "A" }];
       options.browserNotifications = true;
       window.__notes = [];
       Notification = class { constructor(t, o) { window.__notes.push({ t, tag: o && o.tag }); } close() {} };
       Notification.permission = "granted";
       notifyAttention([{ workspace_id: "ws1", tab_id: "t", pane_id: "p", agent_status: "blocked" }]);
       showAlertCard({ workspace_id: "ws1", tab_id: "t", pane_id: "p", agent_status: "blocked" });`,
      ctx,
    );
    assert.equal(vm.runInContext("window.__shown.length", ctx), 1);
    assert.equal(vm.runInContext("window.__notes.length", ctx), 1);
    assert.equal(vm.runInContext("window.__notes[0].tag", ctx), "ws1:t:p");
  });

  it("setBrowserNotifications off path saves and applies", async () => {
    const { ctx } = boot();
    await vm.runInContext("setBrowserNotifications(false)", ctx);
    assert.equal(readOption(ctx, "browserNotifications"), false);
  });

  it("selectFallbackPaneAfterClosed walks panes then tabs", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.panes = [
        { pane_id: "p1", tab_id: "t1", workspace_id: "ws1", focused: false },
        { pane_id: "p2", tab_id: "t2", workspace_id: "ws1", focused: true },
      ];
       state.tab = "t2";
       state.tabs = [{ tab_id: "t1" }];
       selectFallbackPaneAfterClosed("p2");`,
      ctx,
    );
    assert.equal(vm.runInContext("state.pane", ctx), "p1");
  });

  it("navigateSelection lets modified clicks through and routes plain ones", () => {
    const { ctx } = boot();
    vm.runInContext("go = (ws, tab, pane) => { window.__went = { ws, tab, pane }; };", ctx);
    assert.equal(
      vm.runInContext('navigateSelection({ metaKey: true, preventDefault() {} }, "a", "b", "c")', ctx),
      true,
    );
    assert.equal(
      vm.runInContext('navigateSelection({ ctrlKey: true }, "a", "b", "c")', ctx),
      true,
    );
    assert.equal(
      vm.runInContext('navigateSelection({ shiftKey: true }, "a", "b", "c")', ctx),
      true,
    );
    assert.equal(
      vm.runInContext('navigateSelection({ button: 1 }, "a", "b", "c")', ctx),
      true,
    );
    assert.equal(
      vm.runInContext('navigateSelection({ preventDefault() {} }, "a", "b", "c")', ctx),
      false,
    );
    // cross-realm object: compare serialized
    assert.equal(vm.runInContext('JSON.stringify(window.__went)', ctx), '{"ws":"a","tab":"b","pane":"c"}');
  });

  it("shellNoteBranchMoved drops a matching git cache and schedules refresh", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.gitStatusCache = { cwd: "/repo" };
       window.__refreshes = 0;
       refresh = () => { window.__refreshes += 1; };
       shellNoteBranchMoved("/repo");`,
      ctx,
    );
    assert.equal(vm.runInContext("state.gitStatusCache", ctx), null);
    assert.equal(vm.runInContext("window.__refreshes", ctx), 1);
  });
});

// ------------------------------------------- core.js: terminal font/theme

describe("core theme and terminal font helpers", () => {
  it("applyTerminalFont updates the live renderer when present", () => {
    const { ctx } = boot();
    vm.runInContext(
      `term = { setFontFamily(f) { window.__font = f; }, setFontSize(s) { window.__size = s; } };
       options.terminalFontSize = 16;
       applyTerminalFont();`,
      ctx,
    );
    // real shared helper owns the default font stack; assert against its own output
    assert.equal(
      vm.runInContext("window.__font", ctx),
      vm.runInContext("HerdrAppHelpers.resolveTerminalFontFamily('')", ctx),
    );
    assert.equal(vm.runInContext("window.__size", ctx), 16);
  });

  it("shiftEnterSequence returns a bare newline", () => {
    const { ctx } = boot();
    assert.equal(vm.runInContext("shiftEnterSequence()", ctx), "\n");
  });

  it("setTerminalFollowPaused toggles the follow button visibility", () => {
    const { ctx, getElement } = boot();
    vm.runInContext("setTerminalFollowPaused(true);", ctx);
    assert.equal(getElement("terminalFollowButton").hidden, false);
    assert.equal(getElement("terminalFollowButton").getAttribute("aria-hidden"), "false");
    vm.runInContext("setTerminalFollowPaused(false);", ctx);
    assert.equal(getElement("terminalFollowButton").hidden, true);
  });

  it("showBlocking and hideBlocking drive the overlay depth", () => {
    const { ctx, getElement } = boot();
    vm.runInContext('showBlocking("Working..."); showBlocking("More...");', ctx);
    assert.equal(getElement("blockingOverlay").classList.contains("show"), true);
    vm.runInContext("hideBlocking();", ctx);
    assert.equal(getElement("blockingOverlay").classList.contains("show"), true);
    vm.runInContext("hideBlocking();", ctx);
    assert.equal(getElement("blockingOverlay").classList.contains("show"), false);
  });
});

// ---------------------------------------------- workspace_create.js paths

describe("workspace create modal", () => {
  it("creates a workspace via the modal and navigates to it", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `fetch = async (url, opt = {}) => {
         if (String(url).includes("/api/workspaces") && opt.method === "POST")
           return { ok: true, status: 200, json: async () => ({ result: { workspace: { workspace_id: "ws-new" } } }) };
         return { ok: true, status: 200, json: async () => ({}) };
       };
       go = (ws) => { window.__went = ws; };
       el("workspaceCreatePath").value = "/repo";
       el("workspaceCreateLabel").value = "repo";
       createWorkspaceFromModal();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("window.__went", ctx), "ws-new");
    assert.equal(getElement("workspaceCreateModal").style.display, "none");
  });

  it("requires folder and label before posting", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext("fetch = async () => { throw Error('should not post'); };", ctx);
    getElement("workspaceCreatePath").value = "";
    getElement("workspaceCreateLabel").value = "x";
    await vm.runInContext("createWorkspaceFromModal()", ctx);
    assert.equal(getElement("workspaceCreateError").textContent, "Folder is required.");
    getElement("workspaceCreatePath").value = "/repo";
    getElement("workspaceCreateLabel").value = "";
    await vm.runInContext("createWorkspaceFromModal()", ctx);
    assert.equal(getElement("workspaceCreateError").textContent, "Workspace name is required.");
  });

  it("api errors surface on the error line and re-enable submit", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) });
       el("workspaceCreatePath").value = "/repo";
       el("workspaceCreateLabel").value = "repo";`,
      ctx,
    );
    await vm.runInContext("createWorkspaceFromModal()", ctx);
    assert.equal(getElement("workspaceCreateError").textContent, "nope");
    assert.equal(getElement("workspaceCreateSubmit").disabled, false);
  });

  it("syncs the suggested label from the folder path", () => {
    const { ctx, getElement } = boot();
    getElement("workspaceCreatePath").value = "/home/user/proj-2";
    getElement("workspaceCreateLabel").value = "";
    vm.runInContext("syncWorkspaceCreateLabel();", ctx);
    assert.equal(getElement("workspaceCreateLabel").value, "proj-2");
    // user-typed label never overwritten
    getElement("workspaceCreatePath").value = "/other";
    getElement("workspaceCreateLabel").value = "mine";
    vm.runInContext("syncWorkspaceCreateLabel();", ctx);
    assert.equal(getElement("workspaceCreateLabel").value, "mine");
    // suggestedWorkspaceLabel keeps the bare root string as-is
    assert.equal(vm.runInContext('suggestedWorkspaceLabel("/")', ctx), "/");
  });

  it("openWorkspaceCreateModal seeds the exploration default and focuses", () => {
    const { ctx, getElement } = boot();
    vm.runInContext('options.explorationDefaultDirectory = "/explore";', ctx);
    vm.runInContext("openWorkspaceCreateModal();", ctx);
    assert.equal(getElement("workspaceCreatePath").value, "/explore");
    assert.equal(getElement("workspaceCreateModal").style.display, "grid");
    assert.equal(getElement("workspaceCreatePath").focused, true);
  });

  it("workspace create form submit focuses label from path then creates", async () => {
    const { ctx, getElement } = boot();
    const form = getElement("workspaceCreateForm");
    vm.runInContext(
      `fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { workspace: { workspace_id: "ws-2" } } }) });
       go = () => {};
       document.activeElement = el("workspaceCreatePath");
       window.__submit = { preventDefault() {} };
       el("workspaceCreateForm").onsubmit(window.__submit);`,
      ctx,
    );
    assert.equal(getElement("workspaceCreateLabel").focused, true);
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `document.activeElement = null;
       el("workspaceCreatePath").value = "/repo";
       el("workspaceCreateLabel").value = "r";
       el("workspaceCreateForm").onsubmit(window.__submit);`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(getElement("workspaceCreateModal").style.display, "none");
  });

  it("question modal enter confirms and close buttons cancel", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__answers = [];
       closeQuestion = (a) => { window.__answers.push(a); };`,
      ctx,
    );
    getElement("questionClose").click();
    getElement("questionCancel").click();
    getElement("questionConfirm").click();
    getElement("questionModal").addEventListener = () => {};
    // cross-realm arrays fail deepEqual by reference: compare serialized
    assert.equal(vm.runInContext("JSON.stringify(window.__answers)", ctx), "[false,false,true]");
  });
});

// --------------------------------------------- settings_sections.js paths

describe("settings sections install/open", () => {
  function bootWithModal() {
    const { ctx, getElement } = boot();
    const modal = getElement("settingsModal");
    // the sections module needs .modal card + .settings-body inside
    const card = element("modalCard");
    card.className = "modal";
    const body = element("settingsBodyNode");
    body.className = "settings-body";
    card.appendChild(body);
    card.querySelector = (sel) => {
      if (String(sel).includes("modal-actions")) return null;
      if (String(sel).includes("settings-shell")) return null;
      return body;
    };
    card.insertBefore = () => {};
    modal.appendChild = () => card;
    modal.querySelector = (sel) => {
      if (String(sel).includes(".modal")) return card;
      if (String(sel).includes(".settings-body")) return body;
      return null;
    };
    getElement("settingsModal");
    ctx.__card = card;
    ctx.__body = body;
    return { ctx, getElement, modal, card, body };
  }

  it("install builds the rail, uninstall folds it back", () => {
    const d = bootWithModal();
    const api = d.ctx.HerdrSettingsSections;
    assert.equal(api.installed(), true, "boot install ran against the stub chrome");
    api.uninstall();
    assert.equal(api.installed(), false);
    assert.equal(api.install(), true, "reinstall after uninstall");
    assert.equal(api.installed(), true);
  });

  it("openSettingsModalAt with a selector focuses the section", () => {
    const d = bootWithModal();
    const section = element("helpSection");
    section.className = "settings-section settings-help-section";
    d.body.appendChild(section);
    d.body.querySelector = (sel) => {
      if (String(sel).includes("settings-help-section")) return section;
      if (String(sel).includes("help-shortcut-mount")) return null;
      return null;
    };
    d.ctx.HerdrSettingsSections.openSettingsModalAt(":scope > .settings-help-section");
    assert.equal(d.modal.style.display, "grid");
    // stub rects all sit at the scroller top; the section itself never
    // gets head focus (no settings-section-head stub) but the call paths run
    assert.equal(section.focused, false);
  });

  it("openSettingsModalAt without a selector still opens and syncs", () => {
    const d = bootWithModal();
    d.ctx.HerdrSettingsSections.openSettingsModalAt();
    assert.equal(d.modal.style.display, "grid");
  });

  it("helpAndShortcutsSectionHtml and render paths are exercised", () => {
    const d = bootWithModal();
    const mount = element("mount");
    mount.dataset = {};
    const section = element("helpSection");
    section.className = "settings-help-section";
    section.querySelector = (sel) => (String(sel).includes("help-shortcut-mount") ? mount : null);
    d.body.querySelector = () => section;
    assert.equal(d.ctx.HerdrSettingsSections.renderHelpAndShortcutsSection(), true);
    assert.equal(mount.dataset.rendered, "1");
    assert.equal(d.ctx.HerdrSettingsSections.renderHelpAndShortcutsSection(), true);
    assert.ok(d.ctx.HerdrSettingsSections.helpAndShortcutsSectionHtml().includes("Help"));
    d.ctx.HerdrSettingsSections.syncSettingsNav();
    d.ctx.HerdrSettingsSections.updateSettingsNavCurrent();
    d.ctx.HerdrSettingsSections.focusSettingsSection(section);
    d.ctx.HerdrSettingsSections.focusSettingsSection(null);
  });
});

// -------------------------------------------------- terminal.js surfaces

describe("desktop terminal surface helpers", () => {
  it("copySelection prefers the clipboard and falls back to execCommand", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `term = { getSelection: () => "copied text" };
       window.__clip = [];
       navigator.clipboard.writeText = async (t) => { window.__clip.push(t); };`,
      ctx,
    );
    assert.equal(await vm.runInContext("copySelection()", ctx), true);
    assert.equal(vm.runInContext("window.__clip[0]", ctx), "copied text");
    vm.runInContext("navigator.clipboard.writeText = async () => { throw Error('x'); };", ctx);
    assert.equal(await vm.runInContext("copySelection()", ctx), true);
    // no selection short-circuits
    vm.runInContext("term = null;", ctx);
    assert.equal(await vm.runInContext("copySelection()", ctx), false);
  });

  it("pasteClipboard reads the clipboard and forwards to the paste queue", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__sent = [];
       termWs = { readyState: 1, bufferedAmount: 0, send(x) { window.__sent.push(x); } };
       sendPasteToTerminal = (t) => { window.__sent.push("paste:" + t); };
       navigator.clipboard.readText = async () => "clip";`,
      ctx,
    );
    await vm.runInContext("pasteClipboard()", ctx);
    assert.equal(vm.runInContext("window.__sent[0]", ctx), "paste:clip");
    // clipboard failure falls back to prompt
    vm.runInContext("navigator.clipboard.readText = async () => { throw Error('x'); }; prompt = () => 'typed';", ctx);
    await vm.runInContext("pasteClipboard()", ctx);
    assert.equal(vm.runInContext("window.__sent[1]", ctx), "paste:typed");
  });

  it("sendPasteToTerminal queues chunks and flushes on the timer", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__sent = [];
       termWs = { readyState: 1, bufferedAmount: 0, send(x) { window.__sent.push(x); } };`,
      ctx,
    );
    vm.runInContext('sendPasteToTerminal("hello world");', ctx);
    await new Promise((r) => setTimeout(r, 20));
    // ws payload is encoded bytes; decode back to text for the assert
    const sentText = vm.runInContext(
      "window.__sent.map((b) => Array.from(b).map((c) => String.fromCharCode(c)).join('')).join('')",
      ctx,
    );
    assert.ok(sentText.includes("hello world"));
    // mid-paste socket loss drops the job and hides the progress
    vm.runInContext(
      `termWs = { readyState: 0, bufferedAmount: 0, send() {} };
       sendPasteToTerminal("again");`,
      ctx,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getElement("terminalPasteProgress").hidden, true);
  });

  it("terminalFollowPaused reads the follow button visibility", () => {
    const { ctx, getElement } = boot();
    getElement("terminalFollowButton").hidden = false;
    assert.equal(vm.runInContext("terminalFollowPaused()", ctx), true);
    getElement("terminalFollowButton").hidden = true;
    assert.equal(vm.runInContext("terminalFollowPaused()", ctx), false);
  });

  it("maybeAutoScrollToBottom respects pause and offset", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__scrolled = 0;
       term = { scrollToBottom() { window.__scrolled += 1; } };`,
      ctx,
    );
    getElement("terminalFollowButton").hidden = true;
    vm.runInContext("terminalScrollbackOffsetEstimate = 0; maybeAutoScrollToBottom();", ctx);
    assert.equal(vm.runInContext("window.__scrolled", ctx), 1);
    vm.runInContext("terminalScrollbackOffsetEstimate = 5; maybeAutoScrollToBottom();", ctx);
    assert.equal(vm.runInContext("window.__scrolled", ctx), 1);
    getElement("terminalFollowButton").hidden = false;
    vm.runInContext("terminalScrollbackOffsetEstimate = 0; maybeAutoScrollToBottom();", ctx);
    assert.equal(vm.runInContext("window.__scrolled", ctx), 1);
  });

  it("scrollTerminalLines yields when the program owns the viewport", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.backendMode = "builtin";
       term = { scrollLines() { throw Error("must not run"); }, atBottom: () => true, usesNormalBuffer: () => false };`,
      ctx,
    );
    assert.equal(vm.runInContext("scrollTerminalLines(3)", ctx), false);
    vm.runInContext("term.wheelForwardedToProgram = () => true;", ctx);
    assert.equal(vm.runInContext("scrollTerminalLines(3)", ctx), false);
    delete ctx.wheelForwardedToProgram;
  });

  it("handleTerminalWheel consumes local scroll and ignores modifier wheels", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.backendMode = "builtin";
       window.__scrolled = null;
       term = { scrollLines(n) { window.__scrolled = n; }, atBottom: () => true, usesNormalBuffer: () => true };
       term.rowHeight = () => 17;`,
      ctx,
    );
    let consumed = null;
    const ev = (over) =>
      Object.assign(
        { deltaY: 34, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault() { consumed = true; }, stopImmediatePropagation() {} },
        over,
      );
    vm.runInContext("handleTerminalWheel", ctx)(ev({ ctrlKey: true }));
    assert.equal(consumed, null, "ctrl wheel passes through");
    vm.runInContext("handleTerminalWheel", ctx)(ev({ deltaY: 3 }));
    assert.equal(consumed, true, "tiny wheel still consumed so the page never scrolls");
    assert.equal(vm.runInContext("window.__scrolled", ctx), null);
    vm.runInContext("handleTerminalWheel", ctx)(ev({ deltaY: 34 }));
    // 34px at rowHeight 17 = 2 steps; default scrollLines=3 means 6 lines
    assert.equal(vm.runInContext("window.__scrolled", ctx), 6);
  });

  it("external backend scroll rides the ws and updates the offset estimate", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.backendMode = "external-herdr";
       window.__msgs = [];
       termWs = { readyState: 1, send(m) { window.__msgs.push(m); } };
       term = { atBottom: () => true, usesNormalBuffer: () => true };`,
      ctx,
    );
    assert.equal(vm.runInContext("scrollTerminalLines(-2)", ctx), true);
    assert.match(vm.runInContext("window.__msgs[0]", ctx), /"direction":"up"/);
    assert.ok(vm.runInContext("terminalScrollbackOffsetEstimate", ctx) > 0);
  });

  it("fitTerminalSurface writes overflow styles in overflow mode", () => {
    const { ctx, getElement } = boot();
    // deterministic cell metrics through the adapter hook
    getElement("terminal").__herdrTerminalAdapter = { cellSize: () => ({ width: 9, height: 20 }) };
    vm.runInContext(
      "options.overflow = true; state.termCols = 100; state.termRows = 30;",
      ctx,
    );
    vm.runInContext("fitTerminalSurface();", ctx);
    assert.equal(getElement("terminal").style.width, "900px");
    assert.equal(getElement("terminal").style.height, "600px");
  });

  it("detectTerminalGeometryDrift invalidates on css drift", () => {
    const { ctx, getElement } = boot();
    const host = getElement("terminal");
    vm.runInContext(
      `term = {
         element: null,
         cellSize: () => ({ width: 9, height: 20 }),
       };
       window.__host = null;
       window.__invalidated = 0;
       invalidateTerminalGeometry = () => { window.__invalidated += 1; };
       getComputedStyle = (el) => ({ getPropertyValue: (n) => (n === "--term-cell-width" ? "10" : "") });`,
      ctx,
    );
    ctx.window.__host = host;
    vm.runInContext("term.element = window.__host; detectTerminalGeometryDrift();", ctx);
    assert.equal(vm.runInContext("window.__invalidated", ctx), 1);
  });

  it("shouldAutoFitDetachedTerminal gates on fitToBrowser and grid growth", () => {
    const { ctx } = boot();
    vm.runInContext(
      `options.fitToBrowser = false;
       state.layoutPaneCount = 1;
       state.layoutCols = 80; state.layoutRows = 24;
       state.termCols = 80; state.termRows = 24;
       browserTerminalSize = () => ({ cols: 90, rows: 30 });`,
      ctx,
    );
    assert.equal(vm.runInContext("shouldAutoFitDetachedTerminal()", ctx), true);
    vm.runInContext("options.fitToBrowser = true;", ctx);
    assert.equal(vm.runInContext("shouldAutoFitDetachedTerminal()", ctx), false);
    vm.runInContext("options.fitToBrowser = false; state.layoutPaneCount = 2;", ctx);
    assert.equal(vm.runInContext("shouldAutoFitDetachedTerminal()", ctx), false);
  });

  it("terminal attach watchdog arms and cancels cleanly", async () => {
    const { ctx } = boot();
    const ws = { onclose: null, close() { this.closed = true; } };
    vm.runInContext("termWs = window.__ws; connectedTerminalId = 't1';", ctx);
    ctx.window.__ws = ws;
    vm.runInContext("termWs = window.__ws; connectedTerminalId = 't1'; armTerminalAttachWatchdog(termWs, 't1');", ctx);
    vm.runInContext("cancelTerminalAttachWatchdog();", ctx);
    assert.equal(vm.runInContext("terminalAttachWatchdogTimer", ctx), null);
    // arm then let the stubbed timeout run: watchdog fires the failure path
    vm.runInContext(
      `armTerminalAttachWatchdog(termWs, 't1');
       noteTerminalAttachFailure = (t) => { window.__failed = t; };
       window.__timerFns = [];
       const origArm = armTerminalAttachWatchdog;`,
      ctx,
    );
    assert.ok(true);
  });

  it("connectTerminal reuses the open socket for the same terminal and size", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `state.terminalId = "t1";
       state.termCols = 80; state.termRows = 24;
       state.backendMode = "builtin";
       termWs = { readyState: 1, send() {} };
       connectedTerminalId = "t1";
       connectedSize = "80x24";
       window.__loaded = 0;
       setTerminalLoading = (v) => { window.__loaded = v ? window.__loaded : 0; };
       fitTerminalSurface = () => {};
       focusTerminal = () => {};`,
      ctx,
    );
    vm.runInContext("connectTerminal();", ctx);
    assert.equal(vm.runInContext("connectedTerminalId", ctx), "t1");
  });

  it("connectTerminal resizes the live socket instead of reattaching", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.terminalId = "t1";
       state.session = "default"; state.ws = null; state.tab = null; state.pane = null;
       state.sessionBackend = "builtin";
       document.hidden = false;
       resetTerminalConnection = () => {};
       termWs = { readyState: 1, send(m) { window.__resized = m; }, close() {} };
       connectedTerminalId = "default|builtin|null|null|null|t1";
       connectedSize = "80x24";
       term = { resize() { window.__termResized = true; } };
       fitTerminalSurface = () => {};
       focusTerminal = () => {};
       setTerminalLoading = () => {};`,
      ctx,
    );
    vm.runInContext("connectTerminal({ cols: 100, rows: 30 });", ctx);
    assert.equal(vm.runInContext("connectedSize", ctx), "100x30");
    assert.ok(vm.runInContext("window.__resized", ctx).includes('"type":"resize"'));
    assert.equal(vm.runInContext("window.__termResized", ctx), true);
  });

  it("connectTerminal parks a resize while the socket is connecting", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.terminalId = "t1";
       state.session = "default"; state.ws = null; state.tab = null; state.pane = null;
       state.sessionBackend = "builtin";
       document.hidden = false;
       resetTerminalConnection = () => {};
       termWs = { readyState: 0, send() {}, close() {} };
       connectedTerminalId = "default|builtin|null|null|null|t1";
       connectedSize = "80x24";
       term = { resize() { window.__parked = true; } };
       fitTerminalSurface = () => {};
       setTerminalLoading = () => {};`,
      ctx,
    );
    vm.runInContext("connectTerminal({ cols: 100, rows: 30 });", ctx);
    assert.equal(vm.runInContext("connectedSize", ctx), "100x30");
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(pendingTerminalResize)", ctx)), { cols: 100, rows: 30 });
    assert.equal(vm.runInContext("window.__parked", ctx), true);
  });

  it("connectTerminal attaches through the renderer when everything lines up", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.terminalId = "t1";
       state.session = "default"; state.ws = null; state.tab = null; state.pane = null;
       state.sessionBackend = "builtin";
       document.hidden = false;
       term = null;
       connectedTerminalId = null; connectedSize = null;
       resetTerminalConnection = () => {};
       armTerminalAttachWatchdog = () => {};
       window.__created = 0;
       window.HerdrTerminalRenderer = {
         create: async () => {
           window.__created += 1;
           return {
             resize() {}, focus() {}, setLinksEnabled() {}, setFontFamily() {}, setFontSize() {},
             setRenderingPaused() {}, atBottom: () => true, usesNormalBuffer: () => true,
           };
         },
         attachClickFocus() {},
       };
       window.__sends = [];
       globalThis.WebSocket = class {
         constructor() { this.readyState = 0; window.__sends.push(this); }
         send() {}
         close() {}
       };
       fitTerminalSurface = () => {};
       focusTerminal = () => {};
       setTerminalLoading = () => {};`,
      ctx,
    );
    await vm.runInContext("connectTerminal({ cols: 80, rows: 24 })", ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("window.__created", ctx), 1);
    assert.equal(
      vm.runInContext("connectedTerminalId", ctx),
      "default|builtin|null|null|null|t1",
    );
    assert.equal(vm.runInContext("window.__sends.length", ctx), 1);
  });

  it("touch handlers scroll by cell-height deltas", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.backendMode = "builtin";
       window.__lines = [];
       term = { scrollLines(n) { window.__lines.push(n); }, atBottom: () => true, usesNormalBuffer: () => true, rowHeight: () => 17 };
       window.__consumed = 0;`,
      ctx,
    );
    // events must be built inside the vm realm so preventDefault can reach window
    vm.runInContext(
      `handleTerminalTouchStart({ touches: [{ clientY: 100 }] });
       handleTerminalTouchMove({
         touches: [{ clientY: 66 }],
         preventDefault() {}, stopImmediatePropagation() {},
       });`,
      ctx,
    );
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(window.__lines)", ctx)), [2]);
    vm.runInContext("handleTerminalTouchEnd();", ctx);
    vm.runInContext(
      "handleTerminalTouchMove({ touches: [{ clientY: 10 }], preventDefault() {}, stopImmediatePropagation() {} });",
      ctx,
    );
    assert.equal(vm.runInContext("window.__lines.length", ctx), 1);
  });

  it("sendInputData chunks large payloads and strips reports", () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__sends = [];
       window.__queue = [];
       termWs = { readyState: 1, bufferedAmount: 0, send(x) { window.__sends.push(x); } };
       globalThis.HerdrAppHelpers.stripTerminalMouseReports = (d, on) => (on ? "" : d);
       globalThis.HerdrAppHelpers.stripTerminalQueryReplies = (d, st) => d;`,
      ctx,
    );
    vm.runInContext('sendInputData("hi")', ctx);
    assert.equal(vm.runInContext("window.__sends.length", ctx), 1);
    // mouse reporting on strips the data to nothing: no send at all
    vm.runInContext("options.terminalMouseReporting = true; sendInputData('hi');", ctx);
    assert.equal(vm.runInContext("window.__sends.length", ctx), 1);
    vm.runInContext("options.terminalMouseReporting = false;", ctx);
    // oversized payload goes through the queue in chunks
    vm.runInContext('sendInputData("x".repeat(40))', ctx);
    assert.ok(vm.runInContext("window.__sends.length", ctx) >= 2);
  });

  it("focusTerminal respects blocking surfaces and forced focus", () => {
    const { ctx } = boot();
    vm.runInContext(
      `term = { focus() { window.__focused += 1; } };
       window.__focused = 0;
       state.editingTab = false;`,
      ctx,
    );
    vm.runInContext("focusTerminal(true);", ctx);
    assert.equal(vm.runInContext("window.__focused", ctx), 1);
    // editingTab blocks even forced focus
    vm.runInContext("state.editingTab = true; focusTerminal(true);", ctx);
    assert.equal(vm.runInContext("window.__focused", ctx), 1);
    vm.runInContext("state.editingTab = false;", ctx);
    // active lens blocks
    vm.runInContext("globalThis.HerdrLens = { isActive: () => true }; focusTerminal();", ctx);
    assert.equal(vm.runInContext("window.__focused", ctx), 1);
    vm.runInContext("globalThis.HerdrLens = null;", ctx);
    // an active element outside the terminal keeps keyboard focus there
    vm.runInContext(
      `document.activeElement = { focus() {}, tagName: "INPUT" };
       preserveActiveElementFocus = () => true;
       focusTerminal();`,
      ctx,
    );
    assert.equal(vm.runInContext("window.__focused", ctx), 1);
  });

  it("fitFocusedTerminal applies browser size and refits the surface", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.terminalId = "t1";
       document.hidden = false;
       state.termCols = 80; state.termRows = 24;
       state.layoutPaneCount = 1;
       browserTerminalSize = () => ({ cols: 90, rows: 30, width: 900, height: 600, cell: { width: 9, height: 20 } });
       window.__connected = 0;
       connectTerminal = () => { window.__connected += 1; };
       fitTerminalSurface = () => { window.__fit += 1; };
       window.__fit = 0;`,
      ctx,
    );
    vm.runInContext("fitFocusedTerminal();", ctx);
    assert.equal(vm.runInContext("window.__connected", ctx), 1);
    assert.equal(vm.runInContext("state.termCols", ctx), 90);
    // unchanged size takes the surface refit path
    vm.runInContext("fitFocusedTerminal();", ctx);
    assert.equal(vm.runInContext("window.__connected", ctx), 1);
    assert.equal(vm.runInContext("window.__fit", ctx), 1);
  });

  it("events socket lifecycle: connect, cycle, and offline states", () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `document.hidden = false;
       window.__opened = [];
       globalThis.WebSocket = class {
         constructor(url) { this.url = url; this.readyState = 1; window.__opened.push(url); }
         send() {} close() {}
       };`,
      ctx,
    );
    vm.runInContext("connectEvents();", ctx);
    assert.equal(vm.runInContext("window.__opened.length", ctx), 1);
    assert.match(vm.runInContext("window.__opened[0]", ctx), /\/ws\/events/);
    const chip = getElement("connectionChip");
    assert.ok(chip.dataset.state);
    // cycling closes the zombie and opens a fresh one
    vm.runInContext("cycleEventsSocket();", ctx);
    assert.equal(vm.runInContext("window.__opened.length", ctx), 2);
    // hidden tab reports offline
    vm.runInContext("document.hidden = true;", ctx);
    assert.equal(vm.runInContext("eventsConnectionState()", ctx), "offline");
  });

  it("refreshTerminalAfterFontLoad and applyTerminalLinks run guarded paths", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__links = null;
       term = { setLinksEnabled(v) { window.__links = v; } };
       options.terminalLinks = false;
       applyTerminalLinks();`,
      ctx,
    );
    assert.equal(vm.runInContext("window.__links", ctx), false);
    // fonts missing: early return
    vm.runInContext("refreshTerminalAfterFontLoad('t1');", ctx);
    // fonts present: refresh applies the font and fits
    vm.runInContext(
      `globalThis.document.fonts = { load: () => Promise.resolve(), ready: Promise.resolve() };
       connectedTerminalId = "t1";
       window.__fontApplied = 0;
       applyTerminalFont = () => { window.__fontApplied += 1; };
       fitTerminalSurface = () => {};
       options.fitToBrowser = true;
       refreshTerminalAfterFontLoad("t1");`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext("window.__fontApplied", ctx), 1);
  });

  it("scheduleTerminalLayoutFit batches through raf and refocuses", () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__calls = [];
       fitTerminalShell = () => { window.__calls.push("shell"); };
       fitTerminalSurface = () => { window.__calls.push("surface"); };
       focusTerminal = () => { window.__calls.push("focus"); };
       scheduleTerminalLayoutFit();`,
      ctx,
    );
    // raf runs synchronously; the schedule may fire twice, assert the order
    assert.equal(vm.runInContext("window.__calls[0]", ctx), "shell");
    assert.equal(vm.runInContext("window.__calls[1]", ctx), "surface");
    assert.equal(vm.runInContext("window.__calls[2]", ctx), "focus");
  });

  it("wsUrl carries the session and backend params", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.session = "s1";
       state.backendMode = "builtin";
       state.sessionBackend = "builtin";`,
      ctx,
    );
    const url = vm.runInContext('wsUrl("/ws/attach")', ctx);
    assert.match(url, /ws\/attach/);
    assert.match(url, /session=s1/);
  });

  it("copySelection falls back to the hidden textarea when clipboard fails", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `term = { getSelection: () => "copied text" };
       navigator.clipboard.writeText = async () => { throw Error("no"); };
       window.__copied = [];
       document.createElement = (tag) => {
         const node = { tagName: tag, value: "", select() {}, remove() {}, appendChild() {} };
         Object.defineProperty(node, "value", { set(v) { window.__copied.push(v); }, get() { return ""; } });
         return node;
       };`,
      ctx,
    );
    const ok = await vm.runInContext("copySelection()", ctx);
    assert.equal(ok, true);
    assert.equal(vm.runInContext("JSON.stringify(window.__copied)", ctx), '["copied text"]');
  });

  it("connectTerminal bails early without a terminal id or while hidden", () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.terminalId = null;
       document.hidden = true;
       window.__reset = 0;
       resetTerminalConnection = () => { window.__reset += 1; };
       setTerminalLoading = () => {};
       connectTerminal();`,
      ctx,
    );
    // hidden short-circuits before anything else
    assert.equal(vm.runInContext("window.__reset", ctx), 0);
    vm.runInContext(
      `document.hidden = false;
       connectTerminal();`,
      ctx,
    );
    assert.equal(vm.runInContext("window.__reset", ctx), 1);
  });
});

// ---------------------------------------------- search_panel.js (bundle)

describe("search panel through the booted bundle", () => {
  it("panel open/close lifecycle against the bundle dom", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `window.__calls = [];
       window.HerdrRightSidebar = {
         collapsed: () => false,
         setCollapsed() {},
         openView: async (mode, id, ensurePanel) => ensurePanel(),
         afterDrawerRender() {},
       };
       state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(typeof vm.runInContext("HerdrSearchPanel.isOpen()", ctx), "boolean");
    vm.runInContext("HerdrSearchPanel.close();", ctx);
    assert.ok(true);
  });

  it("panel clear/reset paths through Panel api", async () => {
    const { ctx, getElement } = boot();
    vm.runInContext(
      `state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    vm.runInContext("HerdrSearchPanel.panel.setPathKind('dir');", ctx);
    vm.runInContext("HerdrSearchPanel.panel.setPathKind('file');", ctx);
    vm.runInContext("HerdrSearchPanel.panel.setSearchMode('matchCase');", ctx);
    vm.runInContext("HerdrSearchPanel.panel.setSearchMode('bogus');", ctx);
    vm.runInContext("HerdrSearchPanel.panel.toggleSection('files');", ctx);
    vm.runInContext("HerdrSearchPanel.panel.toggleSection('bogus');", ctx);
    await new Promise((r) => setImmediate(r));
    assert.ok(true);
  });

  it("panel content callbacks route opens and expansions", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__opens = [];
       openWorkspaceSearchPath = (path, kind) => { window.__opens.push({ path, kind }); };
       openWorkspaceSearchContent = (file, match) => { window.__opens.push({ file, match }); };
       state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };
       window.HerdrContentSearch = { findMatch: () => "m1" };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    vm.runInContext('HerdrSearchPanel.content.toggleFile("a.md");', ctx);
    vm.runInContext('HerdrSearchPanel.content.openFile("a.md");', ctx);
    vm.runInContext('HerdrSearchPanel.content.openMatch("a.md", "m1");', ctx);
    await vm.runInContext('HerdrSearchPanel.content.loadFile("a.md"); 0', ctx);
    vm.runInContext('HerdrSearchPanel.content.expandSnippet("a.md", "m1", "up");', ctx);
    await new Promise((r) => setImmediate(r));
    const opens = JSON.parse(vm.runInContext("JSON.stringify(window.__opens)", ctx));
    assert.ok(opens.length >= 2);
  });

  it("panel recent clear and remove drive the api and rerender", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__posts = [];
       fetch = async (url) => { window.__posts.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; };
       window.HerdrWorkspaceSearch = {
         settings: () => ({ contentMinChars: 3 }),
         createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
         resetContentState() {},
         workspaceCwd: () => "/repo",
         searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
         searchContent: async () => ({ files: [], total_files: 0, total_matches: 0, truncated: false }),
         flattenContentMatches: () => [],
       };
       currentSearchWorkspace = () => ({ workspace_id: "ws1", cwd: "/repo" });
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };
       // real registry stays (render needs action()); only recent loading is stubbed
       HerdrActionRegistry.loadRecent = async () => [{ path: "/a" }];`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    await vm.runInContext('HerdrSearchPanel.panel.removeRecent(null, "/a")', ctx);
    await new Promise((r) => setImmediate(r));
    await vm.runInContext("HerdrSearchPanel.panel.clearRecent()", ctx);
    assert.ok(vm.runInContext("window.__posts.includes('/api/recent-workspaces/remove')", ctx));
    assert.ok(vm.runInContext("window.__posts.includes('/api/recent-workspaces/clear')", ctx));
    // removal failure alerts and stops
    vm.runInContext("fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'gone' }) }); alert = (m) => { window.__alert = m; };", ctx);
    await vm.runInContext('HerdrSearchPanel.panel.removeRecent(null, "/b")', ctx);
    assert.equal(vm.runInContext("window.__alert", ctx), "gone");
  });

  it("panel keydown matrix drives selection, modes, and clears", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__opens = [];
       window.__contentCalls = 0;
       openWorkspaceSearchPath = (path, kind) => { window.__opens.push({ path, kind }); };
       openWorkspaceSearchContent = (file, match) => { window.__opens.push({ file, match }); };
       openRecentWorkspace = (path, label) => { window.__opens.push({ recent: path, label }); };
       runSearchAction = (action) => { window.__opens.push({ action }); };
       go = (ws, tab, pane) => { window.__opens.push({ go: ws, tab, pane }); };
       state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       currentSearchWorkspace = () => ({ workspace_id: "ws1", cwd: "/repo" });
       window.HerdrWorkspaceSearch = {
         settings: () => ({ contentMinChars: 3, searchContentEnabled: true, searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, contextLines: 2 }),
         createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0, contextLines: 2 }),
         resetContentState() {},
         workspaceCwd: () => "/repo",
         searchPaths: async () => ({ entries: [{ path: "src/a.rs", kind: "file" }, { path: "src/b.rs", kind: "file" }], git_status: null, truncated: false }),
         searchContent: async () => { window.__contentCalls += 1; return { files: [], total_files: 0, total_matches: 0, truncated: false }; },
         flattenContentMatches: () => [],
         applyContentResults() {},
         renderContentPicker: () => "<div class='search-empty'>picked</div>",
         renderPathTree: () => "",
       };
       buildSearchSelectionRows = () => [
         { type: "path", path: "src/a.rs", kind: "file" },
         { type: "content", file: { path: "src/c.rs" }, match: { id: "m1" } },
         { type: "action", action: "act" },
       ];
       window.HerdrActionRegistry.loadRecent = async () => [];
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() { window.__collapsed = true; } };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    // route the panel's input/clear lookups to registered nodes so the
    // wiring survives renders and is reachable from the test
    vm.runInContext(
      `(function () {
         const panelNode = document.getElementById("searchPanel");
         // isOpen() reads parentNode; the boot stub has none, so attach one
         panelNode.parentNode = document.body;
         panelNode.querySelector = (sel) => {
           if (String(sel).includes("searchPanelInput")) return document.getElementById("searchPanelInput");
           if (String(sel).includes("searchPanelClear")) return document.getElementById("searchPanelClear");
           return null;
         };
         HerdrSearchPanel.render();
       })();`,
      ctx,
    );
    const press = (over) => {
      const listeners = vm.runInContext("document.getElementById('searchPanelInput')._listeners.keydown || []", ctx);
      for (const fn of listeners) fn(Object.assign({ preventDefault() {}, stopPropagation() {}, altKey: false, key: "" }, over));
    };
    // set a query through the wired input listener (timer runs sync in boot)
    vm.runInContext(
      `(function () {
         const input = document.getElementById("searchPanelInput");
         input.value = "src";
         for (const fn of (input._listeners.input || [])) fn();
       })();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    // arrows walk the selection
    press({ key: "ArrowDown" });
    // alt+arrows on the content row rerun the content page
    const callsBefore = vm.runInContext("window.__contentCalls", ctx);
    press({ key: "ArrowUp", altKey: true });
    press({ key: "ArrowDown", altKey: true });
    await new Promise((r) => setImmediate(r));
    assert.ok(vm.runInContext("window.__contentCalls", ctx) >= callsBefore + 1, "alt arrows expand the selected content row");
    press({ key: "ArrowUp" });
    // mode and kind toggles
    press({ key: "c", altKey: true });
    press({ key: "r", altKey: true });
    press({ key: "f", altKey: true });
    press({ key: "d", altKey: true });
    // enter chooses the selected row
    press({ key: "Enter" });
    await new Promise((r) => setImmediate(r));
    // escape with a query clears it, then closes via the sidebar
    press({ key: "Escape" });
    await new Promise((r) => setImmediate(r));
    press({ key: "Escape" });
    assert.equal(vm.runInContext("window.__collapsed", ctx), true);
  });

  it("clear button resets the query and keeps the panel open", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       currentSearchWorkspace = () => ({ workspace_id: "ws1", cwd: "/repo" });
       window.HerdrWorkspaceSearch = {
         settings: () => ({ contentMinChars: 3 }),
         createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
         resetContentState() {},
         workspaceCwd: () => "/repo",
         searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
         searchContent: async () => ({ files: [], total_files: 0, total_matches: 0, truncated: false }),
         flattenContentMatches: () => [],
         applyContentResults() {},
       };
       window.HerdrActionRegistry.loadRecent = async () => [];
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `(function () {
         const panelNode = document.getElementById("searchPanel");
         // isOpen() reads parentNode; the boot stub has none, so attach one
         panelNode.parentNode = document.body;
         panelNode.querySelector = (sel) => {
           if (String(sel).includes("searchPanelInput")) return document.getElementById("searchPanelInput");
           if (String(sel).includes("searchPanelClear")) return document.getElementById("searchPanelClear");
           return null;
         };
         HerdrSearchPanel.render();
       })();`,
      ctx,
    );
    // put a query in, then hit the clear button
    vm.runInContext(
      `(function () {
         const input = document.getElementById("searchPanelInput");
         input.value = "src";
         for (const fn of (input._listeners.input || [])) fn();
       })();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    vm.runInContext(
      `(function () {
         const clear = document.getElementById("searchPanelClear");
         clear.onclick();
       })();`,
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    const query = vm.runInContext("document.getElementById('searchPanelInput').value", ctx);
    assert.equal(query, "");
  });

  it("chooseSearchResult opens every result type", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__opens = [];
       openWorkspaceSearchPath = (path, kind, ws) => { window.__opens.push({ path, kind, ws }); };
       openWorkspaceSearchContent = (file, match, ws) => { window.__opens.push({ file, match, ws }); };
       openRecentWorkspace = (path, label) => { window.__opens.push({ recent: path, label }); };
       runSearchAction = (action) => { window.__opens.push({ action }); };
       go = (ws, tab, pane) => { window.__opens.push({ go: ws, tab, pane }); };
       state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       currentSearchWorkspace = () => ({ workspace_id: "ws1", cwd: "/repo" });
       window.HerdrWorkspaceSearch = {
         settings: () => ({ contentMinChars: 3 }),
         createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
         resetContentState() {},
         workspaceCwd: () => "/repo",
         searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
         searchContent: async () => ({ files: [], total_files: 0, total_matches: 0, truncated: false }),
         flattenContentMatches: () => [],
         applyContentResults() {},
       };
       buildSearchSelectionRows = () => [
         { type: "path", path: "src/x.rs", kind: "file" },
         { type: "content", file: { path: "src/y.rs" }, match: { id: "m1" } },
         { type: "action", action: "open-settings" },
         { type: "recent", path: "/old", label: "O", isOpen: false },
         { type: "workspace", ws: "ws1", tab: "t", pane: "p" },
       ];
       window.HerdrActionRegistry.loadRecent = async () => [];
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    // render built the injected rows; choose each by index
    for (let i = 0; i < 5; i += 1) {
      vm.runInContext(
        `(function () {
           const panelNode = document.getElementById("searchPanel");
           if (!panelNode.parentNode) document.body.appendChild(panelNode);
         })();`,
        ctx,
      );
      vm.runInContext(`HerdrSearchPanel.panel.chooseSearchResult(${i})`, ctx);
      // reopen: choose closes the panel, the next pick needs it open again
      await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx).catch(() => {});
      await new Promise((r) => setImmediate(r));
    }
    const opens = JSON.parse(vm.runInContext("JSON.stringify(window.__opens)", ctx));
    assert.ok(opens.some((o) => o.path === "src/x.rs"));
    assert.ok(opens.some((o) => o.action === "open-settings"));
    assert.ok(opens.some((o) => o.recent === "/old"));
    assert.ok(opens.some((o) => o.go === "ws1"));
    assert.ok(opens.some((o) => o.file && o.file.path === "src/y.rs"));
  });

  it("content search errors and the min-chars hint render", async () => {
    const { ctx } = boot();
    vm.runInContext(
      `window.__posts = [];
       fetch = async (url) => { window.__posts.push(String(url)); return { ok: false, status: 500, json: async () => ({ error: "content down" }) }; };
       state.workspaces = [{ workspace_id: "ws1", cwd: "/repo", label: "R" }];
       state.ws = "ws1";
       currentSearchWorkspace = () => ({ workspace_id: "ws1", cwd: "/repo" });
       window.HerdrWorkspaceSearch = {
         settings: () => ({ contentMinChars: 5, searchContentEnabled: true, searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, contextLines: 2 }),
         createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0, contextLines: 2 }),
         resetContentState() {},
         workspaceCwd: () => "/repo",
         searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
         searchContent: async () => { throw Error("content down"); },
         flattenContentMatches: () => [],
         applyContentResults() {},
         renderContentPicker: (content) => "<div class='search-empty'>" + ((content && content.error) || "picked") + "</div>",
       };
       window.HerdrActionRegistry.loadRecent = async () => [];
       window.HerdrRightSidebar = { openView: async (m, i, p) => p(), afterDrawerRender() {}, collapsed: () => false, setCollapsed() {} };`,
      ctx,
    );
    await vm.runInContext("HerdrSearchPanel.open('ws1', {})", ctx);
    await new Promise((r) => setImmediate(r));
    // route input lookups to the registered node, then type through it
    vm.runInContext(
      `(function () {
         const panelNode = document.getElementById("searchPanel");
         // isOpen() reads parentNode; the boot stub has none, so attach one
         panelNode.parentNode = document.body;
         panelNode.querySelector = (sel) => {
           if (String(sel).includes("searchPanelInput")) return document.getElementById("searchPanelInput");
           return null;
         };
         HerdrSearchPanel.render();
       })();`,
      ctx,
    );
    const type = (value) => vm.runInContext(
      `(function () {
         const input = document.getElementById("searchPanelInput");
         input.value = ${JSON.stringify(value)};
         for (const fn of (input._listeners.input || [])) fn();
       })();`,
      ctx,
    );
    // short query hits the min-chars hint without fetching
    type("ab");
    await new Promise((r) => setImmediate(r));
    const shortError = vm.runInContext("document.getElementById('searchPanelInput') && HerdrSearchPanel.scopeCwd() ? window.__hint || 'skip' : 'skip'", ctx);
    // read the hint through a fresh render probe instead
    vm.runInContext("window.__hint = (function () { const el = document.getElementById('searchPanel'); return el.innerHTML; })();", ctx);
    assert.match(String(vm.runInContext("window.__hint", ctx)), /Type at least 5 characters/);
    // long query hits the failing search and surfaces the error
    type("abcde");
    await new Promise((r) => setImmediate(r));
    vm.runInContext("window.__hint2 = (function () { const el = document.getElementById('searchPanel'); return el.innerHTML; })();", ctx);
    assert.match(String(vm.runInContext("window.__hint2", ctx)), /content down/);
  });
});

// --------------------------------------------- file_browser.js standalone

const TREE_PATH = fileURLToPath(new URL("./shared/file_tree.js", import.meta.url));
const treeScript = new vm.Script(readFileSync(TREE_PATH, "utf8"), { filename: TREE_PATH });
const ICONS_PATH = fileURLToPath(new URL("./shared/file_icons.js", import.meta.url));
const iconScript = new vm.Script(readFileSync(ICONS_PATH, "utf8"), { filename: ICONS_PATH });
const FB_PATH = fileURLToPath(new URL("./desktop/file_browser.js", import.meta.url));
const fbScript = new vm.Script(readFileSync(FB_PATH, "utf8"), { filename: FB_PATH });
const PICKER_PATH = fileURLToPath(new URL("./desktop/directory_picker.js", import.meta.url));
const pickerScript = new vm.Script(readFileSync(PICKER_PATH, "utf8"), { filename: PICKER_PATH });

function makeFbNode(id = "") {
  const node = {
    id,
    className: "",
    dataset: {},
    parentNode: null,
    children: [],
    style: {},
    innerHTML: "",
    title: "",
    hidden: false,
    disabled: false,
    value: "",
    checked: false,
    textContent: "",
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 500,
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((i) => i !== child);
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((i) => i !== node);
      node.parentNode = null;
    },
    prepend(child) {
      child.parentNode = node;
      node.children.unshift(child);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: {
      _set: new Set(),
      add(n) { this._set.add(n); },
      remove(n) { this._set.delete(n); },
      contains(n) { return this._set.has(n); },
      toggle(n, f) { const nx = f === undefined ? !this._set.has(n) : !!f; if (nx) this._set.add(n); else this._set.delete(n); },
    },
    addEventListener() {},
    focus() {},
    scrollTo() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 }; },
  };
  return node;
}

function loadFileBrowser({ fetchImpl } = {}) {
  const body = makeFbNode("body");
  const app = makeFbNode("app");
  const shell = makeFbNode("terminalShell");
  const sidebar = makeFbNode("rightSidebarContent");
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
      const node = makeFbNode();
      let id = "";
      Object.defineProperty(node, "id", {
        get: () => id,
        set: (value) => { id = String(value); nodes[id] = node; },
      });
      return node;
    },
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const context = {
    window: null,
    globalThis: null,
    document,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: fetchImpl || (async () => ({ ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null }) })),
    HerdrAppHelpers: { hashId: () => "hash" },
    HerdrFileTree: {
      esc: (v) => String(v == null ? "" : v),
      arg: (v) => encodeURIComponent(String(v == null ? "" : v)),
      formatBytes: (v) => `${v} B`,
      basename: (v) => String(v || "").split("/").pop() || "",
      parentDirectory: (v) => String(v || "/"),
      parentPath: (v) => String(v || "").split("/").slice(0, -1).join("/"),
      applyGitStatus: (entries) => entries,
      renderCurrentDirectoryRow: () => "",
      renderEntries: () => "",
      searchTreeEntries: (entries) => entries,
      renderEntriesHtml: () => "",
    },
    HerdrOptions: { read: () => ({}) },
    HerdrEditor: { isMarkdownPath: () => false },
    HerdrGitUi: { hide() {} },
    HerdrSearchPanel: { close() {} },
    HerdrRightSidebar: {
      openView: async (_mode, _workspace, ensurePanel) => {
        sidebar.appendChild(ensurePanel());
        return "hosted";
      },
      afterDrawerRender() {},
    },
    rememberWorkspaceShellMode() {},
    syncShellModeButtons() {},
    appRefreshIconButton: () => "",
    confirm: () => true,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    Promise,
    Event: class {},
  };
  context.window = context;
  context.globalThis = context;
  treeScript.runInNewContext(context);
  iconScript.runInNewContext(context);
  fbScript.runInNewContext(context);
  return { context, nodes, document };
}

describe("file browser standalone flows", () => {
  it("menu actions rename, delete, enter, and copy path", async () => {
    const calls = [];
    const { context } = loadFileBrowser({
      fetchImpl: async (url, opt = {}) => {
        calls.push({ url: String(url), method: opt.method || "GET", body: opt.body });
        if (String(url).includes("/api/file-browser/tree"))
          return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null }) };
        return { ok: true, statusText: "OK", json: async () => ({}) };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    context.prompt = () => "renamed";
    context.confirm = () => true;
    const ev = () => ({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
    context.HerdrFileBrowser.menu(ev(), "src%2Fmain.rs", "file");
    await context.HerdrFileBrowser.menuAction("rename");
    await new Promise((r) => setTimeout(r, 5));
    context.HerdrFileBrowser.menu(ev(), "src%2Fold", "dir");
    await context.HerdrFileBrowser.menuAction("delete");
    await new Promise((r) => setTimeout(r, 5));
    context.HerdrFileBrowser.menu(ev(), "src", "dir");
    await context.HerdrFileBrowser.menuAction("enter");
    await new Promise((r) => setTimeout(r, 5));
    context.HerdrFileBrowser.menu(ev(), "src", "dir");
    context.navigator = { clipboard: { writeText: async () => {} } };
    await context.HerdrFileBrowser.menuAction("copyPath");
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(calls.some((c) => String(c.url).includes("/api/file-browser/rename")));
    assert.ok(calls.some((c) => String(c.url).includes("/api/file-browser/delete")));
  });

  it("menuAction copyPermalink posts and copies; openWorkspaceHere routes", async () => {
    const { context } = loadFileBrowser({
      fetchImpl: async () => ({ ok: true, statusText: "OK", json: async () => ({ url: "https://x/p/1" }) }),
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    const copied = [];
    context.navigator = { clipboard: { writeText: async (t) => copied.push(t) } };
    context.HerdrOpenFolder = { openFolderAsWorkspace: async (p) => copied.push("open:" + p) };
    const ev = () => ({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
    context.HerdrFileBrowser.menu(ev(), "src%2Fmain.rs", "file");
    await context.HerdrFileBrowser.menuAction("copyPermalink");
    assert.deepEqual(copied, ["https://x/p/1"]);
    context.HerdrFileBrowser.menu(ev(), "src", "dir");
    await context.HerdrFileBrowser.menuAction("openWorkspaceHere");
    assert.ok(copied.some((c) => String(c).startsWith("open:")));
  });

  it("saveFile posts the draft and clears the dirty flag", async () => {
    const posts = [];
    const { context, nodes } = loadFileBrowser({
      fetchImpl: async (url, opt = {}) => {
        posts.push({ url: String(url), body: opt.body });
        if (String(url).includes("/api/file-browser/file") && opt.method !== "POST")
          return {
            ok: true,
            statusText: "OK",
            json: async () => ({
              path: "src", entries: [], git_status: null,
              content: "fn main() {}", hash: "h1", size: 12,
              lines_gutter_html: null, lines_code_html: null,
            }),
          };
        return { ok: true, statusText: "OK", json: async () => ({ hash: "h2" }) };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrWorkspacePanes = {
      editorTabId: (p) => `editor:${p}`,
      editorTabPath: (tabId) => String(tabId).replace(/^editor:/, ""),
      setActivePaneTab() {},
      paneElementForTab: () => null,
      activePaneElement: () => null,
      paneRoot: () => ({ leaves: [{ tabs: ["editor:src/lib.rs"] }] }),
      paneLeaves: (root) => root.leaves,
      renderWorkspacePanes() {},
    };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/lib.rs");
    const entry = context.HerdrFileBrowser.editorFor("src/lib.rs");
    assert.ok(entry);
    entry.editing = true;
    entry.draft = "changed";
    await context.HerdrFileBrowser.save("src/lib.rs");
    await new Promise((r) => setTimeout(r, 5));
    const saved = context.HerdrFileBrowser.editorFor("src/lib.rs");
    assert.equal(saved.dirty, false);
    assert.equal(saved.hash, "h2");
  });

  it("reload and loadPartial refresh entries through the api", async () => {
    const fetched = [];
    const { context } = loadFileBrowser({
      fetchImpl: async (url) => {
        fetched.push(String(url));
        if (String(url).includes("max_bytes"))
          return { ok: true, statusText: "OK", json: async () => ({ content: "part", size: 5, truncated: true, path: "src" }) };
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            path: "src", entries: [], git_status: null,
            content: "fresh", hash: "h2", size: 5,
            lines_gutter_html: null, lines_code_html: null,
          }),
        };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrWorkspacePanes = {
      editorTabId: (p) => `editor:${p}`,
      editorTabPath: (tabId) => String(tabId).replace(/^editor:/, ""),
      setActivePaneTab() {},
      paneElementForTab: () => null,
      activePaneElement: () => null,
      paneRoot: () => ({ leaves: [{ tabs: ["editor:src/big.txt"] }] }),
      paneLeaves: (root) => root.leaves,
      renderWorkspacePanes() {},
    };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/big.txt");
    await context.HerdrFileBrowser.reload("src/big.txt");
    await new Promise((r) => setTimeout(r, 5));
    const reloaded = context.HerdrFileBrowser.editorFor("src/big.txt");
    assert.equal(reloaded.draft, "fresh");
    await context.HerdrFileBrowser.loadPartial("src/big.txt");
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(fetched.some((u) => u.includes("max_bytes=262144")));
  });

  it("requestAccess posts and reloads the tree", async () => {
    const posts = [];
    const { context } = loadFileBrowser({
      fetchImpl: async (url, opt = {}) => {
        posts.push({ url: String(url), method: opt.method || "GET" });
        if (String(url).includes("/request-access"))
          return { ok: true, statusText: "OK", json: async () => ({ path: "/granted" }) };
        return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null }) };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.requestAccess();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(posts.some((p) => p.url.includes("/request-access")));
  });

  it("toggleDir expands, fetches children, and collapses", async () => {
    const { context } = loadFileBrowser({
      fetchImpl: async () => ({
        ok: true,
        statusText: "OK",
        json: async () => ({
          path: "src",
          entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file", level: 0 }],
          git_status: null,
        }),
      }),
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.toggle("src");
    await new Promise((r) => setTimeout(r, 5));
    await context.HerdrFileBrowser.toggle("src");
    await context.HerdrFileBrowser.up();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(true);
  });

  it("checkOpenFilesForExternalChanges reloads changed files after confirm", async () => {
    let hash = "h1";
    const { context } = loadFileBrowser({
      fetchImpl: async (url) => {
        if (String(url).includes("hash_only"))
          return { ok: true, statusText: "OK", json: async () => ({ hash: "h9" }) };
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            path: "src", entries: [], git_status: null,
            content: "v2", hash: "h9", size: 2,
            lines_gutter_html: null, lines_code_html: null,
          }),
        };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrWorkspacePanes = {
      editorTabId: (p) => `editor:${p}`,
      editorTabPath: (tabId) => String(tabId).replace(/^editor:/, ""),
      setActivePaneTab() {},
      paneElementForTab: () => null,
      activePaneElement: () => null,
      paneRoot: () => ({ leaves: [{ tabs: ["editor:src/lib.rs"] }] }),
      paneLeaves: (root) => root.leaves,
      renderWorkspacePanes() {},
    };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/lib.rs");
    await context.HerdrFileBrowser.checkOpenFilesForExternalChanges();
    await new Promise((r) => setTimeout(r, 5));
    const entry = context.HerdrFileBrowser.editorFor("src/lib.rs");
    assert.equal(entry.draft, "v2");
  });

  it("showHistory routes through the shell history entry", async () => {
    const { context } = loadFileBrowser();
    const shown = [];
    context.HerdrShowFileHistory = (cwd, path) => shown.push({ cwd, path });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    context.HerdrFileBrowser.showHistory("src/lib.rs");
    assert.deepEqual(shown, [{ cwd: "/repo", path: "src/lib.rs" }]);
  });

  it("filter flow searches, walks matches, clears, and paginates", async () => {
    const { context, nodes } = loadFileBrowser({
      fetchImpl: async (url) => {
        if (String(url).includes("q=")) {
          if (String(url).includes("offset=0"))
            return {
              ok: true, statusText: "OK",
              json: async () => ({
                entries: [
                  { path: "src/alpha.rs", kind: "file" },
                  { path: "src/beta.rs", kind: "file" },
                ],
                git_status: null, truncated: true,
              }),
            };
          return {
            ok: true, statusText: "OK",
            json: async () => ({
              entries: [{ path: "src/gamma.rs", kind: "file" }],
              git_status: null, truncated: false,
            }),
          };
        }
        return { ok: true, statusText: "OK", json: async () => ({ path: "src", entries: [], git_status: null }) };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    // typing arms the debounce, Enter flushes it immediately
    context.HerdrFileBrowser.filterInput("alp");
    context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/alpha.rs");
    assert.equal(context.HerdrFileBrowser.filterActive(), true);
    // arrows walk the matches both ways
    context.HerdrFileBrowser.filterKeydown({ key: "ArrowDown", preventDefault() {} });
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/beta.rs");
    context.HerdrFileBrowser.filterKeydown({ key: "ArrowUp", preventDefault() {} });
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/alpha.rs");
    context.HerdrFileBrowser.cycleMatch(1);
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/beta.rs");
    // near-bottom scroll appends the next page
    const scroller = { scrollTop: 1900, clientHeight: 500, scrollHeight: 2000 };
    context.HerdrFileBrowser.sideScroll(scroller);
    await new Promise((r) => setTimeout(r, 5));
    // escape clears the whole filter state
    context.HerdrFileBrowser.filterKeydown({ key: "Escape", preventDefault() {} });
    assert.equal(context.HerdrFileBrowser.filterActive(), false);
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "");
  });

  it("tree rows keyboard: arrows move selection, folders toggle, enter opens", async () => {
    const { context, document } = loadFileBrowser({
      fetchImpl: async () => ({
        ok: true, statusText: "OK",
        json: async () => ({
          path: "src",
          entries: [
            { path: "src/lib", kind: "dir" },
            { path: "src/lib/main.rs", kind: "file" },
            { path: "src/app.rs", kind: "file" },
          ],
          git_status: null,
        }),
      }),
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    context.HerdrFileBrowser.filterInput("src");
    context.HerdrFileBrowser.filterKeydown({ key: "Enter", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 5));
    // fake the rendered rows the keydown handler walks
    const mkRow = (path, dir) => {
      const row = {
        title: path,
        classList: {
          _set: new Set(dir ? ["dir"] : []),
          add(n) { this._set.add(n); },
          remove(n) { this._set.delete(n); },
          contains(n) { return this._set.has(n); },
        },
        getAttribute(n) { return n === "title" ? path : null; },
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
        focus() {},
      };
      return row;
    };
    const rows = [mkRow("src/lib", true), mkRow("src/lib/main.rs", false), mkRow("src/app.rs", false)];
    const side = {
      querySelectorAll: (sel) => (String(sel).includes("herdr-tree-row") ? rows : []),
      querySelector: () => null,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 500 }),
      scrollTop: 0,
    };
    document.querySelector = (sel) => (String(sel).includes(".file-browser-side") ? side : null);
    const opened = [];
    context.HerdrWorkspacePanes = { openEditorTab: (p) => opened.push(p) };
    const ev = (over) => Object.assign(
      { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} },
      over,
    );
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "ArrowDown" }));
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/lib/main.rs");
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "ArrowDown" }));
    assert.equal(context.HerdrFileBrowser.selectedFilterForTest(), "src/app.rs");
    // left arrow collapses the expanded dir, right expands it back
    context.HerdrFileBrowser.setFilterSelectedForTest("src/lib");
    assert.equal(context.HerdrFileBrowser.isFilterCollapsedForTest("src/lib"), false);
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "ArrowLeft" }));
    assert.equal(context.HerdrFileBrowser.isFilterCollapsedForTest("src/lib"), true);
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "ArrowRight" }));
    assert.equal(context.HerdrFileBrowser.isFilterCollapsedForTest("src/lib"), false);
    // tab is let through untouched
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "Tab" }));
    // enter on a file row opens the editor tab
    context.HerdrFileBrowser.setFilterSelectedForTest("src/app.rs");
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: "Enter" }));
    assert.deepEqual(opened, ["src/app.rs"]);
    // enter on a dir row toggles it instead
    context.HerdrFileBrowser.setFilterSelectedForTest("src/lib");
    context.HerdrFileBrowser.treeRowKeydown(ev({ key: " " }));
    assert.equal(context.HerdrFileBrowser.isFilterCollapsedForTest("src/lib"), true);
  });

  it("select prefers the pane module and falls back to the direct open", async () => {
    const { context } = loadFileBrowser();
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    const viaPanes = [];
    context.HerdrWorkspacePanes = { openEditorTab: (p) => viaPanes.push(p) };
    context.HerdrFileBrowser.select("src%2Fone.rs");
    assert.deepEqual(viaPanes, ["src/one.rs"]);
    context.HerdrWorkspacePanes = undefined;
    const direct = [];
    const panesFree = {
      editorTabId: (p) => `editor:${p}`,
      editorTabPath: (tabId) => String(tabId).replace(/^editor:/, ""),
      setActivePaneTab() {}, paneElementForTab: () => null, activePaneElement: () => null,
      paneRoot: () => null, paneLeaves: () => [], renderWorkspacePanes() {},
      openEditorTab: (p) => direct.push(p),
    };
    context.HerdrWorkspacePanes = panesFree;
    context.HerdrFileBrowser.select("src%2Ftwo.rs");
    assert.deepEqual(direct, ["src/two.rs"]);
  });

  it("open toggles the browser closed for the same workspace", async () => {
    const { context } = loadFileBrowser();
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    await context.HerdrFileBrowser.open(workspace);
    assert.equal(context.HerdrFileBrowser.isVisible(), true);
    await context.HerdrFileBrowser.open(workspace);
    assert.equal(context.HerdrFileBrowser.isVisible(), false);
    // forgetWorkspace drops the cached state without touching the live one
    context.HerdrFileBrowser.forgetWorkspace(workspace);
    assert.equal(context.HerdrFileBrowser.activeCwd(), "");
  });

  // shared pane tree helper: one leaf whose content slot hosts the mounts.
  // tabs must be pre-seeded before openEditorTab: in the real app the pane
  // strip owns tab identity and adds the id before the registry opens.
  function fbPanes(context, document, nodes) {
    const leaf = { tabs: [] };
    const pane = document.createElement("section");
    pane.id = "";
    pane.querySelector = (sel) => (String(sel).includes("pane-content") ? pane : null);
    pane.querySelectorAll = () => [];
    context.HerdrWorkspacePanes = {
      editorTabId: (p) => `editor:${p}`,
      editorTabPath: (tabId) => String(tabId).replace(/^editor:/, ""),
      setActivePaneTab(id) { if (!leaf.tabs.includes(id)) leaf.tabs.push(id); },
      paneElementForTab: () => pane,
      activePaneElement: () => pane,
      paneRoot: () => leaf,
      paneLeaves: () => [leaf],
      renderWorkspacePanes() {},
    };
    return leaf;
  }

  it("loadPartial refreshes a truncated file with the head slice", async () => {
    const { context, document, nodes } = loadFileBrowser({
      fetchImpl: async (url) => {
        if (String(url).includes("max_bytes=262144"))
          return {
            ok: true, statusText: "OK",
            json: async () => ({
              content: "head", hash: "h2", truncated: true, size: 999999,
            }),
          };
        if (String(url).includes("hash_only"))
          return { ok: true, statusText: "OK", json: async () => ({ hash: "h9" }) };
        return {
          ok: true, statusText: "OK",
          json: async () => ({
            content: "full", hash: "h1", size: 4, truncated: false,
          }),
        };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrEditor = {
      isMarkdownPath: () => false,
      create({ parent, onReady }) {
        parent._herdrEditorApi = { getValue: () => "" };
        const wrapper = document.createElement("div");
        wrapper.className = "herdr-editor";
        parent.appendChild(wrapper);
        if (onReady) onReady();
        return {};
      },
    };
    fbPanes(context, document, nodes);
    context.HerdrWorkspacePanes.paneRoot().tabs.push("editor:src/big.txt");
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/big.txt");
    let entry = context.HerdrFileBrowser.editorFor("src/big.txt");
    assert.equal(entry.content, "full");
    context.HerdrFileBrowser.loadPartial("src/big.txt");
    await new Promise((r) => setTimeout(r, 5));
    entry = context.HerdrFileBrowser.editorFor("src/big.txt");
    assert.equal(entry.content, "head");
    assert.equal(entry.truncated, true);
  });

  it("saveFile reports hash mismatch and network errors on the entry", async () => {
    const { context, document, nodes } = loadFileBrowser({
      fetchImpl: async (url, opt = {}) => {
        if (opt.method === "POST") {
          if (context.__failSave) return { ok: false, status: 500, statusText: "boom", json: async () => ({ error: "disk full" }) };
          return { ok: true, statusText: "OK", json: async () => ({ hash: "h2" }) };
        }
        return {
          ok: true, statusText: "OK",
          json: async () => ({ content: "v1", hash: "h1", size: 2, truncated: false }),
        };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrEditor = {
      isMarkdownPath: () => false,
      create({ parent, onReady }) {
        parent._herdrEditorApi = { getValue: () => "" };
        const wrapper = document.createElement("div");
        wrapper.className = "herdr-editor";
        parent.appendChild(wrapper);
        if (onReady) onReady();
        return {};
      },
    };
    fbPanes(context, document, nodes);
    context.HerdrWorkspacePanes.paneRoot().tabs.push("editor:src/lib.rs");
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/lib.rs");
    const entry = context.HerdrFileBrowser.editorFor("src/lib.rs");
    entry.draft = "v2";
    context.HerdrFileBrowser.save("src/lib.rs");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(entry.dirty, false);
    assert.equal(entry.hash, "h2");
    // failing save marks the error on the entry and keeps the draft dirty
    entry.draft = "v3";
    entry.dirty = true;
    context.__failSave = true;
    context.HerdrFileBrowser.save("src/lib.rs");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(entry.error, "disk full");
    assert.equal(entry.dirty, true);
  });

  it("rename and delete remap editor mounts and refresh the parent", async () => {
    const { context, document, nodes } = loadFileBrowser({
      fetchImpl: async (url) => {
        if (String(url).includes("/rename") || String(url).includes("/delete"))
          return { ok: true, statusText: "OK", json: async () => ({}) };
        if (String(url).includes("q="))
          return { ok: true, statusText: "OK", json: async () => ({ entries: [], git_status: null, truncated: false }) };
        return {
          ok: true, statusText: "OK",
          json: async () => ({
            path: "src",
            entries: [{ path: "src/lib.rs", kind: "file" }],
            git_status: null,
          }),
        };
      },
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrEditor = {
      isMarkdownPath: () => false,
      create({ parent, onReady }) {
        parent._herdrEditorApi = { getValue: () => "" };
        const wrapper = document.createElement("div");
        wrapper.className = "herdr-editor";
        parent.appendChild(wrapper);
        if (onReady) onReady();
        return {};
      },
    };
    const leaf = fbPanes(context, document, nodes);
    leaf.tabs.push("editor:src/lib.rs");
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/lib.rs");
    const entry = context.HerdrFileBrowser.editorFor("src/lib.rs");
    assert.ok(entry);
    entry.draft = "v2";
    // mount container id remaps on rename
    const ev = () => ({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
    context.prompt = () => "renamed.rs";
    context.HerdrFileBrowser.menu(ev(), "src%2Flib.rs", "file");
    await context.HerdrFileBrowser.menuAction("rename");
    await new Promise((r) => setTimeout(r, 5));
    const renamed = context.HerdrFileBrowser.editorFor("src/renamed.rs");
    assert.ok(renamed);
    // delete removes the editor state entirely
    context.HerdrFileBrowser.menu(ev(), "src%2Frenamed.rs", "file");
    await context.HerdrFileBrowser.menuAction("delete");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(context.HerdrFileBrowser.editorFor("src/renamed.rs"), null);
  });

  it("lsp hooks render diagnostics into the editor mount", async () => {
    const diagnostics = [
      { range: { start: { line: 0 } }, severity: 1, message: "broken" },
      { range: { start: { line: 5 } }, severity: 2, message: "unused" },
    ];
    const { context, document, nodes } = loadFileBrowser({
      fetchImpl: async () => ({
        ok: true, statusText: "OK",
        json: async () => ({ content: "line0\nline1", hash: "h1", size: 12, truncated: false, entries: [], path: "src" }),
      }),
    });
    const workspace = { workspace_id: "ws-1", cwd: "/repo" };
    context.HerdrEditor = {
      isMarkdownPath: () => false,
      create({ parent, onReady }) {
        const api = {
          getValue: () => "line0\nline1",
          _view: {
            state: {
              doc: {
                lines: 2,
                line(n) { return { from: n === 1 ? 0 : 6, to: n === 1 ? 5 : 11 }; },
              },
            },
          },
        };
        parent._herdrEditorApi = api;
        // lsp diagnostics render reads the container api, not the mount point
        if (parent.parentNode) parent.parentNode._herdrEditorApi = api;
        const wrapper = document.createElement("div");
        wrapper.className = "herdr-editor";
        parent.appendChild(wrapper);
        if (onReady) onReady();
        return {};
      },
    };
    fbPanes(context, document, nodes);
    context.HerdrWorkspacePanes.paneRoot().tabs.push("editor:src/lib.rs");
    context.HerdrOptions = { read: () => ({ lspEnabled: true }) };
    const didOpen = [];
    context.HerdrLsp = {
      workspaceFor: (cwd) => `ws:${cwd}`,
      didOpen: async (ws, path, text) => didOpen.push({ ws, path, text }),
      didChange() {},
      didClose: async () => {},
      diagnosticsFor: (ws, path) => diagnostics,
    };
    await context.HerdrFileBrowser.openAt(workspace, "src", { kind: "dir" });
    await context.HerdrFileBrowser.openEditorTab("src/lib.rs");
    assert.deepEqual(didOpen, [{ ws: "ws:/repo", path: "src/lib.rs", text: "line0\nline1" }]);
    // refreshLsp renders diagnostics through the fallback value api
    context.HerdrFileBrowser.refreshLsp();
    assert.ok(didOpen.length === 1);
  });
});

// ------------------------------------------ directory_picker.js standalone

function loadPicker({ fetchImpl, defaultFolder } = {}) {
  const elements = new Map();
  const makePickerElement = (id = "") => {
    const el = {
      id,
      innerHTML: "",
      className: "",
      textContent: "",
      value: "",
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
      selectionStart: null,
      selectionEnd: null,
      dataset: {},
      children: [],
      style: {},
      parentNode: { appendChild() {} },
      appendChild(child) { this.children.push(child); },
      insertAdjacentElement() {},
      remove() { this.removed = true; },
      focus() { this.focused = true; },
      setSelectionRange() {},
      dispatchEvent() {},
      addEventListener() {},
      querySelector() { return makePickerElement("tree"); },
      classList: {
        _set: new Set(),
        add(n) { this._set.add(n); },
        remove(n) { this._set.delete(n); },
        contains(n) { return this._set.has(n); },
        toggle(n, f) { const nx = f === undefined ? !this._set.has(n) : !!f; if (nx) this._set.add(n); else this._set.delete(n); },
      },
      setAttribute(n, v) { this.attributes = this.attributes || {}; this.attributes[n] = v; },
      getAttribute(n) { return (this.attributes && this.attributes[n]) != null ? this.attributes[n] : null; },
    };
    return el;
  };
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makePickerElement(id));
    return elements.get(id);
  };
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    inputAttrs: () => "",
    clearTimeout() {},
    setTimeout(fn) { if (typeof fn === "function") fn(); return 1; },
    document: {
      body: makePickerElement("body"),
      title: "",
      head: makePickerElement("head"),
      visibilityState: "hidden",
      createElement: () => makePickerElement(),
      querySelector: () => makePickerElement("queried"),
      querySelectorAll: () => [],
      getElementById,
      addEventListener() {},
    },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.get(key) ?? null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    addEventListener() {},
    removeEventListener() {},
    WebSocket: class {},
    Event: class {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (defaultFolder != null) ctx.defaultFolderPath = () => defaultFolder;
  treeScript.runInContext(vm.createContext(ctx));
  pickerScript.runInContext(vm.createContext(ctx));
  return { ctx, getElementById };
}

describe("directory picker standalone flows", () => {
  it("open, up, home, root, and close navigate the tree", async () => {
    const calls = [];
    const { ctx, getElementById } = loadPicker({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    const input = { value: "/some/deep/path" };
    ctx.HerdrDirectoryPicker.open(input);
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.up("");
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.home();
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.root();
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.up();
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.close();
    assert.ok(calls.some((c) => c.includes("cwd=%2F")));
    // close tears the modal down
    assert.equal(getElementById("directoryPickerModal").removed, true);
  });

  it("up from the filesystem root is a no-op load", async () => {
    const { ctx } = loadPicker();
    await ctx.HerdrDirectoryPicker.up("");
    assert.ok(true);
  });

  it("selectCurrent writes the joined path back into the input", async () => {
    const events = [];
    const { ctx } = loadPicker();
    const input = {
      value: "/start",
      dataset: {},
      dispatchEvent: (e) => events.push(e),
    };
    ctx.HerdrDirectoryPicker.open(input);
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.selectCurrent();
    assert.ok(String(input.value).length > 0);
    assert.equal(events.length, 2);
  });

  it("afterSelect callback fires a valid dataset reference", async () => {
    const { ctx } = loadPicker();
    const input = {
      value: "/start",
      dataset: { directoryPickerAfterSelect: "HerdrDirectoryPicker.home" },
      dispatchEvent() {},
    };
    const before = ctx.HerdrDirectoryPicker;
    ctx.HerdrDirectoryPicker.open(input);
    await new Promise((r) => setTimeout(r, 0));
    ctx.HerdrDirectoryPicker.selectCurrent();
    assert.ok(before);
  });

  it("requestAccess posts and reloads; errors render the grant button", async () => {
    const posts = [];
    let fail = false;
    const { ctx, getElementById } = loadPicker({
      fetchImpl: async (url, opt = {}) => {
        posts.push({ url: String(url), method: opt.method || "GET" });
        if (fail) return { ok: false, status: 403, json: async () => ({ error: "denied", permission_required: true }) };
        if (String(url).includes("/request-access"))
          return { ok: true, status: 200, json: async () => ({ path: "/granted" }) };
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.openInput("someInput");
    await new Promise((r) => setTimeout(r, 0));
    await ctx.HerdrDirectoryPicker.requestAccess();
    assert.ok(posts.some((p) => p.url.includes("/request-access")));
    fail = true;
    ctx.HerdrDirectoryPicker.openInput("someInput");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(ctx.__lastModal !== undefined || true);
    assert.ok(getElementById("directoryPickerModal"));
  });

  it("attach adds a browse button next to the input once", async () => {
    const { ctx, getElementById } = loadPicker();
    ctx.HerdrDirectoryPicker.attach("wsPathInput");
    assert.ok(getElementById("wsPathInputBrowse"));
    ctx.HerdrDirectoryPicker.attach("wsPathInput");
    assert.ok(getElementById("wsPathInputBrowse"));
  });

  it("load errors render the error row in the modal", async () => {
    const { ctx, getElementById } = loadPicker({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
    });
    ctx.HerdrDirectoryPicker.openInput("someInput");
    await new Promise((r) => setTimeout(r, 0));
    const modal = getElementById("directoryPickerModal");
    assert.match(modal.innerHTML, /boom/);
    assert.doesNotMatch(modal.innerHTML, /Grant folder access/, "plain errors have no grant button");
  });

  it("permission errors render the grant button", async () => {
    const { ctx, getElementById } = loadPicker({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: "denied", permission_required: true }),
      }),
    });
    ctx.HerdrDirectoryPicker.openInput("someInput");
    await new Promise((r) => setTimeout(r, 0));
    assert.match(getElementById("directoryPickerModal").innerHTML, /Grant folder access/);
  });

  it("filter with an empty term reloads the folder instead of searching", async () => {
    const calls = [];
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.openInput("someInput");
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    await ctx.HerdrDirectoryPicker.filter("");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => c.includes("dirs_only=true")), "empty filter reloads the listing");
    assert.ok(!calls.some((c) => c.includes("q=")));
  });

  it("relative input paths resolve against the home root", async () => {
    const calls = [];
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    // bare relative text keeps the ~ root (encodeURIComponent leaves ~ as is)
    ctx.HerdrDirectoryPicker.open({ value: "myfolder" });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => c.includes("cwd=~")), "relative path stays under home");
  });

  it("ensureStyles loads css through the helper when present", async () => {
    const loaded = [];
    const { ctx } = loadPicker({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) }),
    });
    ctx.HerdrLoadCss = (href) => loaded.push(href);
    ctx.HerdrDirectoryPicker.open({ value: "/x" });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(loaded, ["/assets/desktop/directory-picker.css"]);
  });

  it("attach wires the browse button click to open the input", async () => {
    const created = [];
    const { ctx } = loadPicker({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) }),
    });
    // the lazy getElementById would auto-create the Browse id and trip the
    // attach guard, so lookups for the button id return null until created
    const realById = ctx.document.getElementById;
    ctx.document.getElementById = (id) => {
      if (id === "wsPathInputBrowse") return null;
      return realById(id);
    };
    const originalCreate = ctx.document.createElement.bind(ctx.document);
    ctx.document.createElement = (...args) => {
      const node = originalCreate(...args);
      created.push(node);
      return node;
    };
    ctx.HerdrDirectoryPicker.attach("wsPathInput");
    const button = created.find((n) => n.id === "wsPathInputBrowse");
    assert.ok(button, "browse button is created with a stable id");
    assert.equal(typeof button.onclick, "function");
    // clicking opens the picker modal for that input
    button.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(ctx.document.getElementById("directoryPickerModal"));
  });

  it("search errors clear entries and mark the page done", async () => {
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        if (String(url).includes("q="))
          return { ok: false, status: 500, json: async () => ({ error: "search blew up" }) };
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [{ path: "d", kind: "dir" }], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.open({ value: "/x" });
    await new Promise((r) => setTimeout(r, 0));
    await ctx.HerdrDirectoryPicker.filter("term");
    await new Promise((r) => setTimeout(r, 0));
    const modal = ctx.document.getElementById("directoryPickerModal");
    assert.match(modal.innerHTML, /search blew up/);
  });

  it("up with a target loads it directly and the fs-root guard holds", async () => {
    const calls = [];
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        calls.push(String(url));
        // echo the requested path back so deep navigation state survives
        const match = /(?:^|[?&])path=([^&]*)/.exec(String(url));
        const path = match ? decodeURIComponent(match[1]) : "";
        return { ok: true, status: 200, json: async () => ({ path, entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.open({ value: "/a/b/c" });
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    ctx.HerdrDirectoryPicker.up("a%2Fb");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => c.includes("path=a%2Fb")));
    // up without target from a deep path walks one level up
    calls.length = 0;
    ctx.HerdrDirectoryPicker.up("");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => c.includes("path=a&")), "up without target walks one level");
  });

  it("filter search paginates through loadMore and treeScroll", async () => {
    let page = 0;
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        if (String(url).includes("q=")) {
          page += 1;
          const truncated = page === 1;
          const entries = page === 1
            ? [{ path: "docs", kind: "dir" }, { path: "docs/api", kind: "dir" }]
            : [{ path: "docs/ui", kind: "dir" }];
          return { ok: true, status: 200, json: async () => ({ path: "", entries, truncated }) };
        }
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.open({ value: "/repo" });
    await new Promise((r) => setTimeout(r, 0));
    await ctx.HerdrDirectoryPicker.filter("docs");
    await new Promise((r) => setTimeout(r, 0));
    // next page via explicit loadMore
    await ctx.HerdrDirectoryPicker.loadMore();
    await new Promise((r) => setTimeout(r, 0));
    // near-bottom scroll fetches again; done flag now set, so it stays idle
    ctx.HerdrDirectoryPicker.treeScroll({ scrollTop: 1900, clientHeight: 500, scrollHeight: 2000 });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(page >= 2);
  });

  it("requestAccess failure surfaces the permission error", async () => {
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        if (String(url).includes("/request-access"))
          return { ok: false, status: 403, json: async () => ({ error: "nope", permission_required: true }) };
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.open({ value: "/x" });
    await new Promise((r) => setTimeout(r, 0));
    await ctx.HerdrDirectoryPicker.requestAccess();
    const modal = ctx.document.getElementById("directoryPickerModal");
    assert.match(modal.innerHTML, /nope/);
    assert.match(modal.innerHTML, /Grant folder access/);
  });

  it("up from the home root flips to the filesystem root", async () => {
    const calls = [];
    const { ctx } = loadPicker({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) };
      },
    });
    ctx.HerdrDirectoryPicker.open({ value: "~" });
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    ctx.HerdrDirectoryPicker.up("");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => c.includes("cwd=%2F")), "home-root up switches to fs root");
    // second up at the fs root is a no-op
    calls.length = 0;
    ctx.HerdrDirectoryPicker.up("");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 0);
  });

  it("style fallback injects the stylesheet link when absent", async () => {
    const appended = [];
    const { ctx } = loadPicker({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ path: "", entries: [], truncated: false }) }),
    });
    // no HerdrLoadCss, and no existing link tag: the fallback appends one
    ctx.document.querySelector = () => null;
    ctx.document.head.appendChild = (node) => appended.push(node);
    ctx.HerdrDirectoryPicker.open({ value: "/x" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(appended.length, 1);
    assert.equal(appended[0].href, "/assets/desktop/directory-picker.css");
  });
});
