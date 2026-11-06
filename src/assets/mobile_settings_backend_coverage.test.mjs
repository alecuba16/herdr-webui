import { describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
import vm from "node:vm";

// Statement coverage push for mobile/settings.js and mobile/backend.js.
// Same vm-bundle harness as mobile_load.test.mjs, duplicated because test
// files are not importable modules in this suite: coverage attributes each
// product file's statements to its real disk path.

function element(id = "") {
  const classes = new Set();
  const el = {
    id,
    classList: {
      toggle(cls, on) {
        if (on === undefined ? !classes.has(cls) : on) classes.add(cls);
        else classes.delete(cls);
      },
      add(...cls) { cls.forEach((c) => classes.add(c)); },
      remove(...cls) { cls.forEach((c) => classes.delete(c)); },
      contains(cls) { return classes.has(cls); },
      addedClasses: classes,
    },
    dataset: {},
    style: { setProperty() {} },
    rect: { left: 300, top: 700, width: 80, height: 40 },
    getBoundingClientRect() {
      return this.rect;
    },
    setAttribute(name, value) {
      (this.attributes || (this.attributes = {}))[name] = value;
    },
    getAttribute(name) {
      return (this.attributes || {})[name] ?? null;
    },
    disabled: false,
    hidden: false,
    open: false,
    innerHTML: "",
    textContent: "",
    firstElementChild: null,
    clientWidth: 360,
    clientHeight: 520,
    appendChild() {},
    insertBefore(node) {
      // keep track of chrome nodes injected at the row head
      (this.inserted || (this.inserted = [])).unshift(node);
      return node;
    },
    focus() {},
    listeners: {},
    addEventListener(event, listener) {
      (this.listeners[event] || (this.listeners[event] = [])).push(listener);
    },
    removeEventListener(event, listener) {
      const list = this.listeners[event] || [];
      const idx = list.indexOf(listener);
      if (idx > -1) list.splice(idx, 1);
    },
    // selector-driven lookups used by the settings row chrome updater:
    // tests can register per-element results before driving a render
    querySelector(selector) {
      const results = this.querySelectorResults || {};
      return Object.prototype.hasOwnProperty.call(results, selector)
        ? results[selector]
        : null;
    },
    querySelectorAll() {
      return [];
    },
    remove() {
      this.removed = true;
    },
    replaceWith() {},
    parentNode: null,
  };
  // createElement-based chrome injection reads firstElementChild off the
  // parsed holder element
  Object.defineProperty(el, "firstElementChild", {
    configurable: true,
    get() {
      return this.parsedFirstChild === undefined ? null : this.parsedFirstChild;
    },
    set(value) {
      this.parsedFirstChild = value;
    },
  });
  return el;
}

function context(pathname = "/", options = {}) {
  const elements = new Map();
  const localStorage = new Map();
  const requests = [];
  const sockets = [];
  const timers = [];
  const listeners = {};
  const documentQueryResults = new Map();
  const documentQueryAllResults = new Map();
  let timerSeq = 0;
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  // The app's confirm sheet resolves through HerdrMobile.resolveConfirm;
  // when shown, auto-answer with the injected confirm stub.
  const confirmSheet = element("mobileConfirmSheet");
  let confirmSheetShown = false;
  Object.defineProperty(confirmSheet, "hidden", {
    configurable: true,
    get: () => !confirmSheetShown,
    set: (value) => {
      confirmSheetShown = !value;
      if (confirmSheetShown) {
        const confirmImpl = ctx.confirm || options.confirm || (() => true);
        const answer = confirmImpl();
        Promise.resolve().then(() => {
          if (ctx.HerdrMobile && ctx.HerdrMobile.resolveConfirm)
            ctx.HerdrMobile.resolveConfirm(answer);
        });
      }
    },
  });
  elements.set("mobileConfirmSheet", confirmSheet);
  const locationRef = {
    pathname,
    href: "",
    protocol: "http:",
    host: "127.0.0.1:8787",
  };
  const ctx = {
    console,
    TextEncoder,
    Uint8Array,
    setTimeout(callback, delay = 0) {
      const id = ++timerSeq;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cleared = true;
    },
    document: {
      body: element("body"),
      documentElement: element("html"),
      // settings row chrome: document.querySelector returns the row
      // registered by the test through ctx.setDocumentQuery
      createElement: () => {
        const holder = element();
        // parsed markup lands in innerHTML; expose the first child node so
        // insertBefore receives something real
        holder.innerHTML = "";
        Object.defineProperty(holder, "firstElementChild", {
          configurable: true,
          get() {
            return this.parsedFirstChild === undefined ? null : this.parsedFirstChild;
          },
          set(value) {
            this.parsedFirstChild = value;
          },
        });
        return holder;
      },
      getElementById: getElement,
      querySelector: (selector) => documentQueryResults.get(selector) || null,
      querySelectorAll: (selector) =>
        documentQueryAllResults.get(selector) || [],
      hidden: false,
      addEventListener(event, listener) {
        (listeners[event] || (listeners[event] = [])).push(listener);
      },
      removeEventListener(event, listener) {
        const list = listeners[event] || [];
        const idx = list.indexOf(listener);
        if (idx > -1) list.splice(idx, 1);
      },
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    location: locationRef,
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => {
        localStorage.delete(key);
      },
    },
    confirm: options.confirm || (() => true),
    window: null,
    globalThis: null,
    Terminal: class {
      constructor() {
        this.buffer = { active: { baseY: 0, viewportY: 0 } };
        this.writes = [];
      }
      onData() {}
      onScroll() {}
      open() {}
      resize() {}
      registerLinkProvider() {
        return { dispose() {} };
      }
      write(data, callback) {
        this.writes.push(data);
        if (callback) callback();
      }
      usesNormalBuffer() {
        return true;
      }
      atBottom() {
        return true;
      }
      scrollLines() {}
      scrollToLine() {}
      scrollToBottom() {}
      focus() {}
      clear() {}
      dispose() {}
      destroy() {}
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.bufferedAmount = 0;
        sockets.push(this);
        ctx.lastSocket = this;
      }
      send() {}
      close() {}
    },
    fetch: async (url, opt = {}) => {
      requests.push({ url, opt });
      const optionValue = (key, fallback) => {
        const value = options[key];
        return typeof value === "function"
          ? value({ url, opt, requests })
          : value === undefined
            ? fallback
            : value;
      };
      if (url === "/api/server-settings")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("serverSettings", {
              backend_mode: "builtin",
              default_folder: "/tmp/default",
              enabled_backends: { builtin: true, "external-herdr": true },
            }),
        };
      if (url === "/api/versions")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("versions", {
              webui: "1.2.3",
              backend: "builtin-0.9.0",
              backend_mode: "builtin",
              session: "default",
              compatibility: { status: "compatible", message: "all good" },
            }),
        };
      if (url === "/api/no-sleep")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("noSleep", { mode: "auto", supported: true }),
        };
      if (url === "/api/logout")
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url === "/api/sessions")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("sessionsResponse", {
              sessions: [{ name: "default", backend: "builtin", running: true }],
              herdr_available: true,
              herdr_compatible: true,
              herdr_version: "0.9.0",
              default_backend: "builtin",
              enabled_backends: { builtin: true, "external-herdr": true },
            }),
        };
      if (url === "/api/session/launch" || url === "/api/session/close")
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, pid: 4242 }),
        };
      if (String(url).startsWith("/api/session-snapshot"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              snapshot: {
                workspaces: [
                  { workspace_id: "w1", label: "alpha", pane_count: 1, cwd: "/tmp/alpha" },
                ],
                tabs: [{ workspace_id: "w1", tab_id: "w1:t1", number: 1 }],
                panes: [
                  { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
                ],
                layouts: [],
                agents: [],
              },
              worktree_results: [],
              workspace_order: [],
            },
          }),
        };
      return { ok: true, status: 200, json: async () => ({ result: {} }) };
    },
  };
  ctx.HerdrTerminalRenderer = {
    create: async () => new ctx.Terminal(),
  };
  ctx.setDocumentQuery = (selector, el) => documentQueryResults.set(selector, el);
  ctx.setDocumentQueryAll = (selector, list) => documentQueryAllResults.set(selector, list);
  ctx.requests = requests;
  ctx.sockets = sockets;
  ctx.pendingTimers = timers;
  ctx.flushSomeTimers = async (filter) => {
    const due = [];
    for (const timer of timers)
      if (!timer.cleared && filter(timer)) due.push(timer);
    for (const timer of due) {
      const at = timers.indexOf(timer);
      if (at > -1) timers.splice(at, 1);
      await timer.callback();
    }
  };
  ctx.settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };
  ctx.localStorageMap = localStorage;
  ctx.window = Object.assign(ctx, {
    matchMedia: () => ({ matches: false }),
    innerWidth: 390,
    innerHeight: 844,
    addEventListener() {},
  });
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const MOBILE_BUNDLE_FILES = [
  "./shared/options.js",
  "./shared/core.js",
  "./shared/http.js",
  "./shared/attention.js",
  "./shared/actions.js",
  "./shared/file_icons.js",
  "./shared/file_tree.js",
  "./shared/line_context.js",
  "./shared/file_content_search.js",
  "./shared/workspace_search.js",
  "./shared/editor.js",
  "./shared/terminal_fit.js",
  "./mobile/core.js",
  "./mobile/attention.js",
  "./mobile/terminal.js",
  "./mobile/worktrees.js",
  "./mobile/directory_picker.js",
  "./mobile/file_browser.js",
  "./mobile/notes.js",
  "./mobile/settings.js",
  "./mobile/search.js",
  "./mobile/git.js",
  "./mobile/composer.js",
  "./mobile/lens.js",
  "./mobile/sessions.js",
  "./mobile/events.js",
  "./mobile/screens.js",
  "./mobile/panels.js",
  "./mobile/workmeta.js",
  "./mobile/theme.js",
  "./mobile/actions.js",
  "./mobile/backend.js",
  "./mobile/app.js",
];

