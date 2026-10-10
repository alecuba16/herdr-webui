import { describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";
import vm from "node:vm";

function element(id = "") {
  const classes = new Set();
  return {
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
    innerHTML: "",
    open: false,
    textContent: "",
    clientWidth: 360,
    clientHeight: 520,
    appendChild() {},
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
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    remove() {},
    replaceWith() {},
    parentNode: null,
  };
}

function context(pathname = "/", options = {}) {
  const elements = new Map();
  const localStorage = new Map();
  const historyCalls = [];
  const terminalStats = { disposed: 0, linkDisposed: 0, linksRegistered: 0, opened: 0 };
  const requests = [];
  const sockets = [];
  const timers = [];
  const listeners = {};
  let timerSeq = 0;
  const navButtons = ["home", "search", "terminal", "git", "files", "more"].map(
    (screen) => Object.assign(element(), { dataset: { screen } }),
  );
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  // The mobile app now uses a styled confirm sheet (mobileConfirm) instead
  // of window.confirm. Simulate the user tapping Confirm/Cancel: when the
  // sheet is shown, auto-resolve it with the injected confirm stub's answer
  // so the real promise path runs while tests keep their confirm semantics.
  const confirmSheet = element("mobileConfirmSheet");
  let confirmSheetShown = false;
  Object.defineProperty(confirmSheet, "hidden", {
    configurable: true,
    get: () => !confirmSheetShown,
    set: (value) => {
      confirmSheetShown = !value;
      if (confirmSheetShown) {
        // Live lookup: tests may swap ctx.confirm after context creation.
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
      createElement: () => element(),
      getElementById: getElement,
      querySelector: () => null,
      querySelectorAll: (selector) =>
        selector === ".mobile-nav button" ? navButtons : [],
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
      pushState(_state, _title, path) {
        historyCalls.push({ type: "push", path });
        // Real browsers update location on pushState; mirror that so
        // parseRoute() inside the refresh flows reads the pushed URL.
        if (typeof path === "string") locationRef.pathname = path;
      },
      replaceState(_state, _title, path) {
        historyCalls.push({ type: "replace", path });
        if (typeof path === "string") locationRef.pathname = path;
      },
      calls: historyCalls,
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
        this.scrolledToLine = null;
        this.scrolledToBottom = false;
        this._atBottom = true;
        this.onScrollCallback = null;
        ctx.lastTerminal = this;
      }
      onData() {}
      onScroll(callback) {
        this.onScrollCallback = callback;
      }
      open() {
        terminalStats.opened += 1;
      }
      resize() {}
      registerLinkProvider() {
        terminalStats.linksRegistered += 1;
        this.linksEnabled = true;
        return {
          dispose() {
            terminalStats.linkDisposed += 1;
          },
        };
      }
      write(data, callback) {
        this.writes.push(data);
        if (callback) callback();
      }
      usesNormalBuffer() {
        return true;
      }
      atBottom() {
        if (typeof ctx.terminalAtBottomOverride === "boolean") return ctx.terminalAtBottomOverride;
        return this._atBottom;
      }
      scrollLines(lines) {
        this.scrolledLines = lines;
        this._atBottom = false;
      }
      scrollToLine(line) {
        this.scrolledToLine = line;
      }
      scrollToBottom() {
        this.scrolledToBottom = true;
        this._atBottom = true;
        ctx.terminalAtBottomOverride = true;
        this.buffer.active.viewportY = this.buffer.active.baseY;
      }
      focus() {}
      clear() {}
      dispose() {
        terminalStats.disposed += 1;
        if (this.linksEnabled) terminalStats.linkDisposed += 1;
      }
      destroy() {
        terminalStats.disposed += 1;
        if (this.linksEnabled) terminalStats.linkDisposed += 1;
      }
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
      if (url === "/api/server-settings")
        return {
          ok: true,
          status: 200,
          json: async () => options.serverSettings || {},
        };
      if (url === "/api/tabs" && opt.method === "POST")
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { tab: { tab_id: "w1:t3" } } }),
        };
      if (String(url).startsWith("/api/file-browser/tree") && url.includes("q=alpha"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            path: "",
            entries: [
              { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
              { kind: "dir", name: "beta", path: "src/beta" },
            ],
            truncated: true,
            git_status: null,
          }),
        };
      if (String(url).startsWith("/api/file-browser/content-search"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [],
            truncated: false,
            total_files: 0,
            total_matches: 0,
          }),
        };
      if (String(url).startsWith("/api/git-ui/status"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            branch: "feature/mobile",
            state: "dirty",
            conflicted: [],
            staged: ["src/staged.js"],
            unstaged: ["src/mobile.js"],
            untracked: [],
          }),
        };
      if (String(url).startsWith("/api/git-ui/branches"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            local: [{ name: "main", current: true, remote: false }, { name: "feature/mobile", current: false, remote: false }],
            remote: [{ name: "origin/main", current: false, remote: true }],
            branches: [
              { name: "main", current: true, remote: false },
              { name: "feature/mobile", current: false, remote: false },
              { name: "origin/main", current: false, remote: true },
            ],
          }),
        };
      if (String(url).startsWith("/api/git-ui/stage") || String(url).startsWith("/api/git-ui/unstage") || String(url).startsWith("/api/git-ui/discard"))
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (String(url).startsWith("/api/git-ui/switch"))
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (String(url).startsWith("/api/git-ui/diff"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [
              {
                path: "src/mobile.js",
                additions: 1,
                deletions: 1,
                chunks: [
                  {
                    header: "@@ -1 +1 @@",
                    lines: [
                      { line_type: "delete", content: "old" },
                      { line_type: "add", content: "new" },
                    ],
                  },
                ],
              },
            ],
          }),
        };
      const optionValue = (key, fallback) => {
        const value = options[key];
        return typeof value === "function"
          ? value({ url, opt, requests })
          : value === undefined
            ? fallback
            : value;
      };
      if (url === "/api/sessions")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("sessionsResponse", {
              sessions: [
                { name: "default", backend: "builtin", backend_label: "built-in", running: true },
                { name: "revolut", backend: "builtin", backend_label: "built-in", running: false },
              ],
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
          json: async () => optionValue("sessionMutation", { ok: true, pid: 4242 }),
        };
      if (url === "/api/session/cleanup")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("sessionCleanup", {
              ok: true,
              removed: ["revolut"],
              removed_count: 1,
              kept_running_count: 0,
            }),
        };
      if (url === "/api/recent-workspaces" && opt.method === "POST")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              workspace: { workspace_id: "w1" },
              tab: { tab_id: "w1:t1" },
              root_pane: { pane_id: "w1:p1" },
            },
          }),
        };
      if (
        String(url).startsWith("/api/recent-workspaces") &&
        (!opt.method || opt.method === "GET")
      )
        return {
          ok: true,
          status: 200,
          json: async () => optionValue("recentWorkspaces", { recent: [] }),
        };
      // Single-request bootstrap: assemble the snapshot from the same
      // optionValue fixtures the legacy endpoints use, plus the wrapper's
      // bootstrap-only fields (per-workspace worktree_results, drag order).
      if (url === "/api/session-snapshot")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              snapshot: {
                workspaces: optionValue("workspaces", [
                  { workspace_id: "w1", label: "alpha", pane_count: 1, cwd: "/tmp/alpha" },
                ]),
                tabs: optionValue("tabs", [
                  { workspace_id: "w1", tab_id: "w1:t1", number: 1 },
                  { workspace_id: "w1", tab_id: "w1:t2", number: 2 },
                ]),
                panes: optionValue("panes", [
                  { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
                  { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
                ]).map((pane) => ({ workspace_id: "w1", ...pane })),
                layouts: [],
                agents: optionValue("agents", [
                  {
                    workspace_id: "w1",
                    tab_id: "w1:t1",
                    pane_id: "w1:p1",
                    terminal_id: "term1",
                    agent_status: "done",
                    name: "done-agent",
                  },
                  {
                    workspace_id: "w1",
                    tab_id: "w1:t2",
                    pane_id: "w1:p2",
                    terminal_id: "term2",
                    agent_status: "blocked",
                    name: "blocked-agent",
                  },
                  {
                    workspace_id: "w1",
                    tab_id: "w1:t2",
                    pane_id: "w1:p2",
                    terminal_id: "term2",
                    agent_status: "working",
                    name: "working-agent",
                  },
                ]),
              },
              worktree_results: [
                {
                  result: {
                    source: { source_workspace_id: "w1", repo_name: "alpha" },
                    worktrees: [
                      {
                        label: "alpha",
                        branch: "feature/mobile",
                        path: "/tmp/alpha/mobile-worktree",
                        is_linked_worktree: true,
                        last_commit_at: "2026-07-21T10:00:00Z",
                      },
                    ],
                  },
                },
              ],
              workspace_order: [],
            },
          }),
        };
      // Tab close has its own optional response so tests can simulate the
      // server rejecting a close (not-found race, auth, backend error)
      // without touching the shared fallback.
      if (String(url).endsWith("/close"))
        return {
          ok: !optionValue("closeError", null),
          status: optionValue("closeError", null) ? 502 : 200,
          json: async () =>
            optionValue("closeError", null)
              ? { error: optionValue("closeError", null) }
              : { result: {} },
        };
      const result = url.includes("workspaces")
        ? {
            workspaces: optionValue("workspaces", [
              { workspace_id: "w1", label: "alpha", pane_count: 1, cwd: "/tmp/alpha" },
            ]),
          }
        : url.includes("worktrees")
          ? {
              source: { source_workspace_id: "w1", repo_name: "alpha" },
              worktrees: [
                {
                  label: "alpha",
                  branch: "feature/mobile",
                  path: "/tmp/alpha/mobile-worktree",
                  is_linked_worktree: true,
                  last_commit_at: "2026-07-21T10:00:00Z",
                },
              ],
            }
          : url.includes("tabs")
            ? {
                tabs: optionValue("tabs", [
                  { workspace_id: "w1", tab_id: "w1:t1", number: 1 },
                  { workspace_id: "w1", tab_id: "w1:t2", number: 2 },
                ]),
              }
            : url.includes("panes")
              ? {
                  panes: optionValue("panes", [
                    { tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
                    { tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
                  ]),
                }
              : {
                  agents: optionValue("agents", [
                    {
                      workspace_id: "w1",
                      tab_id: "w1:t1",
                      pane_id: "w1:p1",
                      terminal_id: "term1",
                      agent_status: "done",
                      name: "done-agent",
                    },
                    {
                      workspace_id: "w1",
                      tab_id: "w1:t2",
                      pane_id: "w1:p2",
                      terminal_id: "term2",
                      agent_status: "blocked",
                      name: "blocked-agent",
                    },
                    {
                      workspace_id: "w1",
                      tab_id: "w1:t2",
                      pane_id: "w1:p2",
                      terminal_id: "term2",
                      agent_status: "working",
                      name: "working-agent",
                    },
                  ]),
                };
      return { ok: true, status: 200, json: async () => ({ result }) };
    },
  };
  ctx.HerdrTerminalRenderer = {
    create: async (_target, rendererOptions = {}) => {
      const term = new ctx.Terminal();
      terminalStats.opened += 1;
      if (rendererOptions.links !== false) {
        terminalStats.linksRegistered += 1;
        term.linksEnabled = true;
      }
      return term;
    },
  };
  ctx.terminalStats = terminalStats;
  ctx.requests = requests;
  ctx.sockets = sockets;
  ctx.navButtons = navButtons;
  ctx.pendingTimers = timers;
  ctx.flushTimers = async () => {
    const due = timers.splice(0).filter((timer) => !timer.cleared);
    for (const timer of due) await timer.callback();
  };
  ctx.settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };
  ctx.dispatchDocumentEvent = (event) => {
    for (const listener of listeners[event] || []) listener();
  };
  ctx.dispatchDocumentPointerEvent = (event, pointerEvent) => {
    for (const listener of listeners[event] || []) listener(pointerEvent);
  };
  ctx.documentListeners = () => listeners;
  // window.addEventListener is how app.js registers popstate/resize; record
  // those listeners so tests can drive history navigation. innerWidth/
  // innerHeight back the Keys fab drag clamp math.
  ctx.window = Object.assign(ctx, {
    matchMedia: () => ({ matches: false }),
    innerWidth: 390,
    innerHeight: 844,
    addEventListener(event, listener) {
      (listeners[event] || (listeners[event] = [])).push(listener);
    },
  });
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

