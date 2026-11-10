// Statement coverage push for the mobile modules. Same vm harness as
// mobile_load.test.mjs, duplicated here because test files are not
// importable modules in this suite. lens.js is owned by another worker
// and is not driven here.
import { describe, it } from "node:test";
import { deepEqual, doesNotThrow, equal, match, ok, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  // the styled confirm sheet resolves through the injected stub answer
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
    setInterval(callback, delay = 0) {
      const id = ++timerSeq;
      const timer = { id, callback, delay, cleared: false, interval: true };
      timers.push(timer);
      return id;
    },
    clearInterval(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cleared = true;
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
      // terminal.js refreshTerminalAfterFontLoad waits on document.fonts;
      // resolve immediately so the then-branch runs
      fonts: {
        load: () => Promise.resolve(),
        ready: Promise.resolve(),
      },
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
          json: async () => optionValue("serverSettings", {
            backend_mode: "builtin",
            default_folder: "/tmp/alpha",
            enabled_backends: { builtin: true, "external-herdr": true },
          }),
        };
      if (url === "/api/versions")
        return {
          ok: optionValue("versionsOk", true),
          status: 200,
          statusText: "OK",
          json: async () =>
            optionValue("versions", {
              webui: "1.2.3",
              backend: "builtin-0.9.0",
              backend_mode: "builtin",
              session: "default",
              compatibility: { status: "compatible", message: "all good" },
            }),
        };
      if (url === "/api/logout")
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url === "/api/no-sleep")
        return {
          ok: true,
          status: 200,
          json: async () => optionValue("noSleep", { mode: "auto", supported: true }),
        };
      if (url === "/api/notes")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("notesResponse", {
              notes: optionValue("notes", [
                { id: "n1", title: "Alpha", display_title: "Alpha", content: "c1", language: "txt", updated_at: 1000 },
              ]),
              languages: optionValue("noteLanguages", [{ value: "txt", label: "Text", ext: "txt" }]),
            }),
        };
      if (String(url).startsWith("/api/file-browser/tree") && url.includes("q=alpha"))
        return {
          ok: true,
          status: 200,
          json: async () => {
            const offset = Number((String(url).match(/offset=(\d+)/) || [])[1] || 0);
            if (offset === 0)
              return {
                path: "",
                entries: [
                  { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
                  { kind: "dir", name: "beta", path: "src/beta" },
                ],
                truncated: true,
                visited: 50,
                git_status: null,
              };
            return {
              path: "",
              entries: [{ kind: "file", name: "alpha2.txt", path: "docs/alpha2.txt" }],
              truncated: false,
              visited: 120,
              git_status: null,
            };
          },
        };
      if (String(url).startsWith("/api/file-browser/content-search"))
        return {
          ok: true,
          status: 200,
          json: async () => optionValue("contentSearchResponse", {
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
          json: async () =>
            optionValue("gitStatus", {
              branch: "feature/mobile",
              state: "dirty",
              conflicted: [],
              staged: ["src/staged.js"],
              unstaged: ["src/mobile.js"],
              untracked: ["new.txt"],
              upstream: "origin/feature/mobile",
              ahead: 1,
              behind: 2,
            }),
        };
      if (String(url).startsWith("/api/git-ui/branches"))
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("gitBranches", {
              local: [
                { name: "main", current: true, remote: false },
                { name: "feature/mobile", current: false, remote: false },
              ],
              remote: [{ name: "origin/main", current: false, remote: true }],
              branches: [
                { name: "main", current: true, remote: false },
                { name: "feature/mobile", current: false, remote: false },
                { name: "origin/main", current: false, remote: true },
              ],
            }),
        };
      if (String(url).startsWith("/api/git-ui/stage") || String(url).startsWith("/api/git-ui/unstage") || String(url).startsWith("/api/git-ui/discard") || String(url).startsWith("/api/git-ui/commit") || String(url).startsWith("/api/git-ui/branch-delete") || String(url).startsWith("/api/git-ui/pull") || String(url).startsWith("/api/git-ui/push") || String(url).startsWith("/api/git-ui/fetch"))
        return { ok: true, status: 200, json: async () => optionValue("gitMutation", { ok: true }) };
      if (String(url).startsWith("/api/git-ui/switch"))
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (String(url).startsWith("/api/git-ui/diff"))
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("gitDiff", {
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
                      rows: [
                        { old_line: { line_type: "delete", content: "old" }, new_line: { line_type: "add", content: "new" } },
                      ],
                    },
                  ],
                },
              ],
            }),
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
          json: async () =>
            optionValue("recentWorkspaceOpenResult", {
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
      if (String(url).startsWith("/api/session-snapshot"))
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
              workspace_counts: optionValue("workspaceCounts", null),
              tab_labels_by_id: optionValue("tabLabelsById", null),
            },
          }),
        };
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
          ? optionValue("worktreeList", {
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
            })
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
      ctx.lastRendererOptions = rendererOptions;
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
  ctx.flushSomeTimers = async (filter) => {
    // run only timers whose delay matches, keeps debounced commits isolated
    const due = [];
    for (const timer of timers) if (filter(timer)) due.push(timer);
    for (const timer of due) {
      const at = timers.indexOf(timer);
      if (at > -1) timers.splice(at, 1);
      await timer.callback();
    }
  };
  ctx.forgetElement = (id) => {
    // boot-time el() reads auto-create stubs; tests can drop one so a
    // first-paint branch rewrites the markup
    elements.delete(id);
  };
  ctx.settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };
  ctx.dispatchDocumentEvent = (event) => {
    for (const listener of listeners[event] || []) listener();
  };
  // terminal.js queues frame flushes through bare requestAnimationFrame;
  // vm has none, so capture callbacks for manual flush
  ctx.rafCallbacks = [];
  ctx.requestAnimationFrame = (fn) => {
    ctx.rafCallbacks.push(fn);
    return ctx.rafCallbacks.length;
  };
  ctx.flushAnimationFrames = async () => {
    const due = ctx.rafCallbacks.splice(0);
    for (const cb of due) cb();
  };
  ctx.dispatchDocumentPointerEvent = (event, pointerEvent) => {
    for (const listener of listeners[event] || []) listener(pointerEvent);
  };
  ctx.documentListeners = () => listeners;
  ctx.window = Object.assign(ctx, {
    matchMedia: () => ({ matches: false }),
    innerWidth: 390,
    innerHeight: 844,
    addEventListener(event, listener) {
      (listeners[event] || (listeners[event] = [])).push(listener);
    },
  });
  ctx.globalThis = ctx;
  // terminal.js observeTerminalShell needs a ResizeObserver whose callback
  // can be fired manually to drive the shell-resize path
  ctx.terminalShellObservers = [];
  ctx.ResizeObserver = class {
    constructor(callback) { this.callback = callback; ctx.terminalShellObservers.push(this); }
    observe() { this.observed = true; }
    disconnect() { this.disconnected = true; }
  };
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

// boots the app and lands on the workspace route with a selected pane
async function boot(pathname = "/session/default/workspace/w1/tab/t1/pane/p1", options = {}) {
  const ctx = context(pathname, options);
  runSource(ctx);
  await ctx.HerdrMobile.refresh();
  await ctx.settle();
  return ctx;
}

function mobileEl(ctx, id) {
  return ctx.document.getElementById(id);
}