let mobileBundleScripts = null;
function getMobileBundleScripts() {
  if (!mobileBundleScripts) {
    mobileBundleScripts = MOBILE_BUNDLE_FILES.map((path) => {
      const realPath = fileURLToPath(new URL(path, import.meta.url));
      return new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath });
    });
  }
  return mobileBundleScripts;
}

function runSource(ctx) {
  for (const script of getMobileBundleScripts()) script.runInContext(ctx);
}

function readOptions(ctx) {
  return JSON.parse(ctx.localStorage.getItem("herdr-web-options") || "{}");
}

describe("mobile settings coverage", () => {
  it("settings storage falls back when HerdrOptions breaks or is absent", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();

    // raw localStorage write path: options.js absent from this world.
    // assignment, not delete: host-side delete does not propagate into
    // the vm global, assignment to undefined does
    ctx.HerdrOptions = undefined;
    app.setFileBrowserLineNumbers(true);
    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options") || "{}")
        .fileBrowserLineNumbers,
      true,
      "writeOptions stored straight to localStorage without HerdrOptions",
    );

    // settings.readOptions catch: a throwing HerdrOptions.read is swallowed
    ctx.HerdrOptions = {
      read() {
        throw Error("options store broken");
      },
      write() {},
    };
    doesNotThrow(() => app.setHeaderSearchEnabled(true));

    // logout catch: network failure still lands on the login page
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url, opt) => {
      ctx.requests.push({ url, opt });
      if (String(url).includes("logout")) throw Error("logout offline");
      return originalFetch(url, opt);
    };
    await app.logout();
    await ctx.settle();
    equal(ctx.location.href, "/", "logout network failure still redirects");
  });

  it("settings screen renders all groups, filter toggles visibility live", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const screen = ctx.document.getElementById("mobileScreen");
    ok(screen.innerHTML.includes("Settings"), "settings screen rendered");
    ok(screen.innerHTML.includes("Appearance"), "appearance group");
    ok(screen.innerHTML.includes("Energy"), "energy group");
    ok(screen.innerHTML.includes("Terminal renderer"), "terminal group");
    ok(screen.innerHTML.includes("webui 1.2.3"), "version footer from loadVersions");
    ok(screen.innerHTML.includes('id="mobileSettingsEmpty"'), "empty state node present");

    // live filtering: setSettingsFilter walks the disclosure nodes
    const disclosures = [
      Object.assign(element(), {
        dataset: { settingsText: "appearance theme dark light auto" },
      }),
      Object.assign(element(), {
        dataset: { settingsText: "terminal renderer core ghostty font" },
      }),
    ];
    ctx.setDocumentQueryAll(".mobile-settings-disclosure", disclosures);
    const empty = element("mobileSettingsEmpty");
    ctx.setDocumentQuery("#mobileSettingsEmpty", empty);
    ctx.HerdrMobile.setSettingsFilter("terminal");
    await ctx.settle();
    equal(disclosures[0].hidden, true, "non-matching group hidden");
    equal(disclosures[1].hidden, false, "matching group stays");
    equal(disclosures[1].open, true, "matching group forced open");
    equal(empty.hidden, false, "empty node hidden while one group matches");
    ctx.HerdrMobile.setSettingsFilter("no-such-thing");
    await ctx.settle();
    equal(disclosures[0].hidden, true, "no match hidden");
    equal(disclosures[1].hidden, true, "no match hidden either");
    equal(empty.hidden, false, "empty node shows placeholder state");
    ctx.HerdrMobile.setSettingsFilter("");
    await ctx.settle();
    equal(disclosures[0].hidden, false, "clear filter unhides");
    equal(disclosures[1].open, true, "open flag kept");
  });

  it("rollback paths restore baselines for every settings family", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const app = ctx.HerdrMobile;

    // theme baseline was auto; change to dark then roll back
    app.setThemeMode("dark");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "dark");
    app.rollbackSetting("theme");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "auto");

    // layout rollback restores the open-time value
    app.setLayoutPreference("desktop");
    app.rollbackSetting("layout");
    equal(ctx.localStorage.getItem("herdr-web-layout"), "auto");

    // volume rollback clamps back to the baseline percent
    app.setNotificationVolume("80");
    equal(readOptions(ctx).notificationVolume, 0.8);
    app.rollbackSetting("notificationVolume");
    equal(readOptions(ctx).notificationVolume, 0);

    // scrollLines rollback writes the clamped baseline
    app.setSettingDebounced("scrollLines", "20");
    await ctx.flushSomeTimers((timer) => timer.delay >= 800);
    equal(readOptions(ctx).scrollLines, 20);
    app.rollbackSetting("scrollLines");
    equal(readOptions(ctx).scrollLines, 3);

    // default branch rollback restores a plain option (unset baseline is "")
    app.setAgentSortMode("attention");
    app.rollbackSetting("agentSortMode");
    equal(readOptions(ctx).agentSortMode, "");

    // terminalFontFamily rollback also re-applies the font
    app.setTerminalFontFamily("Custom Mono");
    app.rollbackSetting("terminalFontFamily");
    equal(readOptions(ctx).terminalFontFamily, "");

    // terminalCore rollback reloads the terminal
    app.setTerminalCore("wterm");
    await ctx.settle();
    app.rollbackSetting("terminalCore");
    await ctx.settle();

    // unknown id is a no-op
    doesNotThrow(() => app.rollbackSetting("no-such-id"));
  });

  it("flash badges render applied, saving, and error states", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const app = ctx.HerdrMobile;
    const screen = () => ctx.document.getElementById("mobileScreen");

    // applied badge bakes into the theme row
    app.setThemeMode("light");
    await ctx.settle();
    ok(
      screen().innerHTML.includes("settings-applied") &&
        screen().innerHTML.includes("Applied"),
      "applied badge rendered",
    );

    // the applied flash timer clears the badge and re-renders
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle();
    ok(!screen().innerHTML.includes("settings-applied"), "badge cleared after timer");

    // saving badge shows while the no-sleep POST is in flight, then error
    const failFetch = ctx.fetch;
    ctx.fetch = async (url, opt) => {
      if (String(url).startsWith("/api/no-sleep")) {
        ctx.requests.push({ url, opt });
        return {
          ok: false,
          status: 500,
          statusText: "no sleep down",
          json: async () => ({ error: "no sleep down" }),
        };
      }
      return failFetch(url, opt);
    };
    await app.setNoSleepMode("2h");
    await ctx.settle();
    ok(screen().innerHTML.includes("settings-applied-error"), "error badge rendered");
    ok(screen().innerHTML.includes("no sleep down"), "error text rendered");
    ok(ctx.HerdrMobileAppDeps.state.noSleep.mode, "off", "state placeholder");
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle();
    ok(!screen().innerHTML.includes("settings-applied-error"), "error badge cleared");

    // success path: saving badge swaps for applied once the POST lands
    ctx.fetch = failFetch;
    await app.setNoSleepMode("4h");
    await ctx.settle();
    ok(screen().innerHTML.includes("settings-applied-ok"), "applied badge after save");
    equal(ctx.HerdrMobileAppDeps.state.noSleep.mode, "auto");
    await ctx.flushSomeTimers((timer) => !timer.cleared);

    // loadNoSleep failure keeps a supported-but-off placeholder
    ctx.fetch = async (url, opt) => {
      if (String(url).startsWith("/api/no-sleep")) {
        ctx.requests.push({ url, opt });
        throw Error("no sleep offline");
      }
      return failFetch(url, opt);
    };
    const loaded = await ctx.HerdrMobile.loadNoSleepState();
    await ctx.settle();
    equal(loaded.mode, "off");
    equal(loaded.supported, true);
  });

  it("debounced commits arm, fire, flush, and refresh row chrome in place", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const app = ctx.HerdrMobile;

    // a row exists in the document: chrome refresh targets it
    const row = element();
    row.querySelectorResults = {
      ".settings-applied": null,
      ".settings-rollback": null,
    };
    ctx.setDocumentQuery('[data-settings-id="worktreeDefaultDirectory"]', row);

    // debounced commit fires after the delay and walks the row chrome path
    app.setSettingDebounced("worktreeDefaultDirectory", "/tmp/deb");
    equal(readOptions(ctx).worktreeDefaultDirectory, undefined);
    await ctx.flushSomeTimers((timer) => timer.delay >= 800);
    equal(readOptions(ctx).worktreeDefaultDirectory, "/tmp/deb");

    // commitSettingFromChange flushes a pending debounce and commits now
    app.setSettingDebounced("explorationDefaultDirectory", "/tmp/never");
    app.commitSettingFromChange("explorationDefaultDirectory", "/tmp/now");
    equal(readOptions(ctx).explorationDefaultDirectory, "/tmp/now");
    await ctx.flushSomeTimers((timer) => timer.delay >= 800);
    equal(readOptions(ctx).explorationDefaultDirectory, "/tmp/now");

    // unknown ids are ignored on both paths
    doesNotThrow(() => app.setSettingDebounced("nope", "x"));
    doesNotThrow(() => app.commitSettingFromChange("nope", "x"));
  });

  it("every numeric and boolean setter clamps and persists", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const app = ctx.HerdrMobile;
    const read = () => readOptions(ctx);

    app.setFileBrowserDepth("99");
    equal(read().fileBrowserDepth, 8);
    app.setFileBrowserDepth("nonsense");
    equal(read().fileBrowserDepth, 0);

    app.setFileBrowserSearchPageSize("999");
    equal(read().fileBrowserSearchPageSize, 500);
    app.setFileContentSearchMinChars("0");
    equal(read().fileContentSearchMinChars, 3);
    app.setFileContentSearchPageSize("9");
    equal(read().fileContentSearchPageSize, 10);
    app.setFileContentSearchContextLines("bad");
    equal(read().fileContentSearchContextLines, 2);
    app.setFileContentSearchAutoCollapseFiles("999");
    equal(read().fileContentSearchAutoCollapseFiles, 200);
    app.setFileContentSearchMatchesPerFile("0");
    equal(read().fileContentSearchMatchesPerFile, 5);

    app.setFileContentSearchDefaultExpanded(false);
    equal(read().fileContentSearchDefaultExpanded, false);
    app.setFileContentSearchMatchCase(true);
    equal(read().fileContentSearchMatchCase, true);
    app.setFileContentSearchRegex(true);
    equal(read().fileContentSearchRegex, true);

    app.setFileBrowserLineNumbers(false);
    equal(read().fileBrowserLineNumbers, false);
    app.setHeaderSearchEnabled(false);
    equal(read().headerSearchEnabled, false);

    app.setEditorEnabled(false);
    equal(read().editorEnabled, false);
    app.setEditorWordWrap(false);
    equal(read().editorWordWrap, false);
    app.setEditorTabSize("0");
    equal(read().editorTabSize, 2);
    app.setLspEnabled(true);
    equal(read().lspEnabled, true);

    app.setTerminalLinks(false);
    equal(read().terminalLinks, false);
    app.setTerminalMouseReporting(true);
    equal(read().terminalMouseReporting, true);
    app.setTerminalScrollLines("30");
    equal(read().scrollLines, 20);
    app.setTerminalFontFamily("  Mono  ");
    equal(read().terminalFontFamily, "Mono");

    app.setWorkingDismissMinutes("9999");
    equal(read().workingDismissMinutes, 1440);
    app.setWorkspaceOpenTerminal(true);
    equal(read().workspaceOpenTerminal, true);
    app.setCloseWorkspaceOnLastTerminal(false);
    equal(read().closeWorkspaceOnLastTerminal, false);
    app.setStuckWorkingEnabled(false);
    equal(read().stuckWorkingEnabled, false);
    app.setPromptCardsEnabled(false);
    equal(read().promptCardsEnabled, false);
    app.setSoundScope("all");
    equal(read().soundScope, "all");
    app.setNotificationVolume("50");
    equal(read().notificationVolume, 0.5);

    app.setSearchWorkspacesEnabled(false);
    equal(read().searchWorkspacesEnabled, false);
    app.setSearchFilesEnabled(true);
    equal(read().searchFilesEnabled, true);
    app.setSearchFoldersEnabled(false);
    equal(read().searchFoldersEnabled, false);
    app.setSearchContentEnabled(true);
    equal(read().searchContentEnabled, true);
  });

  it("search section order: set, move with bounds, toggle flips", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("settings");
    await ctx.settle();
    const app = ctx.HerdrMobile;
    const read = () => readOptions(ctx);

    app.setSearchSectionOrder("content,workspaces,files");
    equal(read().searchSectionOrder, "content,workspaces,files");

    // out-of-range moves are no-ops
    app.moveSearchSection("content", -1);
    equal(read().searchSectionOrder, "content,workspaces,files");
    app.moveSearchSection("files", 1);
    equal(read().searchSectionOrder, "content,workspaces,files");
    doesNotThrow(() => app.moveSearchSection("bogus", 1));

    // a legal move swaps neighbours
    app.moveSearchSection("workspaces", 1);
    equal(read().searchSectionOrder, "content,files,workspaces");

    // toggle flips the section's enabled flag, second toggle restores it
    app.toggleSearchSection("files");
    equal(read().searchFilesEnabled, false);
    app.toggleSearchSection("files");
    equal(read().searchFilesEnabled, true);
    doesNotThrow(() => app.toggleSearchSection("bogus"));
  });

  it("browser notifications need granted permission, logout posts and redirects", async () => {
    const ctx = context("/session/default/workspace/w1");
    let requested = false;
    ctx.Notification = {
      permission: "default",
      async requestPermission() {
        requested = true;
        this.permission = "granted";
        return "granted";
      },
    };
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    const app = ctx.HerdrMobile;

    await app.setBrowserNotifications(true);
    equal(requested, true, "permission requested");
    equal(readOptions(ctx).browserNotifications, true, "granted permission stored");

    // denied permission keeps the option off
    ctx.Notification.permission = "denied";
    await app.setBrowserNotifications(true);
    equal(readOptions(ctx).browserNotifications, false, "denied keeps option off");

    // no Notification global: enabling stays off
    delete ctx.Notification;
    await app.setBrowserNotifications(true);
    equal(readOptions(ctx).browserNotifications, false, "unsupported stays off");

    // declined confirm never posts the logout
    ctx.confirm = () => false;
    await app.logout();
    await ctx.settle();
    ok(
      !ctx.requests.some((request) => request.url === "/api/logout"),
      "declined logout posts nothing",
    );

    // confirmed logout posts and redirects to /
    ctx.confirm = () => true;
    await app.logout();
    await ctx.settle();
    ok(
      ctx.requests.some((request) => request.url === "/api/logout"),
      "logout posted",
    );
    equal(ctx.location.href, "/", "redirected to login root");
  });
});