describe("mobile bundle load", () => {
  const source =
    readFileSync(new URL("./shared/options.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/core.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/http.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/attention.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/actions.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/file_icons.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/line_context.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/file_content_search.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/core.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/attention.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/directory_picker.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/file_browser.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/search.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/git.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/composer.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/sessions.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/events.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/screens.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/panels.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/workmeta.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/theme.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/actions.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/backend.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");


  it("keeps hidden sheets off screen despite their display rules", () => {
    // The confirm sheet stays mounted in the shell with [hidden]; without a
    // specificity guard the .mobile-sheet { display: flex } rule would beat
    // the browser default [hidden] { display: none } and the idle sheet
    // (handle + mobile-sheet-actions Cancel/Confirm row) would render pinned
    // to the bottom of every screen.
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(mobileCss, /\.mobile-sheet\[hidden\],[\s\S]*?\.mobile-sheet-backdrop\[hidden\] \{[\s\S]*?display: none;/);
  });

  it("clamps the mobile app grid column so wide terminal content cannot stretch the shell", () => {
    // Regression (observed live at a 320px viewport): .mobile-app declared
    // only grid-template-rows, so its single implicit column was sized
    // "auto" (max-content). The terminal's .term-grid carries
    // min-width: max-content, and once a terminal grid was wider than the
    // viewport the implicit auto track (and with it the header/nav/keybar)
    // stretched to the grid width, pushing the nav offscreen. The explicit
    // minmax(0, 1fr) column clamps the track to the viewport so the
    // terminal scrolls inside its own shell instead.
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(
      mobileCss,
      /\.mobile-app \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto auto;/,
    );
  });

  it("fits the mobile terminal to the real shell width on narrow viewports", () => {
    // Regression (observed live at 320px): the shared gridSize default floor
    // of 40 cols needs ~336px, wider than the ~304px of shell content at a
    // 320px viewport, so the terminal rendered wider than its shell and
    // forced horizontal overflow. The mobile size() passes a lower floor so
    // the fit uses the real available width.
    const terminalSource = readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8");
    match(terminalSource, /minCols: 20,/);
    // Guard against the 40-col floor sneaking back into the mobile fit.
    const sizeBody = terminalSource.slice(
      terminalSource.indexOf("function size()"),
      terminalSource.indexOf("async function connect()"),
    );
    ok(sizeBody.length > 0, "mobile size() body found");
    ok(!/minCols: 40/.test(sizeBody), "mobile terminal must not clamp cols to 40");
  });

  it("has mobile CSS parity for CodeMirror Zed-like editor enhancements", () => {
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(mobileCss, /\.cm-foldGutter/);
    match(mobileCss, /\.cm-foldPlaceholder/);
    match(mobileCss, /\.cm-activeLineGutter/);
    match(mobileCss, /\.cm-matchingBracket/);
    match(mobileCss, /\.cm-nonmatchingBracket/);
    match(mobileCss, /\.cm-editor \.cm-cursor,[\s\S]*?border-left: 2px solid var\(--editor-caret\)/);
    match(mobileCss, /--editor-caret:/);
    match(mobileCss, /--editor-caret-dim:/);
    match(mobileCss, /\.cm-selectionBackground/);
    match(mobileCss, /--accent-1:/);
    match(mobileCss, /--accent-2:/);
    match(mobileCss, /--accent-2-border:/);
    match(mobileCss, /--accent-soft:/);
    match(mobileCss, /--accent-border:/);
  });

  it("loads mobile shell without browser automation", () => {
    const ctx = context();
    doesNotThrow(() => vm.runInContext(source, ctx));
    ok(ctx.HerdrMobile);
  });

  it("keeps mobile terminal input gated until the terminal is tapped", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const gate = ctx.HerdrMobileCore.createTerminalInputGate();
    equal(gate(), true);
    gate.enable();
    equal(gate(), false);
  });

  it("emits the full keyboard guard set from the real inputAttrs helper", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const attrs = ctx.HerdrMobileCore.inputAttrs();
    // Full guard set: Android autocorrect/grammar must never engage on any
    // mobile text input. If someone trims a guard from mobile core.js this
    // fails even though per-module tests stub inputAttrs and stay green.
    match(attrs, /autocomplete="off"/);
    match(attrs, /autocorrect="off"/);
    match(attrs, /autocapitalize="none"/);
    match(attrs, /spellcheck="false"/);
    match(attrs, /writingsuggestions="false"/);
    match(attrs, /translate="no"/);
    // No enterkeyhint without an argument.
    ok(!attrs.includes("enterkeyhint"));
    // With one, it is escaped and appended.
    const withHint = ctx.HerdrMobileCore.inputAttrs("send");
    match(withHint, /enterkeyhint="send"/);
    ok(withHint.includes(attrs));
    const escaped = ctx.HerdrMobileCore.inputAttrs('"><img onerror=alert(1)>');
    ok(!escaped.includes('enterkeyhint="\"><img'), "enterkeyhint must be escaped");
  });

  it("renders mobile task hub and action search", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("mobile-task-hub"));
    ok(html.includes("Open workspace or worktree"));
    // The task-hub search card was removed: it duplicated the nav Search
    // tab (both opened the search sheet). The nav tab stays the only path
    // from Home.
    ok(!html.includes("mobile-task-card\" onclick=\"HerdrMobile.runAction('search')"), "task hub must not duplicate nav Search");
    ok(!html.includes("Temporary terminal"));
    ok(source.includes("function mobileActionCandidates(query)"));
    ok(source.includes("HerdrActionRegistry.candidates"));
    ok(source.includes("HerdrMobileSearch.openAction"));
  });

  it("filters mobile action search results at runtime", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("search");
    let html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("Open workspace or worktree"));
    ok(!html.includes("Temporary terminal"), "temp terminal action deleted with the overlay machinery");

    const input = ctx.document.getElementById("mobileSearchInput");
    input.value = "settings";
    input.oninput();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("Settings"));
    ok(!html.includes("Temporary terminal"));
  });

  it("restores all agents after rendering Home attention-only agents", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    ctx.HerdrMobile.showScreen("home");
    const homeHtml = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(homeHtml.includes("blocked-agent"));
    ok(!homeHtml.includes("working-agent"));

    ctx.HerdrMobile.showScreen("agents");
    const agentsHtml = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(agentsHtml.includes("blocked-agent"));
    ok(agentsHtml.includes("working-agent"));
  });

  it("mobile agent row panel token hides with one panel, shows name or number with several", async () => {
    const ctx = context("/session/default/workspace/w1/tab/w1:t1/pane/w1:p1", {
      tabs: [
        { workspace_id: "w1", tab_id: "w1:t1", number: 1, label: "Shell" },
        { workspace_id: "w1", tab_id: "w1:t2", number: 2, label: "Shell" },
        { workspace_id: "w1", tab_id: "w1:t3", number: 3, label: "build" },
        { workspace_id: "w2", tab_id: "w2:t1", number: 1, label: "Shell" },
      ],
      workspaces: [
        { workspace_id: "w1", label: "alpha", pane_count: 1, cwd: "/tmp/alpha" },
        { workspace_id: "w2", label: "beta", pane_count: 1, cwd: "/tmp/beta" },
      ],
      agents: () => [
        { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1", agent_status: "idle", name: "a1" },
        { workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p3", terminal_id: "term3", agent_status: "idle", name: "a2" },
        { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", terminal_id: "term4", agent_status: "idle", name: "a3" },
      ],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    ctx.HerdrMobile.showScreen("agents");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    // w1 has 3 panels: default labels become #1/#2/#3, custom label stays "build".
    ok(html.includes("#1"), "default panel label shows number");
    ok(html.includes("› build"), "custom panel label shows name");
    // w2 has a single panel: no panel token at all in its row title.
    ok(!/>beta ›/.test(html), "single-panel row hides panel token");
  });

  it("routes mobile backend headers and sockets from selected backend branches", async () => {
    for (const [storedBackend, expected] of [["external", "external-herdr"], ["external-herdr", "external-herdr"], ["builtin", "builtin"]]) {
      const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
      ctx.localStorage.setItem("herdr-session-backend:default", storedBackend);
      vm.runInContext(source, ctx);
      await ctx.HerdrMobile.refresh();
      // The snapshot bootstrap carries the backend header for the whole
      // refresh; the legacy per-endpoint calls are the fallback path.
      const bootstrapRequest = ctx.requests.find(
        (request) => request.url === "/api/session-snapshot" || request.url === "/api/workspaces",
      );
      equal(bootstrapRequest.opt.headers["x-herdr-backend"], expected);
      ok(ctx.lastSocket.url.includes(`backend=${encodeURIComponent(expected)}`));
    }
    match(source, /state\.backendMode === "external" \|\| state\.backendMode === "external-herdr"/);
    match(source, /state\.backendMode === "builtin"/);
  });

  it("shows a backend badge with distinct herdr and built-in colors in the mobile header", async () => {
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(source, /id="mobileBackendBadge"/);
    match(source, /function syncBackendBadge\(\)/);
    match(source, /badge\.className = `mobile-backend-badge \$\{sessionBackendClass\(backend\)\}`/);
    match(mobileCss, /\.mobile-context \.mobile-backend-badge\.backend-builtin \{[\s\S]*?color: var\(--backend-builtin\)/);
    match(mobileCss, /\.mobile-context \.mobile-backend-badge\.backend-herdr \{[\s\S]*?color: var\(--backend-herdr\)/);
    // Herdr keeps a distinct mauve hue; built-in stays in the accent family.
    match(mobileCss, /--backend-builtin: var\(--accent\)/);
    match(mobileCss, /--backend-herdr: #cba6f7/);
    match(mobileCss, /--backend-herdr: #8839ef/);

    // The badge switches label and class when the backend changes. The fallback
    // to built-in on refresh is covered elsewhere; here we exercise the badge
    // itself without the sessions-gating (the mock /api/sessions reports no
    // herdr install, so refresh alone would always land on built-in).
    // The badge also names the active session and opens the sessions screen.
    match(source, /<button type="button" id="mobileBackendBadge"/);
    match(source, /badge\.onclick = \(\) => showScreen\("sessions"\)/);
    for (const [storedBackend, label, cls] of [["builtin", "built-in", "backend-builtin"], ["external-herdr", "Herdr", "backend-herdr"]]) {
      const ctx = context("/session/default/workspace/w1");
      ctx.localStorage.setItem("herdr-session-backend:default", storedBackend);
      vm.runInContext(source, ctx);
      ctx.HerdrMobile.showScreen("home");
      const badge = ctx.document.getElementById("mobileBackendBadge");
      equal(badge.textContent, `${label} · default`);
      ok(badge.className.includes(cls));
      ok(typeof badge.onclick === "function");
    }
  });

  it("renders a sessions screen listing known sessions and the active target", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("sessions");
    await ctx.settle();
    await ctx.flushTimers();
    const screen = ctx.document.getElementById("mobileScreen");
    ok(screen.innerHTML.includes("Sessions"));
    ok(screen.innerHTML.includes("Current target: default · built-in"));
    ok(screen.innerHTML.includes("revolut"));
    ok(screen.innerHTML.includes("New built-in"));
    // herdr is compatible in the mock, so the Herdr offer is visible.
    ok(screen.innerHTML.includes("New Herdr"));
  });

  it("creates a new built-in session from the sessions screen and switches to it", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.updateSessionField("sessionNameInput", "revolut");
    await ctx.HerdrMobile.newSession("builtin");
    const launch = ctx.requests.find((r) => r.url === "/api/session/launch");
    ok(launch, "session launch request missing");
    equal(launch.opt.body, JSON.stringify({ session: "revolut", backend: "builtin" }));
    // The browser target switched: header stamping and route follow.
    const refreshRequest = ctx.requests.find(
      (r) => r.url === "/api/session-snapshot" || r.url === "/api/workspaces",
    );
    ok(refreshRequest, "refresh after switch missing");
    equal(refreshRequest.opt.headers["x-herdr-backend"], "builtin");
    ok(ctx.history.calls.some((c) => c.path === "/session/revolut"));
  });

  it("switches the browser target when tapping another session row", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.selectSession("revolut", "builtin");
    ok(ctx.history.calls.some((c) => c.path === "/session/revolut"));
    // The per-session pin follows the switched-to session (revolut), not the
    // one we switched from (default).
    equal(ctx.localStorage.getItem("herdr-session-backend:revolut"), "builtin");
  });

  it("closes the current session from the sessions screen and retargets the default", async () => {
    const ctx = context("/session/revolut");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.closeSession();
    const close = ctx.requests.find((r) => r.url === "/api/session/close");
    ok(close, "session close request missing");
    equal(close.opt.body, JSON.stringify({ session: "revolut", backend: "builtin" }));
    // Closing a non-default session retargets the browser to the default
    // session with the server's default backend; the closed session's
    // stored state is gone (closed means closed).
    equal(ctx.HerdrMobile.currentSessionBackend(), "builtin");
    equal(ctx.location.pathname, "/session/default");
    equal(ctx.localStorage.getItem("herdr-session-state:builtin:revolut"), null);
  });

  it("rejects a new session without a name and surfaces the error inline", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("sessions");
    await ctx.settle();
    await ctx.flushTimers();
    ctx.HerdrMobile.updateSessionField("sessionNameInput", "  ");
    await ctx.HerdrMobile.newSession("builtin");
    const screen = ctx.document.getElementById("mobileScreen");
    ok(screen.innerHTML.includes("Session name is required."));
    ok(!ctx.requests.some((r) => r.url === "/api/session/launch"));
  });

  it("cleans up stale closed sessions from the sessions screen", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("sessions");
    await ctx.settle();
    await ctx.flushTimers();
    const screen = ctx.document.getElementById("mobileScreen");
    // The mock lists revolut as offline built-in: exactly one stale row, so
    // the summary counts it and the button is enabled.
    ok(screen.innerHTML.includes("Clean up closed sessions (1)"));
    ok(!screen.innerHTML.includes("Clean up closed sessions (0)"));
    await ctx.HerdrMobile.cleanupSessions();
    const cleanup = ctx.requests.find((r) => r.url === "/api/session/cleanup");
    ok(cleanup, "cleanup request missing");
    equal(cleanup.opt.method, "POST");
    equal(cleanup.opt.body, JSON.stringify({ backend: "builtin" }));
    // The result lands in the screen before the delayed list refresh clears
    // the message (refreshSessions reloads the list).
    ok(
      ctx.document
        .getElementById("mobileScreen")
        .innerHTML.includes("Removed 1 closed session: revolut"),
      "cleanup result message missing from sessions screen",
    );
    // The removed session's stored state is forgotten (closed means closed).
    equal(ctx.localStorage.getItem("herdr-session-state:builtin:revolut"), null);
  });

  it("reports nothing to clean up when no stale sessions exist", async () => {
    const ctx = context("/session/default", {
      sessionsResponse: () => ({
        sessions: [
          { name: "default", backend: "builtin", backend_label: "built-in", running: true },
        ],
        herdr_available: true,
        herdr_compatible: true,
        default_backend: "builtin",
        enabled_backends: { builtin: true, "external-herdr": true },
      }),
      sessionCleanup: { ok: true, removed: [], removed_count: 0, kept_running_count: 0 },
    });
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("sessions");
    await ctx.settle();
    await ctx.flushTimers();
    const screen = ctx.document.getElementById("mobileScreen");
    ok(screen.innerHTML.includes("Clean up closed sessions"));
    ok(!screen.innerHTML.includes("Clean up closed sessions ("));
    await ctx.HerdrMobile.cleanupSessions();
    ok(
      ctx.document
        .getElementById("mobileScreen")
        .innerHTML.includes("No stale built-in sessions found."),
      "empty cleanup message missing from sessions screen",
    );
  });

  it("skips the cleanup request when the user cancels the confirm", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    ctx.confirm = () => false;
    await ctx.HerdrMobile.cleanupSessions();
    ok(!ctx.requests.some((r) => r.url === "/api/session/cleanup"));
  });



  it("coalesces mobile event socket refreshes and pauses reconnect while hidden", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    const before = ctx.requests.length;

    const eventSocket = ctx.sockets.find((socket) => String(socket.url).includes("/ws/events"));
    const event = { data: JSON.stringify({ event: { event: "workspace.updated" } }) };
    eventSocket.onmessage(event);
    eventSocket.onmessage(event);
    eventSocket.onmessage(event);

    equal(ctx.requests.length, before);
    equal(ctx.pendingTimers.filter((timer) => !timer.cleared).length, 1);
    await ctx.flushTimers();
    // One coalesced refresh = one snapshot bootstrap request. The legacy
    // fallback path needed six calls for the same data.
    equal(ctx.requests.length, before + 1);

    ctx.document.hidden = true;
    eventSocket.onclose();
    equal(ctx.pendingTimers.filter((timer) => !timer.cleared).length, 0);
    ctx.document.hidden = false;
    ctx.dispatchDocumentEvent("visibilitychange");
    equal(ctx.pendingTimers.filter((timer) => !timer.cleared).length, 2);
  });

  it("sticks to the legacy refresh path after a failed snapshot bootstrap", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      if (String(url) === "/api/session-snapshot")
        return { ok: false, status: 500, json: async () => ({ error: "down" }) };
      return originalFetch(url, opt);
    };
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    // The failed request disabled the bootstrap; the refresh still landed
    // through the legacy multi-call path (selection restored from route).
    ok(ctx.requests.some((r) => r.url === "/api/workspaces"));
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t1");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p1");

    // Sticky-off: the next refresh skips the snapshot call entirely.
    const before = ctx.requests.length;
    await ctx.HerdrMobile.refresh();
    equal(
      ctx.requests.slice(before).filter((r) => r.url === "/api/session-snapshot").length,
      0,
    );
    ok(ctx.requests.slice(before).some((r) => r.url === "/api/workspaces"));
  });

  it("applies a flat snapshot envelope and unstamped worktree entries", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    const originalFetch = ctx.fetch;
    // Record the snapshot call too: the harness only records inside its
    // default fetch, and this override answers the snapshot directly.
    const urls = [];
    ctx.fetch = async (url, opt = {}) => {
      const text = String(url);
      urls.push(text);
      // Flat result.* shape plus a worktree entry with no source stamp:
      // the current-workspace lookup misses, and the fallback to the
      // first non-null entry must still show rows.
      if (text === "/api/session-snapshot")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              workspaces: [
                { workspace_id: "w1", label: "alpha", pane_count: 1, cwd: "/tmp/alpha" },
              ],
              tabs: [{ workspace_id: "w1", tab_id: "w1:t1", number: 1 }],
              panes: [
                { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
              ],
              layouts: [],
              agents: [],
              worktree_results: [
                {
                  result: {
                    source: { repo_name: "alpha" },
                    worktrees: [
                      { label: "alpha", branch: "flat-shape", path: "/tmp/alpha/main" },
                    ],
                  },
                },
                null,
              ],
              workspace_order: ["w1"],
            },
          }),
        };
      return originalFetch(url, opt);
    };
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    // Flat envelope applied: selection restored, and neither the boot nor
    // the explicit refresh fell back to the legacy endpoints.
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t1");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p1");
    ok(
      !urls.some((url) => url.startsWith("/api/workspaces")),
      "flat snapshot must not fall back to legacy",
    );
    // The unstamped worktree entry became the source; the worktrees screen
    // renders its repo name and the fallback entry's row (title from the
    // worktree path basename).
    ctx.HerdrMobile.updateWorktreeField("worktreeDiscoverPath", "/tmp/alpha");
    ctx.HerdrMobile.showScreen("worktrees");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("alpha"), "fallback entry repo name rendered");
    ok(
      html.includes("<strong>main</strong>"),
      "fallback entry worktree row rendered",
    );
  });

  it("renders simplified mobile nav with drawer menu", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    match(source, /<button data-screen="home">Home<\/button>/);
    match(source, /<button data-screen="search">Search<\/button>/);
    match(source, /<button data-screen="terminal">Terminal<\/button>/);
    match(source, /<button data-screen="git">Git<\/button>/);
    match(source, /<button data-screen="files">Files<\/button>/);
    match(source, /<button data-screen="more" aria-haspopup="dialog">More<\/button>/);
    ok(!source.includes('data-screen="agents">Agents</button>'));
    // Keys left the nav: the floating Keys fab lives in the shell and is
    // only visible in the terminal view.
    ok(!source.includes('data-toggle="toolbar"'), "no toolbar toggler in the nav");
    match(source, /id="mobileKeysFab" class="mobile-keys-fab" hidden/);
    // Drawer shell, items, and edge-swipe wiring.
    match(source, /id="mobileDrawer" hidden role="dialog"/);
    match(source, /function renderDrawerItems\(\) \{/);
    match(source, /function bindDrawerEdgeSwipe\(\) \{/);
    // More button opens the drawer instead of switching screens.
    const moreButton = ctx.navButtons.find((button) => button.dataset.screen === "more");
    moreButton.onclick();
    equal(ctx.document.getElementById("mobileDrawer").hidden, false);
    equal(ctx.document.body.classList.contains("mobile-drawer-open"), true);
    ok(ctx.document.getElementById("mobileDrawerItems").innerHTML.includes("HerdrMobile.openDrawerTarget('worktrees')"));
    // Backdrop click closes the drawer.
    ctx.document.getElementById("mobileDrawerBackdrop").onclick();
    equal(ctx.document.getElementById("mobileDrawer").hidden, true);
    // Drawer targets route through showScreen and close the drawer first.
    doesNotThrow(() => ctx.HerdrMobile.openDrawerTarget("worktrees"));
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Worktrees"), "drawer target renders the worktrees screen");
    ctx.HerdrMobile.showScreen("search");
    equal(ctx.document.getElementById("mobileSearchSheet").hidden, false);
  });

  it("hides Search primary nav when header search is disabled", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ headerSearchEnabled: false }));

    vm.runInContext(source, ctx);

    const searchButton = ctx.navButtons.find((button) => button.dataset.screen === "search");
    equal(searchButton.hidden, true);
    equal(searchButton.disabled, true);
    ctx.document.getElementById("mobileSearchSheet").hidden = true;
    ctx.HerdrMobile.showScreen("search");
    equal(ctx.document.getElementById("mobileSearchSheet").hidden, true);
  });

  it("routes mobile task actions to worktree, create, search, and terminal flows", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    ctx.HerdrMobile.runAction("discover-worktrees");
    equal(ctx.HerdrMobile.currentScreen(), "worktrees");
    ok(ctx.requests.some((request) => String(request.url).startsWith("/api/worktrees")));
    {
      const html = ctx.document.getElementById("mobileScreen").innerHTML;
      ok(html.includes("Results"), "merged flow shows results after discovery");
      ok(html.includes("Open as workspace"), "results card offers opening the picked folder");
      ok(html.includes("mobile-worktree"), "discovered worktree row is listed");
      ok(!html.includes("Choose folder for "), "picker sheet is not open");
    }

    ctx.HerdrMobile.runAction("create-worktree");
    equal(ctx.HerdrMobile.currentScreen(), "worktrees");
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes("Create new worktree"));
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes("mobile-disclosure\" open"));

    ctx.HerdrMobile.runAction("search");
    equal(ctx.document.getElementById("mobileSearchSheet").hidden, false);

    const openedBefore = ctx.terminalStats.opened;
    ctx.HerdrMobile.runAction("terminal");
    equal(ctx.HerdrMobile.currentScreen(), "terminal");
    ok(ctx.terminalStats.opened >= openedBefore);
  });

  it("renders all secondary tools in the drawer while keeping direct routes available", () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);

    // More is a drawer, not a screen: opening it lists every secondary
    // tool and each item routes through openDrawerTarget (showScreen
    // under the hood). Git and Files were promoted to the primary nav, so
    // the drawer no longer lists them. Direct showScreen routes must
    // stay available too.
    const moreButton = ctx.navButtons.find((button) => button.dataset.screen === "more");
    moreButton.onclick();
    const items = ctx.document.getElementById("mobileDrawerItems").innerHTML;
    for (const screen of ["agents", "panels", "worktrees", "settings", "sessions"])
      ok(items.includes(`HerdrMobile.openDrawerTarget('${screen}')`), `${screen} drawer item present`);
    ok(!items.includes("HerdrMobile.openDrawerTarget('files')"), "files left the drawer for the nav");
    ok(!items.includes("HerdrMobile.openDrawerTarget('git')"), "git left the drawer for the nav");
    ctx.HerdrMobile.openDrawerTarget("worktrees");
    for (const screen of ["agents", "panels", "worktrees", "files", "git", "settings"])
      doesNotThrow(() => ctx.HerdrMobile.showScreen(screen));
  });

  it("filters mobile settings live without rerendering or losing focus", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("settings");

    const groups = [
      Object.assign(element("appearance"), { dataset: { settingsText: "appearance theme" } }),
      Object.assign(element("terminal"), { dataset: { settingsText: "terminal font links" } }),
    ];
    const empty = ctx.document.getElementById("mobileSettingsEmpty");
    const originalQuerySelectorAll = ctx.document.querySelectorAll;
    ctx.document.querySelectorAll = (selector) =>
      selector === ".mobile-settings-disclosure" ? groups : originalQuerySelectorAll(selector);

    ctx.HerdrMobile.setSettingsFilter("terminal");
    equal(groups[0].hidden, true);
    equal(groups[1].hidden, false);
    equal(groups[1].open, true);
    equal(empty.hidden, true);

    ctx.HerdrMobile.setSettingsFilter("no-match");
    equal(groups[0].hidden, true);
    equal(groups[1].hidden, true);
    equal(empty.hidden, false);
  });

  it("keeps mobile worktree creation progressive and settings filterable", () => {
    match(source, /Create new worktree/);
    match(source, /worktreeLoadingLabel/);
    match(source, /Discovering\.\.\./);
    match(source, /Opening\.\.\./);
    match(source, /Creating\.\.\./);
    match(source, /setLoading\(true, "Discovering worktrees\.\.\."\)/);
    match(source, /setLoading\(true, "Opening worktree\.\.\.", index\)/);
    match(source, /setLoading\(true, "Creating worktree\.\.\."\)/);
    match(source, /setWorktreeCreateExpanded/);
    match(source, /Filter settings/);
    match(source, /mobile-settings-disclosure/);
  });

  it("routes mobile HTTP and WebSocket requests to the selected backend", () => {
    const mobileSource = readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");
    const backendSource = readFileSync(new URL("./mobile/backend.js", import.meta.url), "utf8");
    // HTTP headers now live in the shared client; mobile pins the context
    // provider so every request carries the selected backend/session.
    match(mobileSource, /HerdrHttp\.configure\(\(\) => \(\{[\s\S]*?backend: currentSessionBackend\(\)/);
    match(mobileSource, /if \(globalThis\.HerdrHttp\) return globalThis\.HerdrHttp\.request\(url, opt\)/);
    match(mobileSource, /params\.push\("backend=" \+ encodeURIComponent\(currentSessionBackend\(\)\)\)/);
    match(mobileSource, /params\.join\("&"\)/);
    match(backendSource, /state\.backendMode = settings\.backend_mode/);
  });

  it("renders settings and worktrees screens without browser automation", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    doesNotThrow(() => ctx.HerdrMobile.showScreen("settings"));
    const settingsHtml = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(settingsHtml.includes("mobile-settings-group"));
    ok(settingsHtml.includes("Appearance"));
    ok(settingsHtml.includes("Layout"));
    ok(settingsHtml.includes("Terminal font"));
    ok(settingsHtml.includes("Terminal links"));
    ok(settingsHtml.includes("Terminal mouse reporting"));
    match(source, /stripTerminalQueryReplies\(data, terminalQueryReplyState\)/);
    ok(settingsHtml.includes("Line numbers"));
    ok(settingsHtml.includes("HerdrMobile.setTerminalFontFamily"));
    ok(settingsHtml.includes("HerdrMobile.setFileBrowserLineNumbers"));
    ok(settingsHtml.includes("HerdrMobile.setTerminalLinks"));
    ok(settingsHtml.includes("HerdrMobile.setTerminalMouseReporting"));
    equal(typeof ctx.HerdrMobile.setTerminalFontFamily, "function");
    equal(typeof ctx.HerdrMobile.setTerminalLinks, "function");
    equal(typeof ctx.HerdrMobile.setTerminalMouseReporting, "function");
    equal(typeof ctx.HerdrMobile.setFileBrowserLineNumbers, "function");
    equal(typeof ctx.HerdrMobile.applyTerminalFontFamily, "function");
    equal(typeof ctx.HerdrMobile.applyTerminalLinks, "function");
    doesNotThrow(() =>
      ctx.HerdrMobile.setTerminalFontFamily("Hack Nerd Font, monospace"),
    );
    doesNotThrow(() => ctx.HerdrMobile.setTerminalLinks(false));
    doesNotThrow(() => ctx.HerdrMobile.setTerminalMouseReporting(true));
    doesNotThrow(() => ctx.HerdrMobile.showScreen("worktrees"));
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Choose folder"));
    ok(html.includes("Find worktrees"));
    ok(!html.includes("Discover worktrees"), "old standalone discover group is gone");
    ok(!html.includes("Open existing"), "old open-existing group is gone");
    ok(!html.includes("Results"), "no results before discovery ran");
    doesNotThrow(() =>
      ctx.HerdrMobile.updateWorktreeField("worktreeBranch", "feature/mobile"),
    );
  });

  it("shows an applied badge that survives the settings re-render and later clears", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("settings");
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(!html.includes("settings-applied"), "no badge before any change");
    ok(html.includes('data-settings-id="fileBrowserLineNumbers"'));

    ctx.HerdrMobile.setFileBrowserLineNumbers(false);
    // refresh() chains several awaits (workspaces, tabs/panes/agents in
    // Promise.all) before the final render; settle until the badge lands.
    for (let i = 0; i < 40 && !ctx.document.getElementById("mobileScreen").innerHTML.includes("settings-applied"); i++)
      await ctx.settle(4);
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(
      html.includes("settings-applied"),
      "applied badge emitted on the changed row after re-render",
    );
    const badgeAt = html.indexOf("settings-applied");
    const rowAt = html.indexOf('data-settings-id="fileBrowserLineNumbers"');
    ok(
      badgeAt > rowAt && badgeAt - rowAt < 400,
      "badge sits inside the line-numbers row",
    );
    ok(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options"))
        .fileBrowserLineNumbers === false,
      "value persisted",
    );

    // The badge timer clears itself with one more refresh.
    await ctx.flushTimers();
    for (let i = 0; i < 40 && ctx.document.getElementById("mobileScreen").innerHTML.includes("settings-applied"); i++)
      await ctx.settle(4);
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(!html.includes("settings-applied"), "badge cleared after the timeout");
  });

  it("flashes the moved search order row instead of every row", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("settings");
    ctx.HerdrMobile.moveSearchSection("content", -1);
    for (let i = 0; i < 40 && !ctx.document.getElementById("mobileScreen").innerHTML.includes("settings-applied"); i++)
      await ctx.settle(4);
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    const badges = html.split('class="settings-applied"').length - 1;
    equal(badges, 1, "exactly one badge for the moved section");
    const badgeAt = html.indexOf("settings-applied");
    const contentAt = html.indexOf(">Content<");
    ok(
      badgeAt >= 0 &&
        contentAt >= 0 &&
        html
          .slice(badgeAt, contentAt)
          .includes("mobile-search-order-row") === false &&
        contentAt - badgeAt < 300,
      "badge sits on the content row",
    );
    const savedOrder = JSON.parse(
      ctx.localStorage.getItem("herdr-web-options"),
    ).searchSectionOrder;
    equal(savedOrder, "workspaces,content,files", "order persisted");
  });

  it("mobile search scope parity uses the shared helper, section order, chips, and load more (B5)", async () => {
    const ctx = context();
    // Custom order and disabled folders must behave identically to desktop.
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({
      searchSectionOrder: "content,files,workspaces",
      searchFoldersEnabled: false,
      searchWorkspacesEnabled: false,
    }));
    vm.runInContext(source, ctx);

    // The mobile screen must go through the shared HerdrWorkspaceSearch.settings()
    // helper, not a private copy of the option parsing.
    ok(source.includes("HerdrWorkspaceSearch.settings"), "uses shared settings helper");

    ctx.HerdrMobile.showScreen("search");
    const input = ctx.document.getElementById("mobileSearchInput");
    input.value = "alpha";
    input.oninput();
    ctx.HerdrMobileSearch.setPathKind("file");
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    let html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    // Section order parity: content before files before workspaces.
    const contentAt = html.indexOf("File content");
    const filesAt = html.indexOf("Files and folders");
    const actionsAt = html.indexOf("Actions");
    ok(contentAt >= 0 && filesAt > contentAt, `order: content(${contentAt}) then files(${filesAt})`);
    // Disabled scopes hide their sections and disable their chips.
    ok(!html.includes("Workspaces and agents"), "workspaces section hidden when disabled");
    ok(html.includes("disabled"), "folders chip disabled when searchFoldersEnabled=false");
    // Kind normalization falls back to file when folders are disabled.
    ok(html.includes("docs/alpha.txt"), "path results render through the shared helper");

    // Load more: truncated results show the button; tapping appends the next page.
    ok(html.includes("HerdrMobileSearch.loadMorePaths"), "load more button rendered when truncated");
    ok(html.includes("Load more files"), "load more label names the active kind");
    await ctx.HerdrMobileSearch.loadMorePaths();
    await ctx.settle();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    const occurrences = html.split("docs/alpha.txt").length - 1;
    ok(occurrences >= 2, `second page appended (occurrences=${occurrences})`);
  });

  it("mobile content search Load all matches refetches the truncated file (Tr1)", async () => {
    const ctx = context();
    const originalFetch = ctx.fetch;
    const fileRequests = [];
    // One truncated file first (the shared picker then renders the
    // "Load all matches" button), then a full file for the per-file
    // re-search that button triggers.
    ctx.fetch = async (url, opt = {}) => {
      const text = String(url);
      if (text.startsWith("/api/file-browser/content-search")) {
        if (text.includes("/file?")) {
          fileRequests.push(text);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              file: {
                path: "src/needle.txt",
                match_count: 6,
                truncated: false,
                chunks: [{ lines: [{ line_number: 1, html: "needle", matched: true }] }],
                matches: [{ id: "m1", line_number: 1, html: "needle" }],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ path: "src/needle.txt", match_count: 3, truncated: true, chunks: [] }],
            truncated: false,
            total_files: 1,
            total_matches: 3,
          }),
        };
      }
      return originalFetch(url, opt);
    };
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("search");
    const input = ctx.document.getElementById("mobileSearchInput");
    input.value = "needle";
    input.oninput();
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    let html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "truncated file renders the Load all matches button");

    await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("src/needle.txt"));
    await ctx.settle();
    equal(fileRequests.length, 1, "the button re-searches the single file");
    ok(fileRequests[0].includes("max_matches_per_file=500"), "the re-search lifts the per-file cap");
    ok(fileRequests[0].includes(encodeURIComponent("src/needle.txt")), "the re-search names the clicked file");
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(!html.includes("HerdrMobileSearchContent.loadFile"), "the untruncated entry drops the button");
  });

  it("mobile Load all matches shows the fetch error and drops stale late responses", async () => {
    const ctx = context();
    const originalFetch = ctx.fetch;
    let fileBehavior = "reject";
    let resolveLate = null;
    // The truncated file entry stays: an error or a stale response must
    // never swap in a newer-looking result for a search the user moved
    // past.
    ctx.fetch = async (url, opt = {}) => {
      const text = String(url);
      if (text.startsWith("/api/file-browser/content-search") && text.includes("/file?")) {
        if (fileBehavior === "reject") throw new Error("file read failed");
        if (fileBehavior === "nofile") return { ok: true, status: 200, json: async () => ({ file: null }) };
        return new Promise((resolve) => { resolveLate = () => resolve({ ok: true, status: 200, json: async () => ({ file: { path: "src/needle.txt", match_count: 9, truncated: false, chunks: [], matches: [] } }) }); });
      }
      if (text.startsWith("/api/file-browser/content-search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ path: "src/needle.txt", match_count: 3, truncated: true, chunks: [] }],
            truncated: false,
            total_files: 1,
            total_matches: 3,
          }),
        };
      }
      return originalFetch(url, opt);
    };
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("search");
    const input = ctx.document.getElementById("mobileSearchInput");
    input.value = "needle";
    input.oninput();
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    let html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "truncated entry renders the Load all matches button");

    // Error path: a failed per-file re-search surfaces the message in
    // the File content section instead of failing silently.
    await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("src/needle.txt"));
    await ctx.settle();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("file-browser-error"), "the re-search error renders in the content section");
    ok(html.includes("file read failed"), "the error message names the failure");
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "the truncated entry keeps its button after the error");

    // Stale response: start a per-file re-search, then move the search
    // on (a new query bumps the sequence once its debounced search runs)
    // before the file response lands. The late entry must not swap into
    // the new results.
    fileBehavior = "late";
    const pending = ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("src/needle.txt"));
    await ctx.settle(2);
    input.value = "other";
    input.oninput();
    await ctx.flushTimers();
    await ctx.settle();
    resolveLate();
    await pending;
    await ctx.settle();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "the stale late re-search never swaps the truncated entry in");

    // Malformed payload: a per-file re-search that answers without a
    // file object must not swap an undefined entry into the results
    // (the truncated entry survives untouched).
    fileBehavior = "nofile";
    await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("src/needle.txt"));
    await ctx.settle();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "a file-less response never corrupts the results entry");

    // Missing helper: with the shared search module gone the button is a
    // quiet no-op. The guard must return BEFORE any state churn: without it
    // the seq bump plus catch parks a TypeError message on content.error,
    // and that garbage surfaces in the next render once the helper comes
    // back (a helper script hiccup must not poison the results list).
    const savedHelper = ctx.HerdrWorkspaceSearch;
    // The vm keeps an inner-global copy of HerdrWorkspaceSearch that a
    // sandbox-side delete cannot reach (Node vm shadowing); remove it
    // from inside the context so the source really sees it gone.
    vm.runInContext("delete globalThis.HerdrWorkspaceSearch", ctx);
    let threw = false;
    try {
      await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("src/needle.txt"));
    } catch (error) {
      threw = true;
    }
    await ctx.settle();
    ok(!threw, "loadFile without the helper does not throw");
    ctx.HerdrWorkspaceSearch = savedHelper;
    // expandAll forces a render through the global API (the instance is
    // private to app.js), exposing any error parked while the helper was
    // gone.
    ctx.HerdrMobileSearchContent.expandAll();
    html = ctx.document.getElementById("mobileSearchResults").innerHTML;
    ok(html.includes("HerdrMobileSearchContent.loadFile"), "the results render clean after the helper returns");
    ok(!html.includes("file-browser-error"), "no TypeError text leaks into the restored render");
  });

  it("shows Editor settings group with desktop parity options (B4)", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("settings");
    const settingsHtml = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(settingsHtml.includes("Editor"));
    ok(settingsHtml.includes("Editor word wrap"));
    ok(settingsHtml.includes("Editor tab size"));
    ok(settingsHtml.includes("LSP diagnostics"));
    ok(settingsHtml.includes("HerdrMobile.setEditorWordWrap"));
    ok(settingsHtml.includes("HerdrMobile.setEditorTabSize"));
    ok(settingsHtml.includes("HerdrMobile.setLspEnabled"));
    equal(typeof ctx.HerdrMobile.setEditorEnabled, "function");
    equal(typeof ctx.HerdrMobile.setEditorWordWrap, "function");
    equal(typeof ctx.HerdrMobile.setEditorTabSize, "function");
    equal(typeof ctx.HerdrMobile.setLspEnabled, "function");
    doesNotThrow(() => ctx.HerdrMobile.setEditorWordWrap(true));
    doesNotThrow(() => ctx.HerdrMobile.setEditorTabSize("4"));
    doesNotThrow(() => ctx.HerdrMobile.setLspEnabled(true));
    const stored = ctx.localStorage.getItem("herdr-web-options");
    ok(stored && stored.includes('"editorWordWrap":true'), "word wrap persisted");
    ok(stored && stored.includes('"editorTabSize":4'), "tab size persisted");
    ok(stored && stored.includes('"lspEnabled":true'), "lsp persisted");
  });

  it("requests mobile browser notification permission before enabling notifications", async () => {
    const ctx = context();
    let requested = false;
    ctx.Notification = {
      permission: "default",
      async requestPermission() {
        requested = true;
        this.permission = "granted";
        return "granted";
      },
    };
    vm.runInContext(source, ctx);

    await ctx.HerdrMobile.setBrowserNotifications(true);

    equal(requested, true);
    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).browserNotifications,
      true,
    );
  });

  it("uses louder mobile attention sound gain", () => {
    ok(source.includes("notificationVolume: 0.24"));
    ok(source.includes("notificationVolume(parsed.notificationVolume)"));
  });

  it("stores mobile notification volume from Settings", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.setNotificationVolume("70");

    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).notificationVolume,
      0.7,
    );
  });

  it("does not force terminal screen after user selects another mobile tab", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    equal(ctx.HerdrMobile.currentScreen(), "terminal");
    ctx.HerdrMobile.showScreen("agents");
    await ctx.HerdrMobile.refresh();
    equal(ctx.HerdrMobile.currentScreen(), "agents");
  });

  it("escapes inline handler args for scoped ids", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("panels");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.selectTab(&quot;w1:t1&quot;)"));
  });

  it("expands short route ids and writes short ids when switching tabs", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t1");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p1");
    ctx.HerdrMobile.selectTab("w1:t2");
    const last = ctx.history.calls.at(-1);
    equal(last.type, "push");
    equal(last.path, "/session/default/workspace/w1/tab/t2/pane/p2");
  });

  it("keeps compact panel IDs connected to their scoped pane IDs", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      tabs: [
        { workspace_id: "w1", tab_id: "t1", number: 1 },
        { workspace_id: "w1", tab_id: "t2", number: 2 },
      ],
      panes: [
        { tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
        { tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
      ],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    ctx.HerdrMobile.selectTab("t2");
    equal(ctx.HerdrMobile.currentSelection().tab, "t2");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p2");
  });

  it("does not select a pane from another tab while panel data is settling", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      panes: ({ url }) =>
        String(url).includes("workspace_id=w1")
          ? [{ tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" }]
          : [],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    ctx.HerdrMobile.selectTab("w1:t2");
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t2");
    equal(ctx.HerdrMobile.currentSelection().pane, null);
  });

  it("recreates terminal after leaving and returning to terminal screen", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await Promise.resolve();
    ok(ctx.terminalStats.opened >= 1);
    ok(ctx.terminalStats.linksRegistered >= 1);
    ctx.HerdrMobile.showScreen("agents");
    equal(ctx.terminalStats.disposed, 1);
    equal(ctx.terminalStats.linkDisposed, 1);
    ctx.HerdrMobile.showScreen("terminal");
    await Promise.resolve();
    ok(ctx.terminalStats.opened >= 2);
  });

  it("shows mobile terminal tail button and preserves scrollback on output", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await Promise.resolve();
    ok(source.includes("mobileTerminalFollowButton"));
    ok(source.includes('terminal.addEventListener("wheel", handleWheel, { passive: false })'));
    ok(source.includes("term.usesNormalBuffer"));
    ok(source.includes("term.scrollLines"));
    equal(typeof ctx.HerdrMobile.scrollTerminalToBottom, "function");
    ok(source.includes('onclick="HerdrMobile.scrollTerminalToBottom(false)"'));
    ctx.lastTerminal._atBottom = false;
    ctx.terminalAtBottomOverride = false;
    const terminalEl = ctx.document.getElementById("terminal");
    terminalEl.listeners.scroll[0]();
    ok(ctx.document.getElementById("mobileTerminalFollowButton").hidden === false);
    ctx.lastSocket.onmessage({ data: "new output" });
    equal(ctx.lastTerminal.scrolledToBottom, false);
    ctx.HerdrMobile.scrollTerminalToBottom();
    equal(ctx.terminalAtBottomOverride, true);
  });

  it("captures mobile terminal paste before native terminal paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /sendPasteToTerminal\(text\)/);
    match(source, /sendInputData\(normalized, \{ chunkSize: 16 \* 1024, maxBufferedAmount: 64 \* 1024 \}\)/);
    ok(!source.includes('JSON.stringify({ type: "paste"'));
    ok(!source.includes('.paste(text)'));
  });

  it("opens mobile Git file diff with scrollable hunk markup", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();

    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.selectGitFile"));
    ok(html.includes("src/mobile.js"));

    await ctx.HerdrMobile.selectGitFile("src/mobile.js", "M");

    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("mobile-hunk"));
    ok(html.includes("@@ -1 +1 @@"));
    ok(html.includes("+new"));
    const css = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    ok(css.includes(".mobile-hunk pre"));
    ok(css.includes("overflow-x: auto"));
    ok(
      ctx.requests.some((request) =>
        String(request.url).includes("/api/git-ui/diff?cwd=%2Ftmp%2Falpha"),
      ),
    );
  });

  it("mobile git screen stages, unstages, discards, and switches branches (B3)", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();

    // Unstaged file detail shows Stage + Discard (not Unstage).
    await ctx.HerdrMobile.selectGitFile("src/mobile.js", "M");
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.gitStageFile()"), "stage action rendered");
    ok(html.includes("HerdrMobile.gitDiscardFile()"), "discard action rendered");
    ok(!html.includes("HerdrMobile.gitUnstageFile()"), "no unstage for unstaged file");

    // Stage posts to the stage API with the file path.
    await ctx.HerdrMobile.gitStageFile();
    const stageCall = ctx.requests.find((request) => String(request.url) === "/api/git-ui/stage");
    ok(stageCall, "stage request sent");
    ok(JSON.parse(stageCall.opt.body).paths[0] === "src/mobile.js");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.gitUnstageFile()"), "kind flips to staged after staging");

    // Staged file detail offers Unstage, not Stage.
    await ctx.HerdrMobile.selectGitFile("src/staged.js", "S");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.gitUnstageFile()"), "unstage rendered for staged file");
    ok(!html.includes("HerdrMobile.gitStageFile()"), "no stage for staged file");

    // Discard is confirmed before posting.
    ctx.confirm = () => false;
    await ctx.HerdrMobile.gitDiscardFile();
    ok(!ctx.requests.some((request) => String(request.url) === "/api/git-ui/discard"), "declined discard posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitDiscardFile();
    const discardCall = ctx.requests.find((request) => String(request.url) === "/api/git-ui/discard");
    ok(discardCall, "confirmed discard posts");
    ok(JSON.parse(discardCall.opt.body).confirmed === true);

    // Branches load through the branches API and switching requires confirm.
    await ctx.HerdrMobile.backGitFiles();
    ctx.confirm = () => false;
    await ctx.HerdrMobile.toggleGitBranches();
    let branchesHtml = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(branchesHtml.includes("feature/mobile"), "branch list renders local branches");
    ok(branchesHtml.includes("origin/main"), "branch list renders remote branches");
    ok(ctx.requests.some((request) => String(request.url).startsWith("/api/git-ui/branches")), "branches fetched");
    await ctx.HerdrMobile.gitSwitchBranch("feature/mobile");
    ok(!ctx.requests.some((request) => String(request.url) === "/api/git-ui/switch"), "declined switch posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitSwitchBranch("feature/mobile");
    const switchCall = ctx.requests.find((request) => String(request.url) === "/api/git-ui/switch");
    ok(switchCall, "confirmed switch posts");
    ok(JSON.parse(switchCall.opt.body).branch === "feature/mobile");
  });

  it("renders mobile worktree path input and discovers by cwd", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("worktrees");
    ctx.HerdrMobile.updateWorktreeField("worktreeDiscoverPath", "~/code/repo");
    await ctx.HerdrMobile.loadWorktrees();
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Discovering...") || source.includes("Discovering..."));
    ok(
      ctx.requests.some(
        (request) => request.url === "/api/worktrees?cwd=~%2Fcode%2Frepo",
      ),
    );
  });

  it("stores mobile exploration default directory and prefills worktree discovery path", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.setWorktreeDefaultDirectory("/tmp/worktrees");
    ctx.HerdrMobile.setExplorationDefaultDirectory("/tmp/code");
    ctx.HerdrMobile.showScreen("settings");
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes("Worktree default directory"));
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes("Exploration default directory"));
    ctx.HerdrMobile.showScreen("worktrees");

    equal(ctx.HerdrMobile.currentScreen(), "worktrees");
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes('value="/tmp/code"'));
    await ctx.HerdrMobile.loadWorktrees();
    ok(
      ctx.requests.some(
        (request) => request.url === "/api/worktrees?cwd=%2Ftmp%2Fcode",
      ),
    );
  });

  it("shows a rollback chip when a mobile setting drifted from its baseline", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("settings");
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(
      !html.includes('data-rollback-id="worktreeDefaultDirectory"'),
      "no rollback chip before any change",
    );

    ctx.HerdrMobile.setWorktreeDefaultDirectory("/tmp/changed");
    ctx.HerdrMobile.showScreen("settings");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(
      html.includes('data-rollback-id="worktreeDefaultDirectory"'),
      "rollback chip appears after a change",
    );

    ctx.HerdrMobile.rollbackSetting("worktreeDefaultDirectory");
    ctx.HerdrMobile.showScreen("settings");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(
      !html.includes('data-rollback-id="worktreeDefaultDirectory"'),
      "chip cleared after rollback",
    );
    const saved = JSON.parse(ctx.localStorage.getItem("herdr-web-options"));
    equal(saved.worktreeDefaultDirectory, "", "rolled back to the baseline");

    // Re-entering Settings re-captures the open-time baseline: a new change
    // drifts from the fresh snapshot, and rolling back restores it.
    ctx.HerdrMobile.showScreen("home");
    ctx.HerdrMobile.showScreen("settings");
    ctx.HerdrMobile.setWorktreeDefaultDirectory("/tmp/second");
    ctx.HerdrMobile.showScreen("settings");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(
      html.includes('data-rollback-id="worktreeDefaultDirectory"'),
      "chip appears after re-entry change",
    );
    ctx.HerdrMobile.rollbackSetting("worktreeDefaultDirectory");
    const savedSecond = JSON.parse(ctx.localStorage.getItem("herdr-web-options"));
    equal(
      savedSecond.worktreeDefaultDirectory,
      "",
      "re-entry rollback restores the fresh open-time baseline",
    );
  });

  it("shows highest-priority agent status in More tab label", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    const moreButton = ctx.navButtons.find(
      (button) => button.dataset.screen === "more",
    );
    ok(moreButton.innerHTML.includes("blocked"));
  });

  it("sorts mobile agents by attention priority", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("agents");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.indexOf("blocked-agent") < html.indexOf("done-agent"));
  });

  it("shows worktree name, repo name, and latest commit date as meta", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.loadWorktrees();
    ctx.HerdrMobile.showScreen("worktrees");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("<strong>mobile-worktree</strong>"));
    ok(html.includes("<small>alpha · Latest commit"));
    ok(source.includes("worktreeActivityLabel"));
    ok(!readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8").includes("sortWorktreesByRecent"));
  });

  it("renders already-open recent workspaces as disabled rows", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      recentWorkspaces: {
        recent: [
          { path: "/tmp/alpha", label: "Alpha", kind: "workspace" },
          { path: "/tmp/other", label: "Other", kind: "workspace" },
        ],
      },
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.HerdrMobile.loadRecentWorkspaces();
    ctx.HerdrMobile.showScreen("worktrees");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;

    // The open workspace (/tmp/alpha matches the open w1 cwd) stays visible
    // but is grayed out and its Open button is disabled.
    ok(html.includes("Alpha"), "open recent workspace stays visible");
    ok(html.includes("mobile-recent-open"), "open recent row gets the open class");
    ok(html.includes("Alpha (already open)"), "open recent row shows the already-open hint");
    ok(
      /mobile-btn primary" title="This workspace is already open" disabled/.test(html),
      "open recent Open button is disabled",
    );
    ok(html.includes("Other"), "closed recent workspace stays visible");
    ok(!/Other \(already open\)/.test(html), "closed recent row is not marked open");

    // Raw paths through jsArg remain for both rows (jsArg emits a JSON string
    // literal, so quotes appear as &quot; entities).
    const openRow = html.slice(html.indexOf("Alpha (already open)"));
    ok(openRow.includes("openRecentWorkspace(&quot;/tmp/alpha&quot;)"), "open recent row keeps the raw jsArg path");
    ok(html.includes("removeRecentWorkspace(&quot;/tmp/alpha&quot;)"), "open recent row still offers removal");
    ok(!readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8").includes("sortWorktreesByRecent"));
  });

  it("creates new panel in selected workspace", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.HerdrMobile.createPanel();
    ok(
      ctx.requests.some(
        (request) =>
          request.url === "/api/tabs" &&
          request.opt.method === "POST" &&
          JSON.parse(request.opt.body).workspace_id === "w1",
      ),
    );
  });

  it("renders mobile close current panel controls", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("panels");
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Close current panel"));
    // Tabs moved to the header dropdown: the close action renders from the
    // tabs sheet list builder, not the old in-screen tab strip.
    ok(source.includes("closePanelFromSheet"));
    equal(typeof ctx.HerdrMobile.closeCurrentPanel, "function");
    equal(typeof ctx.HerdrMobile.closePanelFromSheet, "function");
  });

  it("closes current mobile panel and selects the focused fallback panel", async () => {
    const remainingTabs = [
      { workspace_id: "w1", tab_id: "w1:t2", number: 2, focused: true },
    ];
    const remainingPanes = [
      { tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2", focused: true },
    ];
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      tabs: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? remainingTabs
          : [
              { workspace_id: "w1", tab_id: "w1:t1", number: 1 },
              ...remainingTabs,
            ],
      panes: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? remainingPanes
          : [
              { tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
              ...remainingPanes,
            ],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    await ctx.HerdrMobile.closeCurrentPanel();

    ok(ctx.requests.some(
      (request) => request.url === "/api/tabs/w1%3At1/close" && request.opt.method === "POST",
    ));
    // The workspace close mirror is gone: closing a panel never closes
    // the workspace, even when it held the last tab.
    ok(!ctx.requests.some(
      (request) => request.url === "/api/workspaces/w1/close",
    ));
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t2");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p2");
    equal(ctx.history.calls.at(-1).path, "/session/default/workspace/w1/tab/t2/pane/p2");
  });

  it("closing the last mobile panel keeps the workspace on screen", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      tabs: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? []
          : [{ workspace_id: "w1", tab_id: "w1:t1", number: 1 }],
      panes: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? []
          : [{ tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" }],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    await ctx.HerdrMobile.closeCurrentPanel();

    ok(ctx.requests.some(
      (request) => request.url === "/api/tabs/w1%3At1/close" && request.opt.method === "POST",
    ));
    ok(!ctx.requests.some(
      (request) => request.url === "/api/workspaces/w1/close",
    ));
    // The workspace stays selected with no tab and no pane.
    equal(ctx.HerdrMobile.currentSelection().ws, "w1");
    equal(ctx.HerdrMobile.currentSelection().tab, null);
    equal(ctx.HerdrMobile.currentSelection().pane, null);
  });

  it("closes the real panel when a refresh re-scopes the selected id mid-flight", async () => {
    // Reproduces the builtin backend world: tabs carry bare ids (t1) while
    // parseRoute scopes the selected id to ws:id (w1:t1) at refresh start.
    // A refresh kicked off by a WS event leaves that scoped form in
    // state.tab until finishRefresh normalizes it; a close clicked in that
    // window must still target and name the real panel.
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1", {
      tabs: [{ workspace_id: "w1", tab_id: "t1", number: 1, label: "Shell" }],
      panes: [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term1" }],
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    equal(ctx.HerdrMobile.currentSelection().tab, "t1");

    const confirmMessages = [];
    const confirmSheet = ctx.document.getElementById("mobileConfirmSheet");
    confirmSheet.querySelector = (selector) =>
      selector === "#mobileConfirmMessage"
        ? { set textContent(value) { confirmMessages.push(value); } }
        : null;

    // Start a refresh and let its synchronous parseRoute run (state.tab is
    // scoped again), then close before the refresh's awaits normalize it.
    const pendingRefresh = ctx.HerdrMobile.refresh();
    await ctx.HerdrMobile.closeCurrentPanel();
    await pendingRefresh;

    ok(ctx.requests.some(
      (request) => request.url === "/api/tabs/t1/close" && request.opt.method === "POST",
    ), "close must POST the real bare tab id");
    ok(!ctx.requests.some(
      (request) => request.url === "/api/tabs/w1%3At1/close",
    ), "close must not POST the scoped route form");
    match(confirmMessages[0] || "", /Close panel "Shell"\?/,
      "confirm must name the real panel, not tab undefined");
  });

  it("treats a not-found close as closed and keeps the post-close flow", async () => {
    // The server now answers a close on a missing tab with an explicit
    // not-found error instead of a silent 200. When the close loses the
    // race (pane.exited closed it elsewhere while the sheet was open) the
    // outcome is the one the user wanted, so the panel state must clear
    // and the refresh run, not surface an error banner.
    const ctx = context("/session/default/workspace/w1/tab/w1:t1/pane/w1:p1", {
      tabs: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? []
          : [{ workspace_id: "w1", tab_id: "w1:t1", number: 1 }],
      panes: ({ requests }) =>
        requests.some((request) => request.url === "/api/tabs/w1%3At1/close")
          ? []
          : [{ tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" }],
      closeError: "tab w1:t1 not found",
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    await ctx.HerdrMobile.closeCurrentPanel();

    ok(ctx.requests.some(
      (request) => request.url === "/api/tabs/w1%3At1/close" && request.opt.method === "POST",
    ), "the close POST must still fire");
    equal(ctx.HerdrMobile.currentSelection().tab, null,
      "a not-found close is the desired outcome: selection must clear");
    equal(ctx.HerdrMobile.currentSelection().pane, null);
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(!html.includes("not found"),
      "a benign not-found race must not surface an error banner");
  });

  it("surfaces real close errors instead of swallowing them", async () => {
    // Only the benign not-found race is tolerated; any other server error
    // (backend down, state unavailable) must reach the user.
    const ctx = context("/session/default/workspace/w1/tab/w1:t1/pane/w1:p1", {
      closeError: "state unavailable",
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    await ctx.HerdrMobile.closeCurrentPanel();

    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("state unavailable"),
      "a real error must surface in the screen, not vanish");
  });

  it("treats a not-found close from the tabs sheet as closed", async () => {
    // closePanelFromSheet closes a NON-current tab directly; the same
    // benign race applies (the tab may close elsewhere while the sheet
    // is open). The server's real error shape is the object body
    // {error:{code,message}}, so tolerance must survive that shape too.
    const ctx = context("/session/default/workspace/w1/tab/w1:t1/pane/w1:p1", {
      tabs: [
        { workspace_id: "w1", tab_id: "w1:t1", number: 1, label: "one" },
        { workspace_id: "w1", tab_id: "w1:t2", number: 2, label: "two" },
      ],
      panes: [
        { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
        { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
      ],
      closeError: { code: "builtin_error", message: "tab w1:t2 not found" },
    });
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    const errorBanner = () => ctx.document.getElementById("mobileScreen").innerHTML;

    await ctx.HerdrMobile.closePanelFromSheet("w1:t2");

    ok(ctx.requests.some(
      (request) => request.url === "/api/tabs/w1%3At2/close" && request.opt.method === "POST",
    ), "the sheet close POST must fire");
    ok(!errorBanner().includes("not found"),
      "the not-found race from the sheet must not surface an error banner");
  });

  it("restores the saved selection when switching back to a session", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    // An explicit navigation inside the default session saves the selection.
    ctx.HerdrMobile.selectWorkspace("w2");
    equal(
      ctx.localStorage.getItem("herdr-session-state:builtin:default"),
      JSON.stringify({ ws: "w2", tab: null, pane: null }),
    );

    // Switch away: no saved selection for revolut yet, so bare prefix.
    ctx.HerdrMobile.selectSession("revolut", "builtin");
    equal(ctx.history.calls.at(-1).path, "/session/revolut");
    equal(ctx.localStorage.getItem("herdr-session-backend:revolut"), "builtin");

    // Switch back: the saved selection is replayed into the pushed URL.
    ctx.HerdrMobile.selectSession("default", "builtin");
    equal(ctx.history.calls.at(-1).path, "/session/default/workspace/w2");
    equal(ctx.HerdrMobile.currentSelection().ws, "w2");
  });

  it("keeps per-session backend pins isolated on mobile", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.selectSession("work", "builtin");
    equal(ctx.localStorage.getItem("herdr-session-backend:work"), "builtin");
    equal(ctx.localStorage.getItem("herdr-session-backend:default"), null);

    // The default session keeps no pin; the work pin must not leak into it.
    ctx.localStorage.setItem("herdr-session-backend:default", "builtin");
    ctx.localStorage.setItem("herdr-session-backend:work", "external-herdr");
    ctx.HerdrMobile.selectSession("default", "builtin");
    equal(ctx.localStorage.getItem("herdr-session-backend:default"), "builtin");
    equal(ctx.localStorage.getItem("herdr-session-backend:work"), "external-herdr");
  });

  it("closes an inactive session row and forgets its stored state", async () => {
    const ctx = context("/session/default");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    // Seed stored state for the row's session, as a previous visit would.
    ctx.localStorage.setItem("herdr-session-backend:stale", "builtin");
    ctx.localStorage.setItem("herdr-session-state:builtin:stale", JSON.stringify({ ws: "w9", tab: null, pane: null }));

    await ctx.HerdrMobile.closeSessionRow("stale", "builtin");

    const close = ctx.requests.find((r) => r.url === "/api/session/close");
    ok(close, "row close request missing");
    equal(close.opt.body, JSON.stringify({ session: "stale", backend: "builtin" }));
    // Closed means closed: pin and saved selection are forgotten.
    equal(ctx.localStorage.getItem("herdr-session-backend:stale"), null);
    equal(ctx.localStorage.getItem("herdr-session-state:builtin:stale"), null);
    // The current target is untouched: same backend pin and session, and the
    // refreshed workspace list still serves the default session.
    equal(ctx.HerdrMobile.currentSessionBackend(), "builtin");
    equal(
      ctx.requests.some((r) => r.url.includes("x-herdr-backend=external-herdr")),
      false,
      "row close must not retarget the current session",
    );
  });

  it("treats already-stopped rows as closed without surfacing an error", async () => {
    // Same class of stale-target errors: the server's idempotent-close marker
    // and a dead-listener socket refusal (backend crashed without unlinking
    // its socket file) both mean the session is already down.
    for (const error of ["already_stopped", "Connection refused (os error 61)"]) {
      const ctx = context("/session/default");
      vm.runInContext(source, ctx);
      await ctx.HerdrMobile.refresh();

      const originalFetch = ctx.fetch;
      ctx.fetch = async (url, opt = {}) => {
        if (url === "/api/session/close") {
          return { ok: false, status: 400, json: async () => ({ error }) };
        }
        return originalFetch(url, opt);
      };

      await ctx.HerdrMobile.closeSessionRow("stale", "builtin");

      // Already stopped is a success for close: no error banner is rendered on
      // the sessions screen and the stored state is forgotten.
      await ctx.settle();
      ctx.HerdrMobile.showScreen("sessions");
      const screenHtml = ctx.document.getElementById("mobileScreen").innerHTML;
      ok(!screenHtml.includes("mobile-error"), `${error} must not surface as an error`);
      equal(ctx.localStorage.getItem("herdr-session-backend:stale"), null);
    }
  });

  it("treats closing the current session over a dead-listener socket as success", async () => {
    // The backend crashed without unlinking its socket file, so the close
    // request hits "Connection refused". The current-session close (unlike
    // the row close) must also treat that as already-stopped: forget state,
    // retarget to the default session, and show no error.
    for (const error of ["already_stopped", "Connection refused (os error 61)"]) {
      const ctx = context("/session/revolut");
      vm.runInContext(source, ctx);

      const originalFetch = ctx.fetch;
      ctx.fetch = async (url, opt = {}) => {
        if (url === "/api/session/close") return { ok: false, status: 400, json: async () => ({ error }) };
        return originalFetch(url, opt);
      };

      await ctx.HerdrMobile.closeSession();

      await ctx.settle();
      ctx.HerdrMobile.showScreen("sessions");
      const screenHtml = ctx.document.getElementById("mobileScreen").innerHTML;
      ok(!screenHtml.includes("mobile-error"), `${error} must not surface as an error`);
      // The retarget pushed the default session path. The async refresh
      // may then extend it to the restored selection, so assert the push
      // itself instead of racing the refresh tail.
      ok(
        ctx.history.calls.some((c) => c.type === "push" && c.path === "/session/default"),
        `${error} must retarget the default session`,
      );
      ok(
        ctx.location.pathname.startsWith("/session/default"),
        `${error} must leave the closed session path`,
      );
      equal(ctx.localStorage.getItem("herdr-session-state:builtin:revolut"), null);
    }
  });

  it("renders terminal key bar with control keys", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    // The screen render memo keeps the first terminal HTML in place, so
    // assert on the markup builder in the bundle source.
    match(source, /<div class="mobile-keybar" id="mobileKeyBar"/);
    // Two rows: classic keys first, then combos Android keyboards cannot
    // type (EOF, suspend, clear, line edits, reverse search, pager scroll).
    equal((source.match(/class="mobile-keybar-row"/g) || []).length, 2, "keybar renders two rows");
    const keybarSource = source.match(/function renderKeyBar\(\) \{[\s\S]*?\n    \}\n/)[0];
    for (const key of [
      "esc", "tab", "ctrl", "up", "down", "left", "right", "ctrl-c",
      "ctrl-d", "ctrl-z", "ctrl-l", "ctrl-a", "ctrl-e", "ctrl-u", "ctrl-w", "ctrl-r",
      "pgup", "pgdn", "home", "end",
    ])
      ok(keybarSource.includes(`key("${key}"`), `${key} key present`);
    // No focus steal: every key bar button prevents default on mousedown.
    equal((keybarSource.match(/onmousedown="event\.preventDefault\(\)"/g) || []).length, 1, "mousedown guard on the shared key builder");
    equal((keybarSource.match(/\bkey\("|\bkey\("|key\("/g) || []).length, 20, "twenty keys across the two rows");
    // Keyboard-open hides the key bar along with header/nav.
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(mobileCss, /body\.mobile-keyboard-open \.mobile-keybar/);
  });

  it("renders the key toolbar above the nav bar with the floating Keys fab", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    // The toolbar div sits in the shell right before the nav (grid
    // auto-placement puts it visually ABOVE the nav bar); the Keys fab is
    // a fixed-position shell button, terminal-only.
    const shellIdx = source.indexOf('<div class="mobile-toolbar" id="mobileToolbar" hidden></div>');
    const navIdx = source.indexOf('<nav class="mobile-nav">');
    ok(shellIdx > -1 && shellIdx < navIdx, "toolbar markup comes before the nav markup (renders above it)");
    match(source, /id="mobileKeysFab" class="mobile-keys-fab" hidden aria-label="Toggle terminal keys, drag to move" aria-pressed="false"/);
    ok(source.indexOf('<div class="mobile-toolbar" id="mobileToolbar" hidden></div>') < source.indexOf('<div class="mobile-sheet-backdrop" id="mobileTabsBackdrop"'), "toolbar sits between screen and overlays");
    // Toolbar content mirrors the keybar builder, and syncs per render.
    match(source, /function syncToolbar\(\) \{[\s\S]*?mobilePanels\.renderKeyBar\(\)/);
    // Toggle flips visibility, persists, and updates the fab aria-pressed.
    const before = ctx.document.getElementById("mobileToolbar").hidden;
    const fabBefore = ctx.document.getElementById("mobileKeysFab").getAttribute("aria-pressed");
    ctx.HerdrMobile.toggleToolbar();
    const after = ctx.document.getElementById("mobileToolbar").hidden;
    equal(after, !before, "toggle flips toolbar hidden");
    equal(
      ctx.document.getElementById("mobileKeysFab").getAttribute("aria-pressed"),
      fabBefore === "true" ? "false" : "true",
      "fab aria-pressed flips with the toolbar",
    );
    ctx.HerdrMobile.toggleToolbar();
    equal(ctx.document.getElementById("mobileToolbar").hidden, before, "toggle back restores");
    // Folding the toolbar changes the terminal shell height, so the toggle
    // schedules a terminal re-fit: after the debounce the input WS carries
    // a resize frame with the recomputed grid (smaller when the toolbar
    // opens, taller when it folds).
    const resizeFrames = [];
    const originalSend = ctx.lastSocket.send.bind(ctx.lastSocket);
    ctx.lastSocket.send = (data) => { originalSend(data); try { resizeFrames.push(JSON.parse(String(data))); } catch (_) {} };
    const shell = ctx.document.getElementById("terminalShell");
    ctx.HerdrMobile.toggleToolbar();
    // Simulate what the browser does: the toolbar row takes shell height
    // (the stub has no layout, so drive the measured box by hand).
    shell.clientHeight -= 104;
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    const resize = resizeFrames.filter((f) => f && f.type === "resize");
    ok(resize.length > 0, "toggle sends a terminal resize frame");
    if (resize.length) {
      ok(Number.isInteger(resize[resize.length - 1].cols) && Number.isInteger(resize[resize.length - 1].rows), "resize frame carries an integer grid");
    }
    ctx.HerdrMobile.toggleToolbar();
    // Fold: shell height goes back to the toolbar-less size.
    shell.clientHeight += 104;
    await ctx.settle();
    await ctx.flushTimers();
    // CSS: keyboard-open hides the toolbar row and the fab too.
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");
    match(mobileCss, /body\.mobile-keyboard-open \.mobile-toolbar/);
    match(mobileCss, /body\.mobile-keyboard-open \.mobile-keys-fab/);
    match(mobileCss, /\.mobile-toolbar\[hidden\] \{\n\s*display: none;\n\s*\}/);
  });

  it("drags the Keys fab to move it and taps it to toggle the toolbar", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    const fab = ctx.document.getElementById("mobileKeysFab");
    equal(fab.hidden, false, "fab visible in the terminal view");
    // Leaving the terminal hides the fab; coming back shows it.
    ctx.HerdrMobile.showScreen("home");
    equal(fab.hidden, true, "fab hidden outside the terminal");
    ctx.HerdrMobile.showScreen("terminal");
    equal(fab.hidden, false, "fab visible again on terminal");
    // Tap: no movement past the threshold, so it toggles the toolbar.
    const before = ctx.document.getElementById("mobileToolbar").hidden;
    ctx.HerdrMobile.keysFabDragStart({ clientX: 340, clientY: 720, preventDefault() {} });
    // No move beyond 6px: end immediately as a tap.
    ctx.dispatchDocumentEvent("mouseup");
    equal(ctx.document.getElementById("mobileToolbar").hidden, !before, "tap toggles the toolbar");
    // Drag: pointer moves past the threshold, position persists.
    equal(ctx.localStorage.getItem("herdr-mobile-keys-fab"), null, "no position stored before a drag");
    ctx.HerdrMobile.keysFabDragStart({ clientX: 340, clientY: 720, preventDefault() {} });
    ctx.dispatchDocumentPointerEvent("mousemove", { clientX: 300, clientY: 660, preventDefault() {} });
    ctx.dispatchDocumentEvent("mouseup");
    const saved = ctx.localStorage.getItem("herdr-mobile-keys-fab");
    ok(saved, "drag persists the fab position");
    // Clamped inside the viewport: x within [0, innerWidth - width].
    const pos = JSON.parse(saved);
    ok(pos.x >= 0 && pos.x <= 390 - 80, "x clamped to the viewport");
    ok(pos.y >= 0 && pos.y <= 844 - 40, "y clamped to the viewport");
  });

  it("opens the panels dialog from the header meta chip and the workspace switcher from the title", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    // The panels trigger moved off the nav bar into the header meta line:
    // the nav has no Panels tab anymore, and the chip is visible with a
    // workspace open.
    ok(!ctx.document.querySelector('.mobile-nav button[data-panels]'), "no nav panels button");
    // Header order: connection dot, backend badge, title, panels chip,
    // then the meta text as the trailing flexible element.
    const order = ["mobileConnectionDot", "mobileBackendBadge", "mobileTitle", "mobilePanelsChip", "mobileMeta"]
      .map((id) => source.indexOf(`id="${id}"`))
      .filter((idx) => idx > -1);
    equal(order.length, 5, "all five header elements present");
    ok(order.every((idx, i) => i === 0 || idx > order[i - 1]), "header order dot, badge, title, chip, meta");
    const chip = ctx.document.getElementById("mobilePanelsChip");
    ok(chip, "header panels chip present");
    equal(chip.hidden, false, "panels chip visible with workspace");
    ok(chip.textContent.length > 0, "chip carries a label (pane count or panel name)");
    ctx.HerdrMobile.openTabsSheet();
    const listHtml = ctx.document.getElementById("mobileTabsSheetList").innerHTML;
    ok(listHtml.includes("New panel"), "sheet lists New panel");
    ok(listHtml.includes("Close current panel"), "sheet lists Close current panel");
    ok(listHtml.includes("selectTabFromSheet"), "rows switch via sheet");
    equal(ctx.document.getElementById("mobileTabsSheet").hidden, false, "sheet open");
    // Close hides both sheet and backdrop.
    ctx.HerdrMobile.closeTabsSheet();
    equal(ctx.document.getElementById("mobileTabsSheet").hidden, true, "sheet closed");
    equal(ctx.document.getElementById("mobileTabsBackdrop").hidden, true, "backdrop closed");
    // Title press opens the workspace switcher sheet with the same rows
    // as the Home list; selecting switches and closes.
    ctx.HerdrMobile.openWorkspacesSheet();
    const wsHtml = ctx.document.getElementById("mobileWorkspacesSheetList").innerHTML;
    ok(wsHtml.includes("selectWorkspaceFromSheet"), "switcher rows select via sheet");
    equal(ctx.document.getElementById("mobileWorkspacesSheet").hidden, false, "workspaces sheet open");
    ctx.HerdrMobile.closeWorkspacesSheet();
    equal(ctx.document.getElementById("mobileWorkspacesSheet").hidden, true, "workspaces sheet closed");
    equal(ctx.document.getElementById("mobileWorkspacesBackdrop").hidden, true, "workspaces backdrop closed");
    // Without a workspace the chip hides (refresh() auto-selects the first
    // workspace when one exists, so an empty list is the only way state.ws
    // stays null after a refresh).
    const ctx2 = context("/session/default", { workspaces: [] });
    vm.runInContext(source, ctx2);
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    equal(ctx2.document.getElementById("mobilePanelsChip").hidden, true, "panels chip hidden without workspace");
  });

  it("sends key bar control bytes through the terminal input path", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    const sent = [];
    ctx.lastSocket.send = (data) => sent.push(Buffer.from(data).toString("latin1"));
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "esc" }, setAttribute() {} });
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "tab" }, setAttribute() {} });
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "ctrl-c" }, setAttribute() {} });
    equal(sent[0], "\x1b");
    equal(sent[1], "\t");
    equal(sent[2], "\x03");
    // The Android-hostile combo keys send their literal control bytes.
    const combos = { "ctrl-d": "\x04", "ctrl-z": "\x1a", "ctrl-l": "\x0c", "ctrl-a": "\x01", "ctrl-e": "\x05", "ctrl-u": "\x15", "ctrl-w": "\x17", "ctrl-r": "\x12" };
    let i = 3;
    for (const [k, bytes] of Object.entries(combos)) {
      ctx.HerdrMobile.keyBarKey(null, { dataset: { key: k }, setAttribute() {} });
      equal(sent[i], bytes, `${k} sends ${JSON.stringify(bytes)}`);
      i += 1;
    }
    // Pager keys: PgUp/PgDn/Home/End escape sequences.
    const pager = { pgup: "\x1b[5~", pgdn: "\x1b[6~", home: "\x1b[H", end: "\x1b[F" };
    for (const [k, bytes] of Object.entries(pager)) {
      ctx.HerdrMobile.keyBarKey(null, { dataset: { key: k }, setAttribute() {} });
      equal(sent[i], bytes, `${k} sends ${JSON.stringify(bytes)}`);
      i += 1;
    }
    // Arming Ctrl then tapping a combo still sends the literal combo (no
    // double-apply), and disarms afterwards.
    const armed = { dataset: { key: "ctrl" }, ariaPressed: null, setAttribute(_n, v) { this.ariaPressed = v; } };
    ctx.HerdrMobile.keyBarKey(null, armed);
    equal(armed.ariaPressed, "true");
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "ctrl-l" }, setAttribute() {} });
    equal(sent[i], "\x0c", "armed Ctrl then combo sends the literal combo");
  });

  it("applies one-shot Ctrl to the next arrow key", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    const sent = [];
    ctx.lastSocket.send = (data) => sent.push(Buffer.from(data).toString("latin1"));
    const ctrlButton = { dataset: { key: "ctrl" }, ariaPressed: null, setAttribute(_n, v) { this.ariaPressed = v; } };
    ctx.HerdrMobile.keyBarKey(null, ctrlButton);
    equal(ctrlButton.ariaPressed, "true");
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "up" }, setAttribute() {} });
    // Ctrl+Up (modifier param), not plain Up.
    equal(sent[0], "\x1b[1;5A");
    // One-shot: the next plain Up is a plain arrow again.
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "up" }, setAttribute() {} });
    equal(sent[1], "\x1b[A");
    // Leaving the terminal screen disarms Ctrl.
    ctx.HerdrMobile.keyBarKey(null, ctrlButton);
    equal(ctrlButton.ariaPressed, "true");
    ctx.HerdrMobile.showScreen("agents");
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    const sent2 = [];
    ctx.lastSocket.send = (data) => sent2.push(Buffer.from(data).toString("latin1"));
    ctx.HerdrMobile.keyBarKey(null, { dataset: { key: "left" }, setAttribute() {} });
    equal(sent2[0], "\x1b[D");
  });

  it("banners an explicit stall close (4404) instead of hanging", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    const alertCalls = [];
    ctx.HerdrAlertCard = { show: (opts) => alertCalls.push(opts) };
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    ctx.lastSocket.onclose({ code: 4404 });
    equal(alertCalls.length, 1);
    equal(alertCalls[0].title, "Terminal stream stalled");
    equal(alertCalls[0].status, "blocked");
    // A normal close (e.g. deliberate teardown) never banners.
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    ctx.lastSocket.onclose({ code: 1000 });
    equal(alertCalls.length, 1);
  });

  it("re-pins the backend per session on Back and resets the target state", async () => {
    const ctx = context("/session/work");
    ctx.localStorage.setItem("herdr-session-backend:work", "external-herdr");
    ctx.localStorage.setItem("herdr-session-backend:default", "builtin");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();

    equal(ctx.HerdrMobile.currentSessionBackend(), "external-herdr");

    // Back to the default session's entry.
    ctx.location.pathname = "/session/default";
    ctx.dispatchDocumentEvent("popstate");

    equal(ctx.HerdrMobile.currentSessionBackend(), "builtin");
    equal(ctx.HerdrMobile.currentSelection().ws, null);
  });

  it("never adopts a same-named folder from another project as mobile worktree parent", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    // The mobile workmeta module is a factory over state; drive it directly
    // with the same fixture shape as the desktop regression test in
    // app_load.test.mjs: a linked worktree, its true main checkout, and a
    // same-named plain folder from another project.
    const mod = vm.runInContext("HerdrMobileWorkmetaModule", ctx);
    const workspacesPayload = [
      {
        workspace_id: "ws-plain",
        label: "workspace-bug",
        cwd: "/home/carol/unrelated/workspace-bug",
      },
      {
        workspace_id: "ws-main",
        label: "workspace-bug",
        cwd: "/home/alice/first/workspace-bug",
        worktree: {
          repo_key: "/home/alice/first/workspace-bug",
          repo_root: "/home/alice/first/workspace-bug",
          repo_name: "workspace-bug",
          checkout_path: "/home/alice/first/workspace-bug",
          is_linked_worktree: false,
        },
      },
      {
        workspace_id: "ws-linked",
        label: "feature-x",
        cwd: "/home/alice/first/.worktrees/workspace-bug-feature-x",
        worktree: {
          repo_key: "/home/alice/first/workspace-bug",
          repo_root: "/home/alice/first/workspace-bug",
          repo_name: "workspace-bug",
          checkout_path: "/home/alice/first/.worktrees/workspace-bug-feature-x",
          is_linked_worktree: true,
        },
      },
    ];
    const makeState = (workspaces) => ({
      workspaces,
      worktreeRows: [],
      ws: "ws-linked",
      tab: null,
      pane: null,
      tabs: [],
      panes: [],
      allTabs: [],
      session: "default",
    });
    const deps = {
      samePath: (a, b) => a === b,
      pathBasename: (p) =>
        String(p || "")
          .split("/")
          .filter(Boolean)
          .pop() || "",
    };
    const api = mod.create({ state: makeState(workspacesPayload), ...deps });
    const workspaces = api.workspacesById();
    ok(workspaces["ws-linked"], "module exposes workspacesById");

    // Path identity: the linked worktree resolves to the true main checkout
    // of the same repo, never the same-named plain folder from another
    // project (the label fallback that used to adopt it is gone).
    equal(
      api.parentWorkspaceName(workspaces["ws-linked"], workspaces),
      "workspace-bug",
    );
    ok(
      api.contextMeta(workspaces["ws-linked"]).startsWith("workspace-bug"),
      "contextMeta names the repo parent, not the lookalike folder",
    );

    // Name-only metadata (older/limited backends): no repo path means no
    // parent resolution by name guessing; falls back to the display name.
    const apiNameOnly = mod.create({
      state: makeState([
        {
          workspace_id: "ws-a",
          label: "api",
          cwd: "/one/api",
          worktree: { repo_name: "api", is_linked_worktree: false },
        },
        {
          workspace_id: "ws-b",
          label: "api",
          cwd: "/two/api",
          worktree: { repo_name: "api", is_linked_worktree: false },
        },
        {
          workspace_id: "ws-c",
          label: "feat",
          cwd: "/one/api/.wt/feat",
          worktree: {
            repo_name: "api",
            checkout_path: "/one/api/.wt/feat",
            is_linked_worktree: true,
          },
        },
      ]),
      ...deps,
    });
    const byIdNameOnly = apiNameOnly.workspacesById();
    equal(
      apiNameOnly.parentWorkspaceName(byIdNameOnly["ws-c"], byIdNameOnly),
      "api",
      "name-only linked worktree falls back to the repo name, never another workspace's label",
    );
    ok(
      apiNameOnly.contextMeta(byIdNameOnly["ws-c"]).startsWith("api"),
      "contextMeta shows the repo display name without adopting a lookalike",
    );

    // Degenerate metadata edge: a linked worktree with no repo_name and no
    // repo path used to make the meta line render "undefined" before the
    // path-identity fix; it must fall back to the workspace's own label.
    const apiDegenerate = mod.create({
      state: makeState([
        {
          workspace_id: "ws-x",
          label: "wt-x",
          cwd: "/one/api/.wt/x",
          worktree: {
            checkout_path: "/one/api/.wt/x",
            is_linked_worktree: true,
          },
        },
      ]),
      ...deps,
    });
    const byIdDegenerate = apiDegenerate.workspacesById();
    equal(
      apiDegenerate.parentWorkspaceName(byIdDegenerate["ws-x"], byIdDegenerate),
      "wt-x",
      "no repo_name and no path falls back to the workspace label, not undefined",
    );
    ok(
      apiDegenerate.contextMeta(byIdDegenerate["ws-x"]).startsWith("wt-x"),
      "contextMeta never renders undefined for degenerate worktree metadata",
    );
  });
});