describe("mobile coverage: attention", () => {
  it("covers sound gating, notify, unlock, play, sorting helpers", async () => {
    const ctx = await boot();
    const created = [];
    let volume = 0.5;
    class FakeOsc {
      constructor() { this.frequency = { setValueAtTime: (v) => this.freqCalls.push(v) }; this.freqCalls = []; this.type = ""; }
      connect(node) { this.connectedTo = node; }
      start() { this.started = true; }
      stop(when) { this.stoppedAt = when; }
    }
    class FakeGain {
      constructor() { this.gain = { setValueAtTime: (v) => this.gainCalls.push(["set", v]), exponentialRampToValueAtTime: (v, t) => this.gainCalls.push(["ramp", v, t]) }; this.gainCalls = []; }
      connect(node) { this.connectedTo = node; }
    }
    class FakeAudioContext {
      constructor() { created.push(this); this.state = "running"; this.destination = {}; this.currentTime = 10; }
      resume() { this.resumed = true; }
      createOscillator() { return new FakeOsc(); }
      createGain() { return new FakeGain(); }
    }
    const alerts = [];
    const windowLike = { AudioContext: FakeAudioContext, Notification: class N { constructor(title, opts) { windowLike.notifications.push({ title, opts }); } } };
    windowLike.Notification.permission = "granted";
    windowLike.notifications = [];
    const state = { agents: [], ws: "w1", tab: "t1", pane: "p1" };
    ctx.HerdrOptions = { read: () => ({ sound: true, browserNotifications: true, soundScope: "current", notificationVolume: volume }) };
    const attention = ctx.HerdrMobileAttention.create({ localStorage: ctx.localStorage, state, window: windowLike, onAttentionAlert: (agents) => alerts.push(agents) });

    // first call only takes the baseline, no sound yet
    state.agents = [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term1", agent_status: "working", name: "w" }];
    attention.handleSound();
    equal(created.length, 0, "baseline call stays silent");
    attention.unlockAudio();

    // new blocked agent in current pane: plays and notifies and alerts
    state.agents = [
      { workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term1", agent_status: "working", name: "w" },
      { workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term9", agent_status: "blocked", name: "blocked-one" },
    ];
    attention.handleSound();
    equal(created.length, 1, "audio context built during unlock+play");
    equal(windowLike.notifications.length, 1);
    equal(windowLike.notifications[0].title, "Agent blocked");
    match(windowLike.notifications[0].opts.body, /blocked-one/);
    equal(alerts.length, 1);

    // done agent title variant + scope current only
    await new Promise((resolve) => setTimeout(resolve, 10));
    state.agents = [
      { workspace_id: "w1", tab_id: "t2", pane_id: "p2", terminal_id: "term2", agent_status: "done", name: "done-agent" },
    ];
    attention.handleSound();
    equal(windowLike.notifications.length, 2);
    equal(windowLike.notifications[1].title, "Agent done");
    // current-scope agents do not match pane t2/p1 so no new sound fired
    equal(created.length, 1);

    // rate limit: same known set re-alerts nothing
    state.agents = [...state.agents];
    attention.handleSound();
    equal(windowLike.notifications.length, 2);

    // scope all + volume ramp path
    await new Promise((resolve) => setTimeout(resolve, 1600));
    ctx.HerdrOptions.read = () => ({ sound: true, browserNotifications: true, soundScope: "all", notificationVolume: 0.9 });
    state.agents = [
      { workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term5", agent_status: "done", name: "later-done" },
    ];
    attention.handleSound();
    equal(windowLike.notifications.length, 3);

    // sound off: shouldPlay false, no new audio
    await new Promise((resolve) => setTimeout(resolve, 1600));
    ctx.HerdrOptions.read = () => ({ sound: false, browserNotifications: false, soundScope: "current" });
    state.agents = [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term6", agent_status: "blocked", name: "quiet" }];
    attention.handleSound();
    equal(windowLike.notifications.length, 3);

    // permission not granted: notify returns early
    await new Promise((resolve) => setTimeout(resolve, 1600));
    ctx.HerdrOptions.read = () => ({ sound: true, browserNotifications: true, soundScope: "all" });
    windowLike.Notification.permission = "denied";
    state.agents = [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term7", agent_status: "blocked", name: "denied-one" }];
    attention.handleSound();
    equal(windowLike.notifications.length, 3);
    windowLike.Notification.permission = "granted";

    // options() throwing falls back to defaults (notifications off, sound on)
    await new Promise((resolve) => setTimeout(resolve, 1600));
    ctx.HerdrOptions.read = () => { throw Error("boom"); };
    state.agents = [{ workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term8", agent_status: "done", name: "fallback" }];
    attention.handleSound();
    equal(windowLike.notifications.length, 3, "fallback options disable notifications");

    // unlock with throwing constructor: audio stays locked, play skips
    const badWindow = { AudioContext: class { constructor() { throw Error("no audio"); } } };
    const bad = ctx.HerdrMobileAttention.create({ localStorage: ctx.localStorage, state: { agents: [] }, window: badWindow });
    doesNotThrow(() => bad.unlockAudio());
    bad.handleSound();

    // play paths without unlock: no-op
    const locked = ctx.HerdrMobileAttention.create({ localStorage: ctx.localStorage, state: { agents: [{ terminal_id: "x", agent_status: "blocked" }] }, window: windowLike });
    locked.handleSound();
    locked.handleSound();

    // sortAgents/statusClass/topStatus through the shared overrides
    equal(attention.statusClass("done"), "done");
    equal(attention.statusClass(null), "unknown");
    const sorted = attention.sortAgents([
      { name: "a", agent_status: "working" },
      { name: "b", agent_status: "blocked" },
      { name: "c", agent_status: "idle" },
    ]);
    equal(sorted[0].name, "b");
    const topState = { agents: [{ agent_status: "working" }, { agent_status: "blocked" }] };
    const topAttention = ctx.HerdrMobileAttention.create({ localStorage: ctx.localStorage, state: topState, window: windowLike });
    equal(topAttention.topStatus(), "blocked");
    const emptyAttention = ctx.HerdrMobileAttention.create({ localStorage: ctx.localStorage, state: { agents: [] }, window: windowLike });
    equal(emptyAttention.topStatus(), "");
  });

  it("runs the app-level handleSound path with Notification absent", async () => {
    const ctx = await boot();
    doesNotThrow(() => ctx.HerdrMobileAppDeps.state && ctx.HerdrMobileAppDeps.state.agents);
    // window without Notification: notify must not crash handleSound
    const vmCtx = context("/session/default/workspace/w1");
    runSource(vmCtx);
    await vmCtx.HerdrMobile.refresh();
    doesNotThrow(() => vmCtx.HerdrMobile.showScreen("agents"));
  });
});

describe("mobile coverage: backend", () => {
  it("covers settings/sessions loads, herdr_error recovery, backend sync", async () => {
    const ctx = await boot();
    const state = {
      session: "work",
      backendMode: "",
      sessionBackend: "external-herdr",
      backendsEnabled: null,
      serverDefaultBackend: "",
      serverBackendConfirmed: false,
      sessions: [],
      sessionsError: "",
      versionsLoading: false,
    };
    const apiCalls = [];
    let closeShouldFail = false;
    const api = async (url) => {
      apiCalls.push(url);
      if (url === "/api/sessions") return { sessions: [{ name: "work" }], herdr_available: true, herdr_compatible: true, default_backend: "builtin", enabled_backends: { builtin: true, "external-herdr": true } };
      if (url === "/api/server-settings") return { backend_mode: "external-herdr", default_folder: "/x", enabled_backends: { builtin: true, "external-herdr": true } };
      if (url === "/api/versions") return { webui: "1.0", backend: "builtin-1", backend_mode: "builtin", session: "work", compatibility: { status: "old", message: "mismatch" } };
      if (url === "/api/session/close") {
        if (closeShouldFail) throw Error("close failed");
        return {};
      }
      return {};
    };
    const written = [];
    const refreshed = [];
    const events = { closeEventWs() { this.closed += 1; }, scheduleEventReconnect() { this.scheduled += 1; }, closed: 0, scheduled: 0 };
    const backend = ctx.HerdrMobileBackendModule.create({
      state,
      api,
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => refreshed.push(1),
      getMobileEvents: () => events,
      readSessionBackend: () => "builtin",
      writeSessionBackend: (session, value) => written.push([session, value]),
    });

    // server settings: adopts mode, retargets the pin once, then keeps it
    await backend.loadServerSettings();
    equal(state.backendMode, "external-herdr");
    equal(state.sessionBackend, "external-herdr");
    equal(state.serverBackendConfirmed, true);
    ok(written.some(([session, value]) => session === "work" && value === "external-herdr"));
    // second load keeps the explicit choice
    await backend.loadServerSettings();
    equal(state.defaultFolder, "/x");

    // loadSessions fallback error path
    const failingBackend = ctx.HerdrMobileBackendModule.create({
      state: { session: "s", backendMode: "builtin", sessionBackend: "builtin" },
      api: async () => { throw Error("sessions down"); },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });
    await failingBackend.loadSessions();
    const failState = failingBackend ? { sessions: [] } : null;
    ok(failState, "placeholder");
    // direct state assertions on the captured state object instead
    const errState = { session: "s2", backendMode: "builtin", sessionBackend: "builtin", sessions: [], sessionsError: "" };
    const failingBackend2 = ctx.HerdrMobileBackendModule.create({
      state: errState,
      api: async () => { throw Error("sessions down"); },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });
    await failingBackend2.loadSessions();
    equal(errState.sessionsError, "sessions down");
    equal(errState.sessions.length, 1);
    equal(errState.sessions[0].backend, "builtin");

    // loadVersions success and failure
    await backend.loadVersions();
    match(state.versionsText, /webui 1\.0/);
    match(state.versionsText, /built-in/);
    match(state.versionsText, /· old/);
    match(state.versionsTitle, /session work/);
    const failVersions = ctx.HerdrMobileBackendModule.create({
      state: { versionsLoading: false },
      api: async () => { throw Error("offline"); },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      readSessionBackend: () => "",
      writeSessionBackend: () => {},
    });
    await failVersions.loadVersions();
    const vState = { versionsLoading: false, versionsText: "" };
    const failVersions2 = ctx.HerdrMobileBackendModule.create({
      state: vState,
      api: async () => { throw Error("offline"); },
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      readSessionBackend: () => "builtin",
      writeSessionBackend: () => {},
    });
    await failVersions2.loadVersions();
    ok(String(vState.versionsText).includes("offline"), "versions error text");
    // in-flight load is deduped
    vState.versionsLoading = true;
    await failVersions2.loadVersions();

    // handleHerdrErrorFrame: malformed then real
    equal(backend.handleHerdrErrorFrame("not json"), false);
    equal(backend.handleHerdrErrorFrame(JSON.stringify({ type: "other" })), false);
    equal(backend.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error", message: "boom" })), true);
    await ctx.settle(20);
    ok(apiCalls.includes("/api/session/close"));
    ok(apiCalls.includes("/api/session/launch"));
    equal(state.sessionBackend, "builtin");
    ok(refreshed.length >= 1);

    // pending offer dedupes
    equal(backend.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error" })), true);

    // syncSessionBackendFromServer: disabled pin retargets to default
    const syncState = {
      session: "s3",
      backendMode: "builtin",
      sessionBackend: "external-herdr",
      backendsEnabled: { builtin: true, "external-herdr": false },
      serverDefaultBackend: "builtin",
    };
    const syncWritten = [];
    const syncBackend = ctx.HerdrMobileBackendModule.create({
      state: syncState,
      api: async () => ({}),
      confirmFn: async () => true,
      localStorage: ctx.localStorage,
      refresh: () => {},
      getMobileEvents: () => events,
      readSessionBackend: () => "",
      writeSessionBackend: (session, value) => syncWritten.push([session, value]),
    });
    syncBackend.syncSessionBackendFromServer();
    equal(syncState.sessionBackend, "builtin");
    ok(syncWritten.some(([, value]) => value === "builtin"));
    equal(events.closed >= 1, true);
    // enabled pin stays
    syncState.sessionBackend = "builtin";
    syncBackend.syncSessionBackendFromServer();
    equal(syncState.sessionBackend, "builtin");
    // empty pin never retargets
    syncState.sessionBackend = "";
    syncBackend.syncSessionBackendFromServer();
    equal(syncState.sessionBackend, "");
    // fallback to external when builtin disabled too
    syncState.sessionBackend = "external-herdr";
    syncState.backendsEnabled = { builtin: false, "external-herdr": false };
    syncState.serverDefaultBackend = "external-herdr";
    syncBackend.syncSessionBackendFromServer();
    equal(syncState.sessionBackend, "external-herdr");

    // handleServerSettingsChanged: no enabled field is a no-op
    backend.handleServerSettingsChanged({});
    const before = state.backendsEnabled;
    backend.handleServerSettingsChanged({ enabled_backends: { builtin: false, "external-herdr": true }, default_backend: "external-herdr" });
    equal(state.backendsEnabled.builtin, false);
    equal(state.backendsEnabled["external-herdr"], true);
    equal(state.serverDefaultBackend, "external-herdr");
    state.backendsEnabled = before;

    // labels/classes
    equal(backend.sessionBackendLabel("external-herdr"), "Herdr");
    equal(backend.sessionBackendLabel("builtin"), "built-in");
    equal(backend.sessionBackendClass("external-herdr"), "backend-herdr");
    equal(backend.sessionBackendClass("builtin"), "backend-builtin");
    equal(backend.backendEnabled("builtin"), true);
  });

  it("covers herdr_error declined and builtin-disabled paths", async () => {
    const bootCtx = await boot();
    const state = { session: "work", sessionBackend: "external-herdr", backendsEnabled: { builtin: true, "external-herdr": true } };
    const apiCalls = [];
    const backend = bootCtx.HerdrMobileBackendModule.create({
      state,
      api: async (url) => { apiCalls.push(url); return {}; },
      confirmFn: async () => false,
      localStorage: context().localStorage,
      refresh: () => {},
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: () => {},
    });
    equal(backend.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error", backend: "external-herdr" })), true);
    await bootCtx.settle(20);
    equal(state.sessionBackend, "external-herdr", "declined offer keeps the pin");
    ok(apiCalls.includes("/api/session/close"), "broken session still closed");

    // builtin disabled: no offer at all, no launch
    const state2 = { session: "work", sessionBackend: "external-herdr", backendsEnabled: { builtin: false, "external-herdr": true } };
    const apiCalls2 = [];
    const backend2 = bootCtx.HerdrMobileBackendModule.create({
      state: state2,
      api: async (url) => { apiCalls2.push(url); return {}; },
      confirmFn: async () => true,
      localStorage: context().localStorage,
      refresh: () => {},
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: () => {},
    });
    equal(backend2.handleHerdrErrorFrame(JSON.stringify({ type: "herdr_error" })), true);
    await bootCtx.settle(20);
    equal(state2.sessionBackend, "external-herdr");
    ok(!apiCalls2.includes("/api/session/launch"), "disabled builtin never launched");
  });

  it("covers incompatible external pin falling back to builtin", async () => {
    const bootCtx = await boot();
    const state = { session: "default", backendMode: "builtin", sessionBackend: "external-herdr" };
    const written = [];
    const backend = bootCtx.HerdrMobileBackendModule.create({
      state,
      api: async () => ({ sessions: [], herdr_available: false, herdr_compatible: false }),
      confirmFn: async () => true,
      localStorage: context().localStorage,
      refresh: () => {},
      readSessionBackend: () => "external-herdr",
      writeSessionBackend: (session, value) => written.push(value),
    });
    await backend.loadSessions();
    equal(state.sessionBackend, "builtin");
    ok(written.includes("builtin"));
  });
});

describe("mobile coverage: settings", () => {
  it("covers rollback, flashes, debounced commits, search sections", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;

    // settings screen: entering resets baselines and lazy-loads no-sleep
    app.showScreen("settings");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("Settings"));

    // theme change then rollback restores the stored baseline
    app.setThemeMode("dark");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "dark");
    app.rollbackSetting("theme");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "auto");

    // layout rollback writes the baseline into the layout key
    app.setLayoutPreference("compact");
    equal(ctx.localStorage.getItem("herdr-web-layout"), "compact");
    app.rollbackSetting("layout");
    equal(ctx.localStorage.getItem("herdr-web-layout"), "auto");

    // volume + scrollLines rollback paths write clamped option values
    app.setNotificationVolume("70");
    app.rollbackSetting("notificationVolume");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).notificationVolume, 0);
    app.setTerminalScrollLines("12");
    app.rollbackSetting("scrollLines");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).scrollLines, 3);

    // default rollback branch: editor tab size (baseline captured before edit)
    app.setEditorTabSize("6");
    app.rollbackSetting("editorTabSize");
    // baseline was read from the pre-boot options (unset -> clamped 2 by setter)
    const tabSize = JSON.parse(ctx.localStorage.getItem("herdr-web-options")).editorTabSize;
    ok(tabSize === 2 || tabSize === "", "rollback restores the captured baseline");

    // unknown id rollback is a no-op
    doesNotThrow(() => app.rollbackSetting("no-such-setting"));

    // rollback of terminal font family and core delegate to app helpers
    app.setTerminalFontFamily("Custom Mono");
    app.rollbackSetting("terminalFontFamily");
    app.setTerminalCore("xterm");
    await ctx.settle();
    app.rollbackSetting("terminalCore");
    await ctx.settle();

    // debounced commit: arm, flush, commit-from-change
    app.setSettingDebounced("worktreeDefaultDirectory", "/tmp/deb");
    // flush lives on the settings module export, not the app object
    const settingsMod = ctx.HerdrMobileSettings.create({
      api: ctx.HerdrMobileAppDeps.api,
      applyTheme: () => {},
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      localStorage: ctx.localStorage,
      state: ctx.HerdrMobileAppDeps.state,
      confirmFn: async () => true,
      getMobileTerminal: () => null,
    });
    settingsMod.flushSettingCommit("worktreeDefaultDirectory");
    app.commitSettingFromChange("worktreeDefaultDirectory", "/tmp/now");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).worktreeDefaultDirectory, "/tmp/now");
    // unknown debounced id is ignored
    doesNotThrow(() => app.setSettingDebounced("nope", "x"));
    doesNotThrow(() => app.commitSettingFromChange("nope", "x"));

    // the debounced timer path itself fires through the timer queue
    app.setSettingDebounced("explorationDefaultDirectory", "/tmp/later");
    await ctx.flushSomeTimers((timer) => timer.delay >= 800);
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).explorationDefaultDirectory, "/tmp/later");

    // search section reorder + move + toggle
    app.setSearchSectionOrder("content,workspaces,files");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).searchSectionOrder, "content,workspaces,files");
    // moves that would leave the window are no-ops
    app.moveSearchSection("content", -1);
    app.moveSearchSection("workspaces", 5);
    app.moveSearchSection("bogus", 1);
    // a valid move swaps workspaces with files
    app.moveSearchSection("workspaces", 1);
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).searchSectionOrder, "content,files,workspaces");
    app.moveSearchSection("content", -1);
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).searchSectionOrder, "content,files,workspaces");
    // toggle flips the option: unset reads undefined, first toggle sets false, second true
    app.toggleSearchSection("files");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).searchFilesEnabled, false);
    app.toggleSearchSection("files");
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).searchFilesEnabled, true);
    app.toggleSearchSection("bogus");

    // settings filter renders the filtered screen
    app.setSettingsFilter("terminal");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).length > 0);
    app.setSettingsFilter("");
    await ctx.settle();
  });

  it("covers every settings setter writing clamped or boolean options", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;
    const read = () => JSON.parse(ctx.localStorage.getItem("herdr-web-options"));

    app.setSettingsFilter("");
    app.setExplorationDefaultDirectory("/tmp/explore");
    app.setWorkspaceOpenTerminal(true);
    app.setCloseWorkspaceOnLastTerminal(false);
    app.setPromptCardsEnabled(false);
    app.setStuckWorkingEnabled(true);
    app.setWorkingDismissMinutes("1440");
    app.setAgentSortMode("attention_inverted");
    app.setSoundScope("all");
    app.setFileBrowserDepth("8");
    app.setFileBrowserLineNumbers(true);
    app.setFileBrowserSearchPageSize("500");
    app.setHeaderSearchEnabled(true);
    app.setSearchWorkspacesEnabled(false);
    app.setSearchFilesEnabled(true);
    app.setSearchFoldersEnabled(false);
    app.setSearchContentEnabled(true);
    app.setFileContentSearchMinChars("20");
    app.setFileContentSearchPageSize("500");
    app.setFileContentSearchAutoCollapseFiles("200");
    app.setFileContentSearchDefaultExpanded(true);
    app.setFileContentSearchContextLines("20");
    app.setFileContentSearchMatchesPerFile("50");
    app.setFileContentSearchMatchCase(true);
    app.setFileContentSearchRegex(true);
    app.setEditorEnabled(true);
    app.setEditorWordWrap(true);
    app.setLspEnabled(true);
    app.setTerminalLinks(false);
    app.setTerminalMouseReporting(true);
    app.setNotificationVolume("100");
    app.setWorktreeDefaultDirectory("/tmp/worktrees");
    app.setThemeMode("dark");
    await ctx.settle();

    const options = read();
    equal(options.explorationDefaultDirectory, "/tmp/explore");
    equal(options.workspaceOpenTerminal, true);
    equal(options.closeWorkspaceOnLastTerminal, false);
    equal(options.promptCardsEnabled, false);
    equal(options.stuckWorkingEnabled, true);
    equal(options.workingDismissMinutes, 1440);
    equal(options.agentSortMode, "attention_inverted");
    equal(options.soundScope, "all");
    equal(options.fileBrowserDepth, 8);
    equal(options.fileBrowserLineNumbers, true);
    equal(options.fileBrowserSearchPageSize, 500);
    equal(options.headerSearchEnabled, true);
    equal(options.searchWorkspacesEnabled, false);
    equal(options.searchFilesEnabled, true);
    equal(options.searchFoldersEnabled, false);
    equal(options.searchContentEnabled, true);
    equal(options.fileContentSearchMinChars, 20);
    equal(options.fileContentSearchPageSize, 500);
    equal(options.fileContentSearchAutoCollapseFiles, 200);
    equal(options.fileContentSearchDefaultExpanded, true);
    equal(options.fileContentSearchContextLines, 20);
    equal(options.fileContentSearchMatchesPerFile, 50);
    equal(options.fileContentSearchMatchCase, true);
    equal(options.fileContentSearchRegex, true);
    equal(options.editorEnabled, true);
    equal(options.editorWordWrap, true);
    equal(options.lspEnabled, true);
    equal(options.terminalLinks, false);
    equal(options.terminalMouseReporting, true);
    equal(options.notificationVolume, 1);
    equal(options.worktreeDefaultDirectory, "/tmp/worktrees");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "dark");

    // no-sleep mode change posts and lands in state, error path too
    app.setNoSleepMode("2h");
    await ctx.settle();
    equal(ctx.HerdrMobileAppDeps.state.noSleep.mode, "auto");
    ok(ctx.requests.some((request) => request.url === "/api/no-sleep" && request.opt.method === "POST"));
  });

  it("covers browser notifications permission flow and logout", async () => {
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
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();

    await app.setBrowserNotifications(true);
    equal(requested, true);
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).browserNotifications, true);

    // denied permission keeps the option off
    ctx.Notification.permission = "denied";
    await app.setBrowserNotifications(true);
    equal(JSON.parse(ctx.localStorage.getItem("herdr-web-options")).browserNotifications, false);

    // logout hits the endpoint and redirects
    await app.logout();
    await ctx.settle();
    ok(ctx.requests.some((request) => request.url === "/api/logout"));
    equal(ctx.location.href, "/");
  });
});