describe("mobile backend coverage", () => {
  it("server settings adopt the mode once, sessions sync the enabled backends", async () => {
    const ctx = context("/session/default/workspace/w1", {
      serverSettings: {
        backend_mode: "external-herdr",
        default_folder: "/x",
        enabled_backends: { builtin: true, "external-herdr": true },
      },
    });
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;

    // boot: server mode adopted, pin written once
    equal(state.backendMode, "external-herdr");
    equal(state.sessionBackend, "external-herdr");
    equal(state.serverBackendConfirmed, true);
    equal(
      ctx.localStorage.getItem("herdr-session-backend:default"),
      "external-herdr",
    );

    // second load keeps the explicit user choice (no re-adoption), driven
    // through the backend module with the real app state and api
    state.sessionBackend = "builtin";
    const module = ctx.HerdrMobileBackendModule.create({
      state,
      api: ctx.HerdrMobileAppDeps.api,
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: (session) =>
        ctx.localStorage.getItem("herdr-session-backend:" + session) || "builtin",
      writeSessionBackend: (session, value) =>
        ctx.localStorage.setItem("herdr-session-backend:" + session, value),
    });
    await module.loadServerSettings();
    await ctx.settle();
    equal(state.sessionBackend, "builtin", "explicit pin survives reload");

    // labels and classes
    equal(module.sessionBackendLabel("external-herdr"), "Herdr");
    equal(module.sessionBackendLabel("builtin"), "built-in");
    equal(state.defaultFolder, "/x");
  });

  it("server settings disabled backends retarget the pin and cycle the events socket", async () => {
    const ctx = context("/session/default/workspace/w1", {
      serverSettings: {
        backend_mode: "builtin",
        enabled_backends: { builtin: false, "external-herdr": true },
      },
      sessionsResponse: {
        sessions: [],
        herdr_available: true,
        herdr_compatible: true,
        default_backend: "external-herdr",
        enabled_backends: { builtin: false, "external-herdr": true },
      },
    });
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;

    // the disabled builtin pin retargeted to the server default
    equal(state.sessionBackend, "external-herdr");
    equal(
      ctx.localStorage.getItem("herdr-session-backend:default"),
      "external-herdr",
    );

    // a server_settings_changed frame over the events socket disables the
    // pinned external backend: pin falls back to builtin and the socket
    // cycles (reconnect scheduled)
    const eventSocket = ctx.lastSocket;
    ok(eventSocket, "events socket connected");
    const timersBefore = ctx.pendingTimers.length;
    eventSocket.onmessage({
      data: JSON.stringify({
        type: "server_settings_changed",
        enabled_backends: { builtin: true, "external-herdr": false },
        default_backend: "builtin",
      }),
    });
    await ctx.settle();
    equal(state.backendsEnabled["external-herdr"], false);
    equal(state.sessionBackend, "builtin");
    equal(state.serverDefaultBackend, "builtin");
    ok(ctx.pendingTimers.length > timersBefore, "reconnect scheduled after cycle");
  });

  it("loadSessions failure seeds a fallback session row with the error", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const state = {
      session: "work",
      backendMode: "builtin",
      sessionBackend: "builtin",
      sessions: [],
      sessionsError: "",
    };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async () => {
        throw Error("sessions down");
      },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });
    await backend.loadSessions();
    equal(state.sessionsError, "sessions down");
    equal(state.sessions.length, 1);
    equal(state.sessions[0].name, "work");
    equal(state.sessions[0].backend, "builtin");
    equal(state.sessions[0].running, false);
  });

  it("incompatible external pin falls back to builtin on loadSessions", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const written = [];
    const state = {
      session: "default",
      backendMode: "builtin",
      sessionBackend: "external-herdr",
    };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async () => ({
        sessions: [],
        herdr_available: false,
        herdr_compatible: false,
      }),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: (session, value) => written.push([session, value]),
    });
    await backend.loadSessions();
    equal(state.sessionBackend, "builtin");
    ok(written.some(([, value]) => value === "builtin"));
    equal(state.herdrAvailable, false);
    equal(state.herdrCompatible, false);
  });

  it("loadVersions fills the footer text, offline fallback, and dedupes", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const state = { versionsLoading: false };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async (url) => {
        if (url === "/api/versions")
          return {
            webui: "1.0",
            backend: "builtin-1",
            backend_mode: "builtin",
            session: "work",
            compatibility: { status: "old", message: "mismatch" },
          };
        return {};
      },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "",
      writeSessionBackend: () => {},
    });
    await backend.loadVersions();
    match(state.versionsText, /webui 1\.0/);
    match(state.versionsText, /built-in/);
    match(state.versionsText, /· old/);
    match(state.versionsTitle, /session work/);

    // failure path keeps the offline placeholder
    const failState = { versionsLoading: false };
    const failBackend = ctx.HerdrMobileBackendModule.create({
      state: failState,
      api: async () => {
        throw Error("offline");
      },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });
    await failBackend.loadVersions();
    equal(failState.versionsText, "webui - · backend offline");

    // an in-flight load is deduped
    failState.versionsLoading = true;
    await failBackend.loadVersions();
    equal(failState.versionsText, "webui - · backend offline");
  });

  it("herdr_error frame closes the broken session and relaunches builtin", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const apiCalls = [];
    const state = {
      session: "work",
      backendMode: "",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: true, "external-herdr": true },
    };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async (url) => {
        apiCalls.push(url);
        return {};
      },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: () => {},
    });

    // malformed frames are not hers
    equal(backend.handleHerdrErrorFrame("not json"), false);
    equal(
      backend.handleHerdrErrorFrame(JSON.stringify({ type: "other" })),
      false,
    );

    // real frame: close, offer builtin, launch, pin builtin
    equal(
      backend.handleHerdrErrorFrame(
        JSON.stringify({ type: "herdr_error", message: "boom" }),
      ),
      true,
    );
    await ctx.settle(20);
    ok(apiCalls.includes("/api/session/close"));
    ok(apiCalls.includes("/api/session/launch"));
    equal(state.sessionBackend, "builtin");

    // pending offer dedupes a second frame while the first is settling
    equal(
      backend.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error" })),
      true,
    );
  });

  it("herdr_error declined keeps the pin, disabled builtin never launches", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();

    // declined offer: the broken session still closes but the pin stays
    const state = {
      session: "work",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: true, "external-herdr": true },
    };
    const apiCalls = [];
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async (url) => {
        apiCalls.push(url);
        return {};
      },
      confirmFn: async () => false,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: () => {},
    });
    equal(
      backend.handleHerdrErrorFrame(
        JSON.stringify({ type: "herdr_error", backend: "external-herdr" }),
      ),
      true,
    );
    await ctx.settle(20);
    equal(state.sessionBackend, "external-herdr");
    ok(apiCalls.includes("/api/session/close"), "broken session closed");
    ok(!apiCalls.includes("/api/session/launch"), "declined offer never launches");

    // builtin disabled: no offer at all
    const state2 = {
      session: "work",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: false, "external-herdr": true },
    };
    const apiCalls2 = [];
    const backend2 = ctx.HerdrMobileBackendModule.create({
      state: state2,
      api: async (url) => {
        apiCalls2.push(url);
        return {};
      },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: () => {},
    });
    equal(
      backend2.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error" })),
      true,
    );
    await ctx.settle(20);
    equal(state2.sessionBackend, "external-herdr");
    ok(!apiCalls2.includes("/api/session/launch"), "disabled builtin never launched");
  });

  it("currentSessionBackend normalizes legacy pins and mode fallbacks", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const make = (state) =>
      ctx.HerdrMobileBackendModule.create({
        state,
        api: async () => ({}),
        confirmFn: async () => true,
        localStorage: ctx.localStorage,
        refresh: () => {},
        getMobileEvents: () => null,
        readSessionBackend: () => "",
        writeSessionBackend: () => {},
      });

    // legacy "external" pin normalizes to external-herdr
    equal(make({ sessionBackend: "external" }).currentSessionBackend(), "external-herdr");
    equal(make({ sessionBackend: "builtin" }).currentSessionBackend(), "builtin");
    equal(
      make({ sessionBackend: "external-herdr" }).currentSessionBackend(),
      "external-herdr",
    );
    // empty pin falls back to the server mode
    equal(
      make({ sessionBackend: "", backendMode: "external" }).currentSessionBackend(),
      "external-herdr",
    );
    equal(
      make({ sessionBackend: "", backendMode: "builtin" }).currentSessionBackend(),
      "builtin",
    );
    // unknown everything yields the empty string
    equal(make({ sessionBackend: "", backendMode: "" }).currentSessionBackend(), "");
  });

  it("syncSessionBackendFromServer retargets only a disabled pin", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    // events stub with the real method names the module calls
    const events = {
      closed: 0,
      scheduled: 0,
      closeEventWs() {
        this.closed += 1;
      },
      scheduleEventReconnect() {
        this.scheduled += 1;
      },
    };
    const written = [];
    const state = {
      session: "s3",
      backendMode: "builtin",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: true, "external-herdr": false },
      serverDefaultBackend: "builtin",
    };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async () => ({}),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => events,
      readSessionBackend: () => "",
      writeSessionBackend: (session, value) => written.push([session, value]),
    });

    // disabled pin retargets to the server default and cycles events
    backend.syncSessionBackendFromServer();
    equal(state.sessionBackend, "builtin");
    ok(written.some(([, value]) => value === "builtin"));
    equal(events.closed, 1);
    equal(events.scheduled, 1);

    // enabled pin stays
    state.sessionBackend = "builtin";
    backend.syncSessionBackendFromServer();
    equal(state.sessionBackend, "builtin");

    // empty pin never retargets
    state.sessionBackend = "";
    backend.syncSessionBackendFromServer();
    equal(state.sessionBackend, "");

    // no events module: cycle is skipped without crashing
    const bareState = {
      session: "s4",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: true, "external-herdr": false },
      serverDefaultBackend: "external-herdr",
    };
    const bareBackend = ctx.HerdrMobileBackendModule.create({
      state: bareState,
      api: async () => ({}),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "",
      writeSessionBackend: () => {},
    });
    bareBackend.syncSessionBackendFromServer();
    // builtin is still enabled, so the fallback picks it even though the
    // server default is the disabled external backend
    equal(bareState.sessionBackend, "builtin");

    // builtin disabled too: falls back to whichever remains enabled
    const allOff = {
      session: "s5",
      sessionBackend: "builtin",
      backendsEnabled: { builtin: false, "external-herdr": false },
      serverDefaultBackend: null,
    };
    const allOffBackend = ctx.HerdrMobileBackendModule.create({
      state: allOff,
      api: async () => ({}),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => events,
      readSessionBackend: () => "",
      writeSessionBackend: () => {},
    });
    allOffBackend.syncSessionBackendFromServer();
    equal(allOff.sessionBackend, "external-herdr");
  });

  it("handleServerSettingsChanged ignores frames without enabled backends", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const state = {
      sessionBackend: "builtin",
      backendsEnabled: { builtin: true, "external-herdr": true },
      serverDefaultBackend: "builtin",
    };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api: async () => ({}),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => null,
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });

    // no enabled_backends field: nothing changes
    backend.handleServerSettingsChanged({});
    equal(state.backendsEnabled.builtin, true);

    // real frame updates enablement and the default
    backend.handleServerSettingsChanged({
      enabled_backends: { builtin: false, "external-herdr": true },
      default_backend: "external-herdr",
    });
    equal(state.backendsEnabled.builtin, false);
    equal(state.backendsEnabled["external-herdr"], true);
    equal(state.serverDefaultBackend, "external-herdr");
    equal(state.sessionBackend, "external-herdr");
  });
});