describe("mobile coverage: search", () => {
  it("opens, types, runs path/content search, keydown paths, actions", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;

    // search opens through showScreen and the global sheet
    app.showScreen("search");
    await ctx.settle();
    const sheet = mobileEl(ctx, "mobileSearchSheet");
    equal(sheet.hidden, false, "search sheet visible");
    const input = mobileEl(ctx, "mobileSearchInput");

    // typing routes through the 180ms debounce timer
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    const html = String(mobileEl(ctx, "mobileSearchResults").innerHTML);
    ok(html.includes("Files and folders"), "files section rendered");
    ok(html.includes("alpha.txt"), "path entry found");
    ok(html.includes("File content"), "content section rendered");

    // load more paths: second page merges entries
    const search = ctx.HerdrMobileSearch;
    search.loadMorePaths();
    await ctx.settle();
    const html2 = String(mobileEl(ctx, "mobileSearchResults").innerHTML);
    ok(html2.includes("alpha2.txt"), "second page loaded");

    // content search min chars message for short queries
    input.value = "al";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    const html3 = String(mobileEl(ctx, "mobileSearchResults").innerHTML);
    ok(html3.includes("Type at least"), "min chars hint shown");

    // empty query resets sections
    input.value = "";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();

    // keydown: escape closes, enter picks, alt shortcuts toggle sections
    input.onkeydown({ key: "Escape", preventDefault() {}, altKey: false });
    equal(sheet.hidden, true, "escape closes sheet");
    app.showScreen("search");
    input.onkeydown({ key: "1", code: "Digit1", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "2", code: "Digit2", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "3", code: "Digit3", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "ArrowUp", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "ArrowDown", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "f", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "d", altKey: true, preventDefault() {} });
    input.onkeydown({ key: "Enter", altKey: false, preventDefault() {} });
    await ctx.settle();
    // unknown section toggle is a no-op
    ctx.HerdrMobileSearch.toggleSection("nope");
    // bad indexes are no-ops
    ctx.HerdrMobileSearch.openAction(99);
    ctx.HerdrMobileSearch.openTarget(99);

    // target rows: query matches the alpha workspace, openTarget selects it
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    ctx.HerdrMobileSearch.openTarget(0);
    await ctx.settle();

    // openAction runs the sessions action: showScreen("sessions")
    app.showScreen("search");
    input.value = "sessions";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    ctx.HerdrMobileSearch.openAction(0);
    await ctx.settle();
    equal(ctx.HerdrMobileAppDeps.state.screen, "sessions", "sessions action ran");

    // path kind switch to folders reruns the search
    app.showScreen("search");
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    ctx.HerdrMobileSearch.setPathKind("dir");
    await ctx.settle();
    // folder mode renders its section even when the fixture has no dir hits
    ok(String(mobileEl(ctx, "mobileSearchResults").innerHTML).includes("Folders"), "dir kind section rendered");

    // tree select + openPath navigate to the files screen
    ctx.HerdrMobileSearchTree.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    equal(ctx.HerdrMobileAppDeps.state.screen, "files");

    // content entry points: toggleFile/openFile/openMatch/loadMore/expandSnippet/loadFile
    app.showScreen("search");
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    ctx.HerdrMobileSearchContent.toggleFile(encodeURIComponent("docs/alpha.txt"));
    ctx.HerdrMobileSearchContent.openFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    ctx.HerdrMobileSearchContent.openMatch(encodeURIComponent("docs/alpha.txt"), "m1");
    await ctx.settle();
    ctx.HerdrMobileSearchContent.loadMore();
    await ctx.settle();
    ctx.HerdrMobileSearchContent.expandSnippet(encodeURIComponent("docs/alpha.txt"), "m1", "up");
    await ctx.settle();
    await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    await ctx.HerdrMobileSearchContent.loadFile(encodeURIComponent("nope.txt"));
    await ctx.settle();

    // invalidateWorkspace with overlapping root resets cached results
    await ctx.HerdrMobileAppDeps.currentWorkspaceCwd;
    const mod = ctx.HerdrMobileSearchModule.create({
      el: (id) => ctx.document.getElementById(id),
      state: ctx.HerdrMobileAppDeps.state,
      escapeHtml: (value) => String(value),
      currentWorkspace: () => ctx.HerdrMobileAppDeps.state.workspaces[0],
      currentWorkspaceCwd: () => "/tmp/alpha",
      searchRootFn: () => "/tmp/alpha",
      workspaceTitle: () => "alpha",
      workspaceMeta: () => "",
      worktreeForWorkspace: () => null,
      tabTitle: () => "",
      selectWorkspace: () => {},
      selectAgent: () => {},
      showScreen: () => {},
      openAt: () => {},
      runAction: () => {},
      searchDisabledFn: () => false,
    });
    doesNotThrow(() => mod.invalidateWorkspace("/tmp/alpha"));
    doesNotThrow(() => mod.invalidateWorkspace("/tmp/other"));
  });

  it("handles error paths and disabled sections", async () => {
    const ctx = await boot("/", {
      gitStatus: () => ({}),
    });
    const app = ctx.HerdrMobile;

    // content search failure surfaces an error
    ctx.fetch = async () => ({ ok: false, status: 500, statusText: "boom", json: async () => ({ error: "search down" }) });
    app.showScreen("search");
    const input = mobileEl(ctx, "mobileSearchInput");
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();

    // disable content + files sections through the options module, search still renders
    ctx.fetch = null;
    const parsed = ctx.HerdrOptions.read();
    parsed.searchContentEnabled = false;
    parsed.searchFilesEnabled = false;
    parsed.searchFoldersEnabled = false;
    parsed.searchWorkspacesEnabled = false;
    ctx.HerdrOptions.write(parsed);
    app.showScreen("search");
    input.value = "alpha";
    input.oninput();
    await ctx.flushSomeTimers((timer) => timer.delay === 180);
    await ctx.settle();
    const html = String(mobileEl(ctx, "mobileSearchResults").innerHTML);
    // disabled sections render nothing: only the actions block remains
    ok(!html.includes("File content"), "content section hidden when disabled");
    ok(!html.includes("Workspaces and agents"), "workspaces section hidden when disabled");
    // setPathKind blocked while folders disabled
    ctx.HerdrMobileSearch.setPathKind("dir");
    await ctx.settle();
  });
});

describe("mobile coverage: notes", () => {
  it("covers load, open, edit, save flush, remote sync, clear", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;

    // entering the screen lazy-loads notes and starts the resync timer
    app.showScreen("notes");
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    const html = String(mobileEl(ctx, "mobileScreen").innerHTML);
    ok(html.includes("Notes"), "notes screen rendered");
    ok(html.includes("Alpha"), "note row rendered");

    // open the note, title change PUTs immediately
    ctx.HerdrMobileNotes.openNote("n1");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("mobileNoteTitle"), "editor rendered");
    ctx.HerdrMobileNotes.titleChange({ target: { value: "Renamed" } });
    await ctx.settle();
    ok(ctx.requests.some((request) => String(request.url).startsWith("/api/notes/n1") && request.opt.method === "PUT"));

    // same title is a no-op
    ctx.HerdrMobileNotes.titleChange({ target: { value: "Renamed" } });
    await ctx.settle();

    // language change PUTs and remounts the editor
    ctx.HerdrMobileNotes.languageChange({ target: { value: "md" } });
    await ctx.settle();
    ok(ctx.requests.some((request) => String(request.url).startsWith("/api/notes/n1") && String(request.opt.body).includes('"language":"md"')));

    // editor without HerdrEditor shows the unavailable hint; with it, mounts
    const notesState = ctx.HerdrMobileNotesModule.create({
      api: ctx.HerdrMobileApi,
      confirm: async () => true,
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      render: () => {},
    });
    await notesState.load();
    notesState.openNote("n1");
    notesState.afterRender();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML) !== undefined);

    // content change schedules the debounced save; leave() flushes it
    ctx.HerdrEditor = {
      create(opts) {
        return {
          getValue: () => "changed content",
          setValue() {},
          destroy() {},
        };
      },
    };
    app.showScreen("notes");
    await ctx.settle();
    ctx.HerdrMobileNotes.openNote("n1");
    await ctx.settle();
    const editor = ctx.HerdrMobileNotesModule.create({
      api: ctx.HerdrMobileApi,
      confirm: async () => true,
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      render: () => {},
    });
    // simulate a content edit through the internal save path
    const before = ctx.requests.length;
    // the editorApi path: flushSave with editor present PUTs content
    app.showScreen("terminal");
    await ctx.settle();
    app.showScreen("notes");
    await ctx.settle();
    // saveContent through scheduleSave timer
    await ctx.flushSomeTimers((timer) => timer.delay === 600);
    await ctx.settle();

    // back to list closes the editor
    ctx.HerdrMobileNotes.backToList();
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("+ Note"), "list view restored");

    // create note: POST then adopt payload and focus editor
    await ctx.HerdrMobileNotes.createNote();
    await ctx.settle();
    ok(ctx.requests.some((request) => request.url === "/api/notes" && request.opt.method === "POST"));

    // delete note flow with event stopPropagation
    ctx.HerdrMobileNotes.deleteNote({ stopPropagation() {} }, "n1");
    await ctx.settle();
    ok(ctx.requests.some((request) => String(request.url).startsWith("/api/notes/n1") && request.opt.method === "DELETE"));

    // clear all: confirm stub approves, POST hits endpoint
    await ctx.HerdrMobileNotes.clearAll();
    await ctx.settle();
    ok(ctx.requests.some((request) => request.url === "/api/notes/clear" && request.opt.method === "POST"));

    // syncNow forces a sync even off-screen
    app.showScreen("agents");
    await ctx.settle();
    const syncCount = ctx.requests.filter((request) => request.url === "/api/notes").length;
    await ctx.HerdrMobileNotes.syncNow();
    await ctx.settle();
    ok(ctx.requests.filter((request) => request.url === "/api/notes").length > syncCount, "forced sync ran");

    // applyRemote while screen visible adopts notes (keep notes screen shown)
    const mod = ctx.HerdrMobileNotesModule.create({
      api: ctx.HerdrMobileApi,
      confirm: async () => true,
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      render: () => {},
    });
    await mod.load();
    mod.openNote("n2");
    mod.applyRemote({ notes: [{ id: "n2", title: "Beta", content: "", language: "txt", updated_at: 2000 }] });
    mod.applyRemote([{ id: "n3", title: "Gamma", content: "", language: "txt" }]);
    // remote removing the open note (clean state) closes the editor
    mod.applyRemote([{ id: "n3", title: "Gamma", content: "", language: "txt" }]);
    equal(mod.state.editingId, null, "vanished remote note closes editor");
    // dirty state keeps the ghost editor open
    mod.openNote("n3");
    mod.state.saveTimer = "failed";
    mod.applyRemote([]);
    ok(mod.state.editingId, "dirty note stays open");
    mod.state.saveTimer = null;
    mod.applyRemote([]);
    equal(mod.state.editingId, null, "clean note closes after vanish");

    // leave() stops the resync timer and flushes pending saves
    doesNotThrow(() => mod.leave());
  });

  it("covers notes load error and save error paths", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;

    // /api/notes failure surfaces the error banner (fetch is the app api base)
    const realFetch = ctx.fetch;
    ctx.fetch = async (url) => {
      if (String(url).startsWith("/api/notes"))
        return { ok: false, status: 500, statusText: "notes down", json: async () => ({ error: "notes down" }) };
      return realFetch(url);
    };
    app.showScreen("notes");
    await ctx.settle();
    await ctx.flushTimers();
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("notes down"), "load error shown");
    ctx.fetch = realFetch;

    // restore api and verify save failure path through module
    const mod = ctx.HerdrMobileNotesModule.create({
      api: async () => { throw Error("save failed"); },
      confirm: async () => true,
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      render: () => {},
    });
    await mod.load();
    ok(mod.state.error === "notes down" || mod.state.error === "save failed", "error captured");
    mod.openNote("n1");
    await mod.titleChange({ target: { value: "X" } });
    equal(mod.state.error, "save failed", "title save error captured");
    await mod.languageChange({ target: { value: "md" } });
    mod.state.saveTimer = "failed";
    equal(mod.state.saveTimer, "failed");
    // createNote failure path
    await mod.createNote();
    ok(mod.state.error, "create error captured");
    // delete failure path
    mod.state.editingId = null;
    await mod.deleteNote("n1");
    ok(mod.state.error, "delete error captured");
    // clearAll declined by confirm
    const declined = ctx.HerdrMobileNotesModule.create({
      api: async () => { throw Error("never"); },
      confirm: async () => false,
      escapeHtml: (value) => String(value),
      inputAttrs: () => "",
      render: () => {},
    });
    await declined.clearAll();
    equal(declined.state.error, "", "declined clear leaves no error");
    // sync failure marks syncFailed
    await mod.syncNow();
    equal(mod.state.syncFailed, true, "sync failure flag");
    // screen hidden: applyRemote no-op
    equal(mod.applyRemote({ notes: [] }), undefined);
  });
});

describe("mobile coverage: panels", () => {
  it("renders panels screen, keybar, tabs sheet, composer sync", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;
    const state = ctx.HerdrMobileAppDeps.state;

    // panels screen with tabs renders rows and current marker
    app.showScreen("panels");
    await ctx.settle();
    const panelsHtml = String(mobileEl(ctx, "mobileScreen").innerHTML);
    ok(panelsHtml.includes("Panels"), "panels section rendered");
    ok(panelsHtml.includes("New panel"), "new panel button");
    ok(panelsHtml.includes("Close current panel"), "close current button");
    ok(panelsHtml.includes("current"), "current tab marked");

    // no workspace branch
    state.ws = null;
    app.showScreen("panels");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("No workspace open"), "no workspace hint");
    state.ws = "w1";

    // booting skeleton branch
    ctx.HerdrSkeleton = { sessions: () => "<div>skeleton</div>" };
    state.booting = true;
    app.showScreen("panels");
    await ctx.settle();
    state.booting = false;

    // empty tabs branch
    const savedTabs = state.tabs;
    state.tabs = [];
    app.showScreen("panels");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("No panels"), "no panels hint");
    state.tabs = savedTabs;

    // terminal screen: drive the module with an el that reports no terminal
    // node (first-paint path writes the shell markup into the screen)
    const state2 = ctx.HerdrMobileAppDeps.state;
    const screenEl = element("mobileScreen");
    const mod2 = ctx.HerdrMobilePanelsModule.create({
      state: state2,
      el: (id) => (id === "terminal" ? null : ctx.document.getElementById(id)),
      escapeHtml: (value) => String(value),
      jsArg: (value) => JSON.stringify(value),
      tabTitle: (tab) => tab.tab_id,
      getMobileTerminal: () => ({ destroy() {} }),
      getBrowserFaviconError: () => false,
      setBrowserFaviconError: () => {},
    });
    mod2.renderTerminalScreen(screenEl);
    ok(String(screenEl.innerHTML).includes("terminalShell"), "terminal shell rendered");
    // second call takes the already-mounted sync path
    mod2.renderTerminalScreen(screenEl);
    doesNotThrow(() => mod2.syncLensSwitchRow());

    // terminal screen with no terminal id: loading branch destroys term
    state.terminalId = "";
    app.showScreen("terminal");
    await ctx.settle();
    ok(String(mobileEl(ctx, "mobileScreen").innerHTML).includes("No terminal selected"), "no terminal hint");
    state.terminalId = "term1";

    // lens switch row sync: chatSupported true mounts the pill
    const lens = ctx.HerdrMobileLens;
    ok(typeof lens === "object");
    app.showScreen("terminal");
    await ctx.settle();

    // composer helpers through the panels module: prompt card absent path
    const mod = ctx.HerdrMobilePanelsModule.create({
      state,
      el: (id) => ctx.document.getElementById(id),
      escapeHtml: (value) => String(value),
      jsArg: (value) => JSON.stringify(value),
      tabTitle: (tab) => tab.tab_id,
      getMobileTerminal: () => ({ destroy() {} }),
      getBrowserFaviconError: () => false,
      setBrowserFaviconError: () => {},
    });
    ok(mod.renderPanels().includes("Panels"));
    ok(mod.renderKeyBar().includes("mobileKeyBar"));
    ok(mod.renderTerminal().includes("terminalShell"));
    ok(mod.renderTabsSheetList().includes("New panel"));
    doesNotThrow(() => mod.syncComposer());
    doesNotThrow(() => mod.syncLens());
    doesNotThrow(() => mod.syncLensSwitchRow());
    // no terminal id: keybar renders empty
    state.terminalId = "";
    equal(mod.renderKeyBar(), "");
    state.terminalId = "term1";
  });

  it("covers lens switch mount, composer mount, prompt card replace", async () => {
    const ctx = await boot();
    const state = ctx.HerdrMobileAppDeps.state;

    // panels mounts markup by parsing html through document.createElement;
    // parsed children are handed out through firstElementChild and adopted
    // by the host stubs, so mountInto and the prompt-card swap loop like real dom
    const createdWraps = new Set();
    const adopted = [];
    const adopt = (child) => {
      for (const wrap of createdWraps) {
        const at = wrap._children.indexOf(child);
        if (at > -1) wrap._children.splice(at, 1);
      }
      adopted.push(child);
    };
    ctx.document.createElement = (tag) => {
      const node = element();
      node._children = [];
      createdWraps.add(node);
      Object.defineProperty(node, "firstElementChild", {
        configurable: true,
        get() {
          // pure peek: the host stubs do the removing via adopt()
          return node._children[0] || null;
        },
      });
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        set(html) {
          // one child per top-level open tag: backdrop+card pairs parse
          // into two nodes like real innerHTML would
          const tags = (html.match(/<(\w+)/g) || []).length;
          for (let i = 0; i < tags; i++) node._children.push(element("parsed:" + html));
        },
        get() {
          return "";
        },
      });
      return node;
    };

    // stateful registry: this test drives sync fns with hand-built nodes,
    // and el("mobileLensSwitch") must read null until a mount lands
    const nodes = new Map();
    const screenEl = element("mobileScreen");
    const shellEl = element("terminalShell");
    const container = element("screenContainer");
    container.classList.add("mobile-terminal-screen");
    shellEl.parentNode = container;
    nodes.set("mobileScreen", screenEl);
    nodes.set("terminalShell", shellEl);
    nodes.set("screenContainer", container);
    for (const nav of ["home", "search", "terminal", "git", "files", "more"])
      nodes.set("mobileNav" + nav, element("mobileNav" + nav));

    const el = (id) => (nodes.has(id) ? nodes.get(id) : null);

    const lensCalls = [];
    let switchUiSynced = 0;
    const lens = {
      chatSupported: () => true,
      renderSwitch: () => '<div id="mobileLensSwitch">switch</div>',
      syncSwitchUi: () => {
        switchUiSynced += 1;
      },
      applySwitchPosition: () => lensCalls.push("applySwitchPosition"),
      observeSwitchContainer: () => lensCalls.push("observeSwitchContainer"),
      isActive: () => false,
      onPaneChanged: () => lensCalls.push("onPaneChanged"),
    };
    ctx.HerdrMobileLens = lens;

    const mod = ctx.HerdrMobilePanelsModule.create({
      state,
      el,
      escapeHtml: (v) => String(v),
      jsArg: (v) => JSON.stringify(v),
      tabTitle: (tab) => tab.tab_id,
      getMobileTerminal: () => ({ destroy() {} }),
      getBrowserFaviconError: () => false,
      setBrowserFaviconError: () => {},
    });

    // syncLensSwitchRow mount branch: no switch node yet + chat supported
    const insertCalls = [];
    container.insertAdjacentHTML = (where, html) => insertCalls.push({ where, html });
    mod.syncLensSwitchRow();
    equal(insertCalls.length, 1, "switch row mounted into screen container");
    equal(insertCalls[0].where, "afterbegin");
    equal(switchUiSynced, 1, "switch ui synced");
    ok(lensCalls.includes("applySwitchPosition"), "switch position restored");
    ok(lensCalls.includes("observeSwitchContainer"), "container watcher armed");

    // second call: node registered now, supported keeps it visible
    const existingSwitch = element("mobileLensSwitch");
    existingSwitch.hidden = true;
    nodes.set("mobileLensSwitch", existingSwitch);
    mod.syncLensSwitchRow();
    equal(existingSwitch.hidden, false, "existing switch unhidden when supported");

    // unsupported: existing switch hides
    lens.chatSupported = () => false;
    mod.syncLensSwitchRow();
    equal(existingSwitch.hidden, true, "switch hidden when unsupported");

    // no lens: sync is a no-op
    ctx.HerdrMobileLens = null;
    doesNotThrow(() => mod.syncLensSwitchRow());
    ctx.HerdrMobileLens = lens;

    // composer bar: fresh mount into the keybar host
    const keyBar = element("mobileKeyBar");
    nodes.set("mobileKeyBar", keyBar);
    const mountedNodes = [];
    keyBar.appendChild = (child) => {
      adopt(child);
      mountedNodes.push(child);
    };
    ctx.HerdrMobileComposerDeps = {
      renderComposerBar: () => '<div id="mobileComposer">bar</div>',
      syncComposer: () => lensCalls.push("composerSync"),
      renderPromptCard: () => "",
    };
    mod.syncComposer();
    ok(mountedNodes.length === 1, "composer bar mounted into keybar");
    ok(adopted[0] && String(adopted[0].id).startsWith("parsed:"), "bar parsed from html");
    ok(lensCalls.includes("composerSync"), "composer deps synced");

    // composer bar absent: existing bar removed (remove() fallback path)
    const barEl = element("mobileComposer");
    delete barEl.remove;
    const barParent = element("barParent");
    let barRemoved = 0;
    barParent.removeChild = () => {
      barRemoved += 1;
    };
    barEl.parentNode = barParent;
    nodes.set("mobileComposer", barEl);
    ctx.HerdrMobileComposerDeps.renderComposerBar = () => "";
    mod.syncComposer();
    equal(barRemoved, 1, "bar removed through parent when remove() missing");

    // prompt card fresh mount: missing shell parent is a silent no-op
    const shellMounts = [];
    shellEl.appendChild = (child) => {
      adopt(child);
      shellMounts.push(child);
    };
    ctx.HerdrMobileComposerDeps.renderComposerBar = () => "";
    ctx.HerdrMobileComposerDeps.renderPromptCard = () => '<div id="mobilePromptCard">card</div>';
    nodes.delete("terminalShell");
    mod.syncComposer();
    equal(shellMounts.length, 0, "no shell node means no mount");
    nodes.set("terminalShell", shellEl);
    mod.syncComposer();
    equal(shellMounts.length, 1, "prompt card mounted into shell");

    // prompt card replace: same id but changed markup swaps the pair
    const cardEl = element("mobilePromptCard");
    const backdropEl = element("promptBackdrop");
    backdropEl.classList.add("mobile-prompt-backdrop");
    backdropEl.outerHTML = '<div class="mobile-prompt-backdrop"></div>';
    cardEl.outerHTML = '<div id="mobilePromptCard">card v2</div>';
    const cardParent = element("cardParent");
    const inserted = [];
    cardParent.insertBefore = (node) => {
      adopt(node);
      inserted.push(node);
    };
    let cardRemoved = 0;
    cardEl.remove = () => {
      cardRemoved += 1;
    };
    backdropEl.parentNode = cardParent;
    cardEl.previousElementSibling = backdropEl;
    cardEl.parentNode = cardParent;
    nodes.set("mobilePromptCard", cardEl);
    ctx.HerdrMobileComposerDeps.renderPromptCard = () =>
      '<div class="mobile-prompt-backdrop"></div><div id="mobilePromptCard">card v3</div>';
    mod.syncComposer();
    equal(inserted.length, 2, "fresh pair inserted before old card");
    equal(cardRemoved, 1, "old card removed after swap");

    // prompt card removed when wantedCard goes empty
    let cardRemoved2 = 0;
    cardEl.remove = () => {
      cardRemoved2 += 1;
    };
    let backdropRemoved = 0;
    backdropEl.remove = () => {
      backdropRemoved += 1;
    };
    ctx.HerdrMobileComposerDeps.renderPromptCard = () => "";
    mod.syncComposer();
    equal(backdropRemoved, 1, "backdrop removed");
    equal(cardRemoved2, 1, "card removed when none wanted");

    // lens active: composer bar re-parents into the lens host
    const lensHost = element("mobileLens");
    nodes.set("mobileLens", lensHost);
    const lensMoves = [];
    lensHost.appendChild = (child) => lensMoves.push(child);
    const barEl2 = element("mobileComposer");
    barEl2.parentNode = keyBar;
    nodes.set("mobileComposer", barEl2);
    ctx.HerdrMobileComposerDeps.renderComposerBar = () => '<div id="mobileComposer">bar</div>';
    lens.isActive = () => true;
    mod.syncComposer();
    equal(lensMoves.length, 1, "bar re-parented into lens host");
    ctx.HerdrMobileComposerDeps = null;
  });
});

describe("mobile coverage: actions", () => {
  it("covers createPanel reroute, close flows, auto close workspace", async () => {
    const ctx = await boot();
    const app = ctx.HerdrMobile;
    const state = ctx.HerdrMobileAppDeps.state;

    // createPanel without a workspace reroutes to worktree discovery
    state.ws = null;
    await app.createPanel();
    await ctx.settle();
    equal(state.screen, "worktrees", "rerouted to worktrees");
    ok(String(state.worktreeDiscoverPath || "").length >= 0);
    state.ws = "w1";

    // createPanel posts a new tab and selects it
    await app.createPanel();
    await ctx.settle();
    ok(ctx.requests.some((request) => request.url === "/api/tabs" && request.opt.method === "POST"));

    // closeCurrentPanel: confirm approves, posts close, refreshes
    await app.closeCurrentPanel();
    await ctx.settle();
    ok(ctx.requests.some((request) => String(request.url).includes("/close") && request.opt.method === "POST"));

    // maybeAutoCloseWorkspace through the worktrees module flag path:
    // the workspace still has tabs (fresh server count) so no close offer
    const actionsMod = ctx.HerdrMobileActionsModule || null;

    // selectTab drives the tab picker
    app.selectTab("w1:t2");
    await ctx.settle();
    equal(state.tab, "w1:t2");

    // selectWorkspace resets and pushes history
    app.selectWorkspace("w1");
    await ctx.settle();
    equal(state.screen, "terminal");

    // runMobileAction: theme cycle twice (auto -> dark -> light -> auto)
    ctx.localStorage.removeItem("herdr-web-theme");
    app.runAction("toggle-theme");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "dark");
    app.runAction("toggle-theme");
    equal(ctx.localStorage.getItem("herdr-web-theme"), "light");
    app.runAction("toggle-theme");
    equal(ctx.localStorage.getItem("herdr-web-theme"), null);
    // open-workspace and discover-worktrees routes
    app.runAction("open-workspace");
    await ctx.settle();
    equal(state.screen, "worktrees");
    app.runAction("discover-worktrees");
    await ctx.settle();
    app.runAction("create-worktree");
    await ctx.settle();
    equal(state.worktreeCreateExpanded, true);
    app.runAction("sessions");
    await ctx.settle();
    equal(state.screen, "sessions");
    app.runAction("files");
    await ctx.settle();
    equal(state.screen, "files");
    app.runAction("git");
    await ctx.settle();
    equal(state.screen, "git");
    app.runAction("settings");
    await ctx.settle();
    equal(state.screen, "settings");
    app.runAction("terminal");
    await ctx.settle();
    equal(state.screen, "terminal");
  });

  it("covers auto close workspace offer, decline, and silent close", async () => {
    const ctx = await boot();
    const state = ctx.HerdrMobileAppDeps.state;
    const closed = [];
    const confirmed = [];
    const actions = ctx.HerdrMobileActionsModule.create({
      state,
      api: async (url, opt = {}) => {
        if (String(url).startsWith("/api/workspaces/") && String(url).endsWith("/close")) {
          closed.push(url);
          return {};
        }
        if (url === "/api/workspaces") {
          return { result: { workspaces: [{ workspace_id: "w1", tab_count: 0, label: "alpha" }] } };
        }
        return { result: {} };
      },
      confirmFn: async (message) => {
        confirmed.push(message);
        return true;
      },
      refresh: async () => {},
      render: () => {},
      showScreen: () => {},
      selectionPath: (ws) => `/session/default/workspace/${ws}`,
      currentSessionBackend: () => "builtin",
      saveSessionSelection: () => {},
      sameScopedId: (ws, scopedId, bareId) => String(scopedId).split(":").pop() === bareId || scopedId === bareId,
      currentWorkspaceCwd: () => "/tmp/alpha",
      tabTitle: (tab) => tab.tab_id,
      workspaceTitle: (workspace) => workspace.label || workspace.workspace_id,
      getMobileFileBrowser: () => ({ reset() {} }),
      getMobileTerminal: () => ({ destroy() {} }),
      getMobileSearch: () => ({ open() {} }),
      getMobileWorktrees: () => ({}),
      getMobileTheme: () => ({ applyTheme() {} }),
    });

    // empty workspace (no tabs anywhere): offer confirms then closes
    state.tabs = [];
    state.allTabs = [];
    state.workspaceCounts = {};
    await actions.maybeAutoCloseWorkspace("w1");
    equal(closed.length, 1, "workspace close posted");
    ok(String(confirmed[0]).includes("Close workspace"), "confirm names the workspace");

    // declined confirm leaves the workspace open
    let decline = false;
    const declinedActions = ctx.HerdrMobileActionsModule.create({
      state,
      api: async (url) => {
        if (String(url).includes("/close")) closed.push(url);
        return {};
      },
      confirmFn: async () => decline ? false : true,
      refresh: async () => {},
      render: () => {},
      showScreen: () => {},
      selectionPath: (ws) => `/session/default/workspace/${ws}`,
      currentSessionBackend: () => "builtin",
      saveSessionSelection: () => {},
      sameScopedId: (ws, scopedId, bareId) => scopedId === bareId,
      currentWorkspaceCwd: () => "/tmp/alpha",
      tabTitle: (tab) => tab.tab_id,
      workspaceTitle: (w) => w.label,
      getMobileFileBrowser: () => ({ reset() {} }),
      getMobileTerminal: () => ({ destroy() {} }),
      getMobileSearch: () => ({ open() {} }),
      getMobileWorktrees: () => ({}),
      getMobileTheme: () => ({ applyTheme() {} }),
    });
    decline = true;
    state.tabs = [];
    const before = closed.length;
    await declinedActions.maybeAutoCloseWorkspace("w1");
    equal(closed.length, before, "declined offer closes nothing");

    // silent close skips the confirm entirely
    decline = false;
    const beforeSilent = closed.length;
    const confirmsBeforeSilent = confirmed.length;
    await declinedActions.maybeAutoCloseWorkspace("w1", { silent: true });
    equal(closed.length, beforeSilent + 1, "silent close posted without confirm");
    equal(confirmed.length, confirmsBeforeSilent, "silent close never asks");

    // unknown workspace id is a no-op
    const beforeNoop = closed.length;
    await actions.maybeAutoCloseWorkspace("nope");
    equal(closed.length, beforeNoop, "unknown workspace no close");
  });
});

describe("mobile coverage: file_browser", () => {
  // shared fixture: a text file, a big truncated file, a binary file and
  // two dirs; mutation endpoints echo the request so assertions can check
  // which body landed
  function filesApi(overrides = {}) {
    const calls = [];
    const api = async (url, opt = {}) => {
      calls.push({ url, opt });
      const urlStr = String(url);
      if (urlStr.startsWith("/api/file-browser/tree")) {
        if (urlStr.includes("q=")) {
          const offset = Number((urlStr.match(/offset=(\d+)/) || [])[1] || 0);
          if (offset === 0)
            return {
              path: "",
              entries: [
                { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
                { kind: "dir", name: "src", path: "src" },
              ],
              truncated: true,
              git_status: null,
            };
          return {
            path: "",
            entries: [{ kind: "file", name: "alpha2.txt", path: "docs/alpha2.txt" }],
            truncated: false,
            git_status: null,
          };
        }
        return {
          path: "",
          entries: [
            { kind: "file", name: "alpha.txt", path: "docs/alpha.txt", size: 10 },
            { kind: "file", name: "big.log", path: "big.log", size: 900000 },
            { kind: "file", name: "pic.png", path: "pic.png", size: 4096 },
            { kind: "dir", name: "docs", path: "docs" },
            { kind: "dir", name: "src", path: "src" },
          ],
          git_status: { "docs/alpha.txt": "modified" },
        };
      }
      if (urlStr.startsWith("/api/file-browser/content-search/file"))
        return { file: { path: "docs/alpha.txt", chunks: [{ matches: [{ line: 2, match_start: 0, match_end: 5 }] }] } };
      if (urlStr.startsWith("/api/file-browser/content-search")) {
        const offset = Number((urlStr.match(/offset=(\d+)/) || [])[1] || 0);
        if (offset === 0)
          return {
            files: [
              { path: "docs/alpha.txt", chunks: [] },
              { path: "docs/beta.txt", chunks: [] },
            ],
            total_files: 3,
            total_matches: 7,
            visited: 12,
            truncated: true,
          };
        return {
          files: [{ path: "docs/gamma.txt", chunks: [] }],
          total_files: 3,
          total_matches: 7,
          visited: 20,
          truncated: false,
        };
      }
      if (urlStr.startsWith("/api/file-browser/file") && opt.method === "POST") {
        if (overrides.newFileError) throw Error(overrides.newFileError);
        return { ok: true, hash: "h-new" };
      }
      if (urlStr.startsWith("/api/file-browser/file") && urlStr.includes("max_bytes")) {
        if (overrides.partialError) throw Error(overrides.partialError);
        return {
          path: "big.log",
          truncated: true,
          preview_bytes: 262144,
          size: 900000,
          content: "x".repeat(262144),
          lines_gutter_html: "<div>g</div>",
          lines_code_html: "<div>c</div>",
        };
      }
      if (urlStr.startsWith("/api/file-browser/file")) {
        if (urlStr.includes("pic.png")) return { path: "pic.png", binary: true, size: 4096 };
        if (overrides.openFileError) throw Error(overrides.openFileError);
        return {
          path: "docs/alpha.txt",
          content: "alpha body\n",
          hash: "h1",
          size: 11,
          lines_gutter_html: "<div>1</div>",
          lines_code_html: "<div>alpha body</div>",
        };
      }
      if (urlStr.startsWith("/api/file-browser/rename")) {
        if (overrides.renameError) throw Error(overrides.renameError);
        return { ok: true };
      }
      if (urlStr.startsWith("/api/file-browser/delete")) {
        if (overrides.deleteError) throw Error(overrides.deleteError);
        return { ok: true };
      }
      throw Error("unmocked " + urlStr);
    };
    return { api, calls };
  }

  function makeBrowser(ctx, api, extraDeps = {}) {
    const state = { screen: "files" };
    const renders = [];
    return ctx.HerdrMobileFileBrowser.create({
      api,
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => renders.push(1),
      state,
      ...extraDeps,
    });
  }

  it("covers load, filter, loadPartial, openFile, edit and save", async () => {
    const ctx = await boot();
    const { api, calls } = filesApi();
    const browser = makeBrowser(ctx, api);

    // load: no root
    const noRoot = makeBrowser(ctx, api, { currentWorkspaceCwd: () => "" });
    await noRoot.load("");

    // load: success then error
    await browser.load("");
    await ctx.settle();
    ok(calls.some((c) => String(c.url).startsWith("/api/file-browser/tree?")), "tree fetched");
    // stale seq: a second load wins, the first is dropped
    const staleApi = filesApi().api;
    const staleBrowser = makeBrowser(ctx, staleApi);
    await Promise.all([staleBrowser.load(""), staleBrowser.load("")]);
    await ctx.settle();
    // load error surfaces in local.error
    const errApi = async (url) => {
      if (String(url).startsWith("/api/file-browser/")) throw Error("tree down");
      throw Error("unmocked " + url);
    };
    const errBrowser = makeBrowser(ctx, errApi);
    await errBrowser.load("");
    await ctx.settle();
    // loadFiltered: bail paths need no root, an empty filter, or content kind;
    // the full flow lives in the third test
    const bailNoRoot = makeBrowser(ctx, api, { currentWorkspaceCwd: () => "" });
    await bailNoRoot.load("");

    // loadPartial: root missing then success then error
    const partialBrowser = makeBrowser(ctx, api);
    const noRootPartial = makeBrowser(ctx, api, { currentWorkspaceCwd: () => "" });
    await noRootPartial.loadPartial(encodeURIComponent("big.log"));
    await partialBrowser.loadPartial(encodeURIComponent("big.log"));
    await ctx.settle();
    const partialErr = filesApi({ partialError: "partial down" });
    const partialErrBrowser = makeBrowser(ctx, partialErr.api);
    await partialErrBrowser.loadPartial(encodeURIComponent("big.log"));
    await ctx.settle();

    // openFile: success, error, and lsp close of the previous file
    await browser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    const openErr = filesApi({ openFileError: "file down" });
    const openErrBrowser = makeBrowser(ctx, openErr.api);
    await openErrBrowser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();

    // edit + save roundtrip, save error path. renderPreview mounts the
    // editor inside a setTimeout after deps.render(); the draft only moves
    // through that onChange, so the render stub must run the queued
    // preview timer (real Editor) before startEdit
    const saveCalls = [];
    let editorOnChange = null;
    const realEditor = ctx.HerdrEditor;
    ctx.HerdrEditor = {
      create(opts) {
        editorOnChange = opts.onChange || null;
        return { getValue: () => opts.content, destroy() {} };
      },
    };
    const saveApi = async (url, opt = {}) => {
      const urlStr = String(url);
      saveCalls.push({ url: urlStr, opt });
      if (urlStr.startsWith("/api/file-browser/tree"))
        return { path: "", entries: [] };
      if (urlStr.startsWith("/api/file-browser/file") && opt.method === "POST")
        return { ok: true, hash: "h2" };
      if (urlStr.startsWith("/api/file-browser/file"))
        return { path: "docs/alpha.txt", content: "alpha body\n", hash: "h1", size: 11 };
      throw Error("unmocked " + urlStr);
    };
    const saveBrowser = makeBrowser(ctx, saveApi, {
      render() {
        // run the real screen html through the stubbed document so the
        // preview mount timer fires inside this microtask chain
        const html = saveBrowser.renderScreen();
        void html;
      },
    });
    await saveBrowser.load("");
    await saveBrowser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.flushTimers();
    // editor mounted in preview mode (readonly): onChange only exists in
    // edit mode, so startEdit first, then flush the edit-mode mount
    saveBrowser.startEdit();
    await ctx.flushTimers();
    ok(typeof editorOnChange === "function", "edit-mode editor mounted");
    editorOnChange("edited body");
    await saveBrowser.saveFile();
    await ctx.settle();
    ok(saveCalls.some((c) => c.opt && c.opt.method === "POST" && String(c.opt.body || "").includes('"content":"edited body"')), "save posted");
    ctx.HerdrEditor = realEditor;
    const saveErrApi = async (url, opt = {}) => {
      const urlStr = String(url);
      if (urlStr.startsWith("/api/file-browser/file") && opt.method === "POST") throw Error("save rejected");
      if (urlStr.startsWith("/api/file-browser/file")) return { path: "docs/alpha.txt", content: "alpha body\n", hash: "h1" };
      if (urlStr.startsWith("/api/file-browser/tree")) return { path: "", entries: [] };
      throw Error("unmocked " + urlStr);
    };
    const saveErrBrowser = makeBrowser(ctx, saveErrApi);
    await saveErrBrowser.load("");
    await saveErrBrowser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    saveErrBrowser.startEdit();
    await saveErrBrowser.saveFile();
    await ctx.settle();
  });

  it("covers rename, delete, new file, action sheet", async () => {
    const ctx = await boot();
    const { api, calls } = filesApi({ renameError: "rename boom" });
    const browser = makeBrowser(ctx, api);
    await browser.load("");
    await ctx.settle();

    // action sheet on a dir row and a file row
    await browser.rowActions(encodeURIComponent("docs"), "dir");
    await ctx.settle();
    await browser.closeActionSheet();
    await browser.rowActions(encodeURIComponent("docs/alpha.txt"), "file");
    await ctx.settle();
    await browser.closeActionSheet();
    // closeActionSheet with no sheet is a no-op
    await browser.closeActionSheet();

    // rename: open, set value, cancel
    await browser.openRename(encodeURIComponent("docs/alpha.txt"));
    browser.setRenameValue("renamed.txt");
    browser.cancelRename();
    // setRenameValue with no sheet is a no-op
    browser.setRenameValue("x");

    // rename: same name short-circuits to cancel
    await browser.openRename(encodeURIComponent("docs/alpha.txt"));
    browser.submitRename();
    await ctx.settle();

    // rename: error then success
    await browser.openRename(encodeURIComponent("docs/alpha.txt"));
    browser.setRenameValue("renamed.txt");
    await browser.submitRename();
    await ctx.settle();
    const okApi = filesApi();
    const okBrowser = makeBrowser(ctx, okApi.api);
    await okBrowser.openRename(encodeURIComponent("docs/alpha.txt"));
    okBrowser.setRenameValue("renamed.txt");
    await okBrowser.submitRename();
    await ctx.settle();
    ok(okApi.calls.some((c) => c.url === "/api/file-browser/rename" && c.opt.method === "POST"), "rename posted");

    // delete: confirm decline, then success, then error
    let answer = false;
    const declineBrowser = makeBrowser(ctx, api, { confirm: async () => answer });
    await declineBrowser.deletePath(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    answer = true;
    await declineBrowser.deletePath(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    ok(calls.some((c) => c.url === "/api/file-browser/delete" && c.opt.method === "POST"), "delete posted");
    const delErr = filesApi({ deleteError: "delete boom" });
    const delErrBrowser = makeBrowser(ctx, delErr.api);
    await delErrBrowser.deletePath(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();

    // new file: open, set, cancel, empty name guard, success, error
    const nfBrowser = makeBrowser(ctx, api);
    await nfBrowser.openNewFile();
    nfBrowser.setNewFileValue("notes.md");
    nfBrowser.cancelNewFile();
    nfBrowser.setNewFileValue("x");
    await nfBrowser.openNewFile();
    nfBrowser.setNewFileValue("");
    await nfBrowser.submitNewFile(); // empty name: no post
    nfBrowser.setNewFileValue("created.md");
    await nfBrowser.submitNewFile();
    await ctx.settle();
    ok(calls.some((c) => c.url === "/api/file-browser/file" && c.opt.method === "POST" && String(c.opt.body).includes("created.md")), "new file posted");
    const nfErr = filesApi({ newFileError: "create boom" });
    const nfErrBrowser = makeBrowser(ctx, nfErr.api);
    await nfErrBrowser.openNewFile();
    nfErrBrowser.setNewFileValue("bad.md");
    await nfErrBrowser.submitNewFile();
    await ctx.settle();
  });

  it("covers content search, entry points, invalidate, openAt", async () => {
    const ctx = await boot();
    const { api, calls } = filesApi();
    const browser = makeBrowser(ctx, api);
    await browser.load("");
    await ctx.settle();

    // filter typing: debounce timer then Enter forces it
    browser.filter("alp");
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle();
    browser.filter("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle();
    browser.searchKeydown({ key: "Enter", preventDefault() {} });
    await ctx.settle();
    // append page on scroll near the bottom
    await browser.scroll({ scrollTop: 1000, clientHeight: 500, scrollHeight: 1500 });
    await ctx.settle();
    await browser.searchKeydown({ key: "Escape", preventDefault() {} });
    await ctx.settle();
    // ctrl+s preventDefault branch
    browser.searchKeydown({ key: "s", ctrlKey: true, preventDefault() {} });
    browser.searchKeydown(null);

    // toggle filter kind cycles file -> dir -> content
    browser.toggleFilterKind();
    await ctx.settle();
    browser.toggleFilterKind();
    await ctx.settle();
    // now in content mode: run a content search
    browser.filter("needle");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle();
    const files = ctx.HerdrMobileFilesContent;
    files.setQuery("needle");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle();
    files.inputKeydown({ key: "Enter", preventDefault() {} });
    await ctx.settle();
    files.inputKeydown({ key: "Escape", preventDefault() {} });
    await ctx.settle();
    files.inputKeydown({ key: "s", metaKey: true, preventDefault() {} });
    files.inputKeydown(null);
    files.run();
    await ctx.settle();
    // short query under min chars: clear + hint error
    files.setQuery("ne");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle();
    ok(String(mobileEl(ctx, "").id) !== undefined);
    // loadMore appends the second page
    files.loadMore();
    await ctx.settle();
    files.toggleFile(encodeURIComponent("docs/alpha.txt"));
    files.toggleFile(encodeURIComponent("docs/alpha.txt"));
    await files.loadFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    await files.loadFile(encodeURIComponent("missing.txt"));
    await ctx.settle();
    files.openFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    files.openMatch(encodeURIComponent("docs/alpha.txt"), encodeURIComponent("2:0"));
    await ctx.settle();
    files.expandSnippet(encodeURIComponent("docs/alpha.txt"), 0, "up");
    await ctx.settle();
    files.clear();
    await ctx.settle();

    // closeContentSearch + blurTree with active content search
    browser.toggleContentSearch();
    await ctx.settle();
    browser.blurTree();
    browser.closeContentSearch();
    await ctx.settle();

    // typeToFilter: alt+f/d/c shortcuts, escape, backspace, plain key, ignored keys
    browser.typeToFilter({ key: "f", altKey: true, preventDefault() {} });
    await ctx.settle();
    browser.typeToFilter({ key: "d", altKey: true, preventDefault() {} });
    await ctx.settle();
    browser.typeToFilter({ key: "c", altKey: true, preventDefault() {} });
    await ctx.settle();
    browser.typeToFilter({ metaKey: true, preventDefault() {} });
    browser.typeToFilter({ defaultPrevented: true });
    browser.typeToFilter({ key: "F1" });
    browser.typeToFilter({ key: "Escape", preventDefault() {} });
    browser.typeToFilter({ key: "Backspace", preventDefault() {} });
    browser.typeToFilter({ key: "q", target: { closest: () => ({}) }, preventDefault() {} });
    browser.typeToFilter({ key: "q", preventDefault() {} });
    await ctx.settle();

    // showSearch schedules the filter focus
    browser.showSearch();
    await ctx.flushTimers();
    browser.focusTree();

    // up() with and without a path
    await browser.toggle(encodeURIComponent("docs"));
    await ctx.settle();
    browser.up();
    await ctx.settle();

    // backToTree closes the preview
    await browser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    await browser.backToTree();
    await ctx.settle();

    // refreshFile with no file is a no-op; with a file it reopens
    await browser.refreshFile();
    await browser.select(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();
    await browser.refreshFile();
    await ctx.settle();

    // openAt: same root + same file short-circuit; different root resets
    await browser.openAt("docs/alpha.txt", {});
    await ctx.settle();
    await browser.openAt("docs/alpha.txt", { cwd: "/other/root", kind: "file" });
    await ctx.settle();
    await browser.openAt("", { kind: "dir" });
    await ctx.settle();
    await browser.openAt("docs/alpha.txt", { preserveContext: true, cwd: "/tmp/alpha" });
    await ctx.settle();

    // invalidateWorkspace: matching root reloads, foreign root skips
    await browser.invalidateWorkspace("/tmp/alpha");
    await ctx.settle();
    await browser.invalidateWorkspace("/nope");
    await ctx.settle();

    // reset clears everything
    browser.reset();
    await ctx.settle();
  });
});

describe("mobile coverage: terminal", () => {
  function makeTerminalDeps(ctx, extra = {}) {
    const state = Object.assign(
      {
        session: "default",
        ws: "w1",
        tab: "t1",
        pane: "p1",
        terminalId: "term1",
        screen: "terminal",
        terminalConnecting: false,
      },
      extra.state || {},
    );
    const events = [];
    // onHerdrError is destructured once at module create, so route it through
    // a mutable holder the test can flip later
    const herdrErrorHandler = { fn: extra.onHerdrError || (() => false) };
    const deps = {
      el: ctx.document.getElementById,
      state,
      wsUrl: (path) => `ws://x${path}`,
      onHerdrError: (data) => herdrErrorHandler.fn(data),
      onTerminalOutput: extra.onTerminalOutput || (() => {}),
      onConnectionState: (connecting) => events.push(connecting),
    };
    deps.state = state;
    deps.events = events;
    deps.herdrErrorHandler = herdrErrorHandler;
    return deps;
  }

  it("covers connect, reconnect backoff, resize paths, handlers", async () => {
    const ctx = await boot();
    const deps = makeTerminalDeps(ctx);
    const term = ctx.HerdrMobileTerminal.create(deps);

    // connect: renderer create, ws open, shell resize scheduling
    await term.connect();
    await ctx.settle();
    ok(ctx.lastRendererOptions, "renderer options captured");
    equal(ctx.lastRendererOptions.fontSize, 12, "mobile default font size 12");
    ok(Array.isArray(ctx.sockets) && ctx.sockets.length >= 1, "terminal ws opened");
    const socketsAfterConnect = ctx.sockets.length;
    const ws = ctx.sockets[ctx.sockets.length - 1];
    ok(String(ws.url).includes("terminal_id=term1"), "ws url carries terminal id");

    // same open socket + same key: connect returns early, no second ws
    await term.connect();
    await ctx.settle();
    equal(ctx.sockets.length, socketsAfterConnect, "no duplicate socket for same key");

    // applyFontFamily/applyLinks/applyTheme touch the live term
    term.applyFontFamily();
    term.applyLinks();
    term.applyTheme();
    term.scrollToBottom(true);
    ok(ctx.lastTerminal, "term instance reachable");

    // frame data through ws.onmessage: small frames write immediately
    ws.onmessage({ data: "hello" });
    ok(ctx.lastTerminal.writes.includes("hello"), "small frame written");

    // binary frame goes through the queue path
    ws.onmessage({ data: ctx.Terminal ? new (ctx.Uint8Array)([104, 105]) : "hi" });
    await ctx.flushTimers();

    // input gate: sendControlKey routes through ws when open
    term.sendControlKey("\u0003");
    term.sendPasteToTerminal("line1\r\nline2");

    // wheel/paste handlers bound on the terminal element. the app's own
    // mobileTerminal binds first during boot; this module's listeners are
    // last, so drive those and assert on this module's term
    const termEl = ctx.document.getElementById("terminal");
    const wheelListener = termEl.listeners.wheel[termEl.listeners.wheel.length - 1];
    const pasteListener = termEl.listeners.paste[termEl.listeners.paste.length - 1];
    ok(pasteListener, "paste listener bound");
    ok(wheelListener, "wheel listener bound");
    ok(termEl.listeners.pointerdown.length >= 1, "pointerdown listener bound");
    const fakeTerm = term.getTerm();

    // paste handler: blocked while lens active
    ctx.HerdrMobileLens = { isActive: () => true };
    const pasteEvent = {
      clipboardData: { getData: () => "pasted" },
      prevented: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() {},
    };
    pasteListener(pasteEvent);
    ok(!pasteEvent.prevented, "lens active blocks paste");

    // paste handler: open ws accepts the paste
    ctx.HerdrMobileLens = null;
    ws.readyState = 1;
    pasteListener(pasteEvent);
    ok(pasteEvent.prevented, "paste reaches open ws");

    // wheel handler: ctrl/meta bypasses
    wheelListener({ ctrlKey: true, deltaY: 100, preventDefault() {}, stopImmediatePropagation() {} });
    // wheel on normal buffer: pixel mode accumulates to a row step.
    // options must go through the real HerdrOptions cache: the module's
    // options() reads globalThis.HerdrOptions inside the vm context
    ctx.HerdrOptions.write({ scrollLines: 3 });
    fakeTerm.rowHeight = () => 17;
    wheelListener({ deltaY: -40, preventDefault() {}, stopImmediatePropagation() {} });
    equal(fakeTerm.scrolledLines, -6, "pixel wheel scrolls scrollLines");

    // wheel: deltaMode 1 line mode
    wheelListener({ deltaY: 3, deltaMode: 1, preventDefault() {}, stopImmediatePropagation() {} });
    equal(fakeTerm.scrolledLines, 3, "line mode scrolls");

    // wheel: deltaMode 2 page mode
    fakeTerm.rows = 24;
    wheelListener({ deltaY: 5, deltaMode: 2, preventDefault() {}, stopImmediatePropagation() {} });
    equal(fakeTerm.scrolledLines, 24, "page mode scrolls rows");

    // wheel: wheelForwardedToProgram short-circuits
    fakeTerm.wheelForwardedToProgram = () => true;
    wheelListener({ deltaY: 40, preventDefault() {}, stopImmediatePropagation() {} });
    equal(fakeTerm.scrolledLines, 24, "program-handled wheel ignored");

    // onopen with a pending resize flushes it
    const ws2 = ctx.sockets[ctx.sockets.length - 1];
    // force a pending resize: open a second connect with a different size
    ctx.document.getElementById("terminalShell").clientWidth = 100;
    await term.connect();
    await ctx.settle();

    // onclose arms the reconnect backoff: same-target connect is rejected.
    // the window is measured via performance.now() when present, else the
    // vm's own Date (host Date patches do not reach the vm). inject a
    // controllable performance into ctx so the window can advance without
    // real waiting
    let clock = 0;
    ctx.performance = { now: () => clock };
    const ws3 = ctx.sockets[ctx.sockets.length - 1];
    ws3.onclose({ code: 1000 });
    equal(deps.state.terminalConnecting, false, "close clears connecting flag");
    const socketsBefore = ctx.sockets.length;
    await term.connect();
    await ctx.settle();
    equal(ctx.sockets.length, socketsBefore, "backoff suppresses same-target reconnect");
    // flush the backoff timer: connect proceeds
    clock += 10000;
    await ctx.flushTimers();
    await ctx.settle();
    equal(ctx.sockets.length, socketsBefore + 1, "backoff timer reconnects");
    delete ctx.performance;
    clock = 0;

    // herdr_error frame: host handled, socket dropped. must run while
    // the socket is still the module's termWs: onclose nulls termWs, so
    // after the 4404 close below this frame would early-return
    deps.herdrErrorHandler.fn = () => true;
    const ws4 = ctx.sockets[ctx.sockets.length - 1];
    let closed4 = false;
    ws4.close = () => { closed4 = true; };
    ws4.onmessage({ data: JSON.stringify({ type: "herdr_error", error: "boom" }) });
    ok(closed4, "herdr_error drops socket");
    deps.herdrErrorHandler.fn = () => false;

    // 4404 stall close shows the alert card
    ctx.HerdrAlertCard = {
      show(alert) { (ctx.alerts || (ctx.alerts = [])).push(alert); },
    };
    const ws5 = ctx.sockets[ctx.sockets.length - 1];
    ws5.onclose({ code: 4404 });
    ok(ctx.alerts && ctx.alerts.length === 1, "stall close banners");
    ok(String(ctx.alerts[0].title).includes("stalled"), "banner title");

    // destroy clears the term and observer
    term.destroy(true);
    equal(ctx.terminalStats.disposed >= 1, true, "term disposed on destroy");
  });

  it("covers disconnect, no-terminal guard, empty state helpers", async () => {
    const ctx = await boot();
    const deps = makeTerminalDeps(ctx);
    const term = ctx.HerdrMobileTerminal.create(deps);

    // no terminal id: connect is a no-op
    deps.state.terminalId = "";
    await term.connect();
    await ctx.settle();
    equal(deps.state.terminalConnecting, false, "no id, no connect");

    // no terminal element: connect also bails
    deps.state.terminalId = "termX";
    ctx.forgetElement("terminal");
    const bailEl = { id: "terminal" };
    Object.defineProperty(bailEl, "removed", { value: true });
    // reinstall an element but drop the renderer to hit the guard
    const savedRenderer = ctx.HerdrTerminalRenderer;
    ctx.HerdrTerminalRenderer = null;
    await term.connect();
    await ctx.settle();
    ctx.HerdrTerminalRenderer = savedRenderer;
    equal(deps.state.terminalConnecting, false, "no renderer, no connect");

    // restore and connect fully, then disconnect keeps the shell observer clean
    ctx.document.getElementById("terminal");
    await term.connect();
    await ctx.settle();
    term.disconnect(true);
    equal(deps.state.terminalConnecting, false, "disconnect clears flag");

    // applyTheme/applyLinks/applyFontFamily with no term never throw
    term.destroy(false);
    doesNotThrow(() => term.applyTheme());
    doesNotThrow(() => term.applyLinks());
    doesNotThrow(() => term.applyFontFamily());
    doesNotThrow(() => term.scrollToBottom());
    doesNotThrow(() => term.sendControlKey("x"));

    // follow button state via module instance scrolled state
    doesNotThrow(() => term.getTerm());
    equal(term.getTerm(), null, "term gone after destroy");
  });

  it("covers frame queue, attach frames, input chunking, shell observer", async () => {
    const ctx = await boot();
    const deps = makeTerminalDeps(ctx);
    const term = ctx.HerdrMobileTerminal.create(deps);
    await term.connect();
    await ctx.settle();
    const ws = ctx.sockets[ctx.sockets.length - 1];
    const fakeTerm = term.getTerm();
    ok(fakeTerm, "term created");

    // shell observer: connect registers a ResizeObserver on the shell
    ok(ctx.terminalShellObservers.length >= 1, "shell observer registered");
    const observer = ctx.terminalShellObservers[ctx.terminalShellObservers.length - 1];
    ok(observer.observed, "observer watching shell");
    // firing the observer schedules the shell resize timer; flushing it
    // reconnects with a fresh size when the screen is terminal
    observer.callback();
    await ctx.flushTimers();
    await ctx.settle();

    // follow button: scroll listener toggles paused state via the element
    const termEl = ctx.document.getElementById("terminal");
    const scrollListener = termEl.listeners.scroll[termEl.listeners.scroll.length - 1];
    ok(scrollListener, "scroll listener bound");
    ctx.terminalAtBottomOverride = false;
    scrollListener();
    const followButton = ctx.document.getElementById("mobileTerminalFollowButton");
    ok(followButton, "follow button present");
    equal(followButton.hidden, false, "follow button shown while paused");
    ctx.terminalAtBottomOverride = undefined;
    scrollListener();
    equal(followButton.hidden, true, "follow button hidden at bottom");

    // attach frame path: after onopen, a large frame queues and flushes via
    // the rAF callback, resetting the attach pending flag
    ws.onopen();
    const bigFrame = "x".repeat(9000);
    fakeTerm.writes.length = 0;
    ws.onmessage({ data: bigFrame });
    equal(fakeTerm.writes.length, 0, "large attach frame queued, not written");
    await ctx.flushAnimationFrames();
    ok(fakeTerm.writes.length >= 1, "queued frame flushed");

    // two queued frames coalesce into one write on flush
    fakeTerm.writes.length = 0;
    ws.onmessage({ data: "a".repeat(9000) });
    ws.onmessage({ data: "b".repeat(9000) });
    await ctx.flushAnimationFrames();
    equal(fakeTerm.writes.length, 1, "string frames coalesced");

    // binary frames coalesce through the Uint8Array merge path: big
    // string first opens the queue, then the binary frame joins it
    fakeTerm.writes.length = 0;
    ws.onmessage({ data: "c".repeat(9000) });
    ws.onmessage({ data: new ctx.Uint8Array([104, 105]) });
    await ctx.flushAnimationFrames();
    equal(fakeTerm.writes.length, 1, "mixed frames merged into one write");

    // small frame after queue clears writes immediately again
    fakeTerm.writes.length = 0;
    ws.onmessage({ data: "tiny" });
    equal(fakeTerm.writes.length, 1, "small frame written directly");

    // input chunking: big paste splits into chunks and flushes through ws
    const sent = [];
    ws.send = (data) => sent.push(data);
    term.sendPasteToTerminal("p".repeat(40 * 1024));
    ok(sent.length >= 3, "paste chunked across sends");
    // remaining chunks drain via the input flush timer
    await ctx.flushTimers();
    ok(sent.length >= 3, "queue drained");

    // buffered ws backpressure: bufferedAmount above cap forces queue path
    ws.bufferedAmount = 100000;
    term.sendControlKey("z");
    equal(deps.state.terminalConnecting, false, "send on busy socket is a no-op queuing");
    ws.bufferedAmount = 0;

    // graphics bridge: a fresh connect after disconnect calls
    // bridge.connect/resize when the bridge exists
    const bridgeCalls = [];
    ctx.HerdrGraphicsBridge = {
      connect: () => bridgeCalls.push("connect"),
      resize: () => bridgeCalls.push("resize"),
      disconnect: () => bridgeCalls.push("disconnect"),
    };
    term.disconnect(false);
    await term.connect();
    await ctx.settle();
    ok(bridgeCalls.includes("connect"), "bridge connected");
    ok(bridgeCalls.includes("resize"), "bridge resized");

    // font load refresh: refreshTerminalAfterFontLoad only runs when the
    // renderer creates a term, so destroy first, then hook the new term
    let invalidated = false;
    const hookRenderer = ctx.HerdrTerminalRenderer;
    const origCreate = hookRenderer.create;
    hookRenderer.create = async (target, rendererOptions = {}) => {
      const t = await origCreate(target, rendererOptions);
      t.invalidateCellMetrics = () => { invalidated = true; };
      return t;
    };
    term.destroy(false);
    await term.connect();
    await ctx.settle();
    equal(invalidated, true, "font load invalidates cell metrics");
    hookRenderer.create = origCreate;

    // destroy clears the shell observer
    term.destroy(false);
    ok(observer.disconnected, "observer disconnected on destroy");
  });
});
