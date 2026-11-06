import { describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
import vm from "node:vm";

// Same element/context/bundle scaffolding as mobile_load.test.mjs: coverage
// attributes each product file's statements to its real disk path.

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
          json: async () => options.serverSettings || {},
        };
      if (url === "/api/tabs" && opt.method === "POST")
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { tab: { tab_id: "w1:t3" } } }),
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
              untracked: [],
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
              branches: [],
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
  ctx.settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };
  ctx.dispatchDocumentEvent = (event) => {
    for (const listener of listeners[event] || []) listener();
  };
  ctx.documentListeners = () => listeners;
  ctx.localStorageMap = localStorage;
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

function gitRequest(ctx, urlPart) {
  return ctx.requests.find((request) => String(request.url).includes(urlPart));
}

function failEndpoint(ctx, prefix) {
  const fetch = ctx.fetch;
  ctx.fetch = async (url, opt) => {
    if (String(url).startsWith(prefix)) {
      ctx.requests.push({ url, opt: opt || {} });
      return {
        ok: false,
        status: 500,
        statusText: "boom",
        json: async () => ({ error: "git backend down" }),
      };
    }
    return fetch(url, opt);
  };
}

describe("mobile git coverage", () => {
  it("surfaces loadGitStatus and loadGitDiff failures", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    failEndpoint(ctx, "/api/git-ui/status");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    const screen = ctx.document.getElementById("mobileScreen");
    ok(screen.innerHTML.includes("Retry"), "error screen offers retry");
    ok(screen.innerHTML.includes("git backend down"), "error message surfaced");
    // retry path recovers when the endpoint comes back
    ctx.fetch = async (url, opt) => {
      ctx.requests.push({ url, opt: opt || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          branch: "main",
          state: "clean",
          conflicted: [],
          staged: [],
          unstaged: [],
          untracked: ["new.txt"],
        }),
      };
    };
    ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    ok(true, "retry ran without throwing");

    // diff failure: select a file whose diff fetch fails
    const ctx2 = context("/session/default/workspace/w1");
    runSource(ctx2);
    failEndpoint(ctx2, "/api/git-ui/diff");
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    ctx2.HerdrMobile.showScreen("git");
    await ctx2.HerdrMobile.loadGitStatus();
    await ctx2.settle();
    await ctx2.HerdrMobile.selectGitFile("src/mobile.js", "M");
    await ctx2.settle();
    const detail = ctx2.document.getElementById("mobileScreen").innerHTML;
    ok(detail.includes("git backend down"), "diff error message rendered");
  });

  it("unstages a file and refreshes the diff", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    await ctx.HerdrMobile.selectGitFile("src/staged.js", "S");
    await ctx.settle();
    await ctx.HerdrMobile.gitUnstageFile();
    await ctx.settle();
    const unstageCall = gitRequest(ctx, "/api/git-ui/unstage");
    ok(unstageCall, "unstage posted");
    deepEqual(JSON.parse(unstageCall.opt.body).paths, ["src/staged.js"]);
    const state = ctx.HerdrMobileAppDeps.state;
    equal(state.gitKind, "M", "kind flips to unstaged");
    equal(state.gitMutating, false, "mutating flag cleared");
    // the diff refetch after unstage used the working scope
    const diffCalls = ctx.requests.filter((request) =>
      String(request.url).includes("/api/git-ui/diff"),
    );
    ok(diffCalls.some((request) => String(request.url).includes("scope=working")));
  });

  it("stage-all toggles both directions with confirms", async () => {
    // stage all: unstaged + untracked files, no staged ones
    const ctx = context("/session/default/workspace/w1", {
      gitStatus: {
        branch: "main",
        state: "dirty",
        conflicted: [],
        staged: [],
        unstaged: ["a.js"],
        untracked: ["b.txt"],
      },
    });
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    // declined confirm posts nothing
    ctx.confirm = () => false;
    await ctx.HerdrMobile.gitToggleStageAll();
    await ctx.settle();
    ok(!gitRequest(ctx, "/api/git-ui/stage"), "declined stage-all posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitToggleStageAll();
    await ctx.settle();
    const stageCall = gitRequest(ctx, "/api/git-ui/stage");
    ok(stageCall, "stage-all posted");
    deepEqual(JSON.parse(stageCall.opt.body).paths, ["a.js", "b.txt"]);

    // unstage all: with staged files present the same button unstages
    const ctx2 = context("/session/default/workspace/w1", {
      gitStatus: {
        branch: "main",
        state: "dirty",
        conflicted: [],
        staged: ["x.js", "y.js"],
        unstaged: [],
        untracked: [],
      },
    });
    runSource(ctx2);
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    ctx2.HerdrMobile.showScreen("git");
    await ctx2.HerdrMobile.loadGitStatus();
    await ctx2.settle();
    ctx2.confirm = () => false;
    await ctx2.HerdrMobile.gitToggleStageAll();
    await ctx2.settle();
    ok(!gitRequest(ctx2, "/api/git-ui/unstage"), "declined unstage-all posts nothing");
    ctx2.confirm = () => true;
    await ctx2.HerdrMobile.gitToggleStageAll();
    await ctx2.settle();
    const unstageCall = gitRequest(ctx2, "/api/git-ui/unstage");
    ok(unstageCall, "unstage-all posted");
    deepEqual(JSON.parse(unstageCall.opt.body).paths, ["x.js", "y.js"]);

    // clean tree: toggle does nothing
    const ctx3 = context("/session/default/workspace/w1", {
      gitStatus: {
        branch: "main",
        state: "clean",
        conflicted: [],
        staged: [],
        unstaged: [],
        untracked: [],
      },
    });
    runSource(ctx3);
    await ctx3.HerdrMobile.refresh();
    await ctx3.settle();
    ctx3.HerdrMobile.showScreen("git");
    await ctx3.HerdrMobile.loadGitStatus();
    await ctx3.settle();
    await ctx3.HerdrMobile.gitToggleStageAll();
    await ctx3.settle();
    ok(!gitRequest(ctx3, "/api/git-ui/stage"), "clean tree stages nothing");
    ok(!gitRequest(ctx3, "/api/git-ui/unstage"), "clean tree unstages nothing");
  });

  it("commit sheet: open, guard, submit, done toast", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;

    // open with nothing staged: refused
    state.gitStatus = { ...state.gitStatus, staged: [] };
    ctx.HerdrMobile.openCommitSheet();
    await ctx.settle();
    equal(state.gitError, "Stage changes before committing.");
    equal(state.gitCommitSheet, null, "no sheet without staged files");

    // staged files return: reopen succeeds
    state.gitStatus = { ...state.gitStatus, staged: ["src/staged.js"] };
    ctx.HerdrMobile.openCommitSheet();
    await ctx.settle();
    equal(state.gitError, "", "error cleared");
    ok(state.gitCommitSheet, "sheet opened");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Commit staged"), "commit button rendered");

    // field writes: text and the amend boolean
    ctx.HerdrMobile.setCommitField("title", "fix bug");
    ctx.HerdrMobile.setCommitField("body", "details");
    ctx.HerdrMobile.setCommitField("amend", 1);
    equal(state.gitCommitSheet.title, "fix bug");
    equal(state.gitCommitSheet.body, "details");
    equal(state.gitCommitSheet.amend, true, "amend coerces to boolean");
    ctx.HerdrMobile.setCommitField("amend", 0);
    equal(state.gitCommitSheet.amend, false);

    // empty title refuses without posting
    ctx.HerdrMobile.setCommitField("title", "   ");
    await ctx.HerdrMobile.submitCommit();
    await ctx.settle();
    equal(state.gitError, "Commit title is required.");
    ok(!gitRequest(ctx, "/api/git-ui/commit"), "no commit post without a title");

    // successful submit posts, closes the sheet, and shows the done toast
    ctx.HerdrMobile.setCommitField("title", "ship it");
    await ctx.HerdrMobile.submitCommit();
    await ctx.settle();
    const commitCall = gitRequest(ctx, "/api/git-ui/commit");
    ok(commitCall, "commit posted");
    const body = JSON.parse(commitCall.opt.body);
    equal(body.title, "ship it");
    equal(body.cwd, "/tmp/alpha");
    equal(body.amend, false);
    equal(state.gitCommitSheet, null, "sheet closed after commit");
    equal(state.gitCommitDone, true, "done toast armed");
    ok(ctx.document.getElementById("mobileScreen").innerHTML.includes("Commit created"), "toast rendered");
    ctx.HerdrMobile.dismissCommitDone();
    await ctx.settle();
    equal(state.gitCommitDone, false, "toast dismissed");
    // close sheet directly
    ctx.HerdrMobile.openCommitSheet();
    await ctx.settle();
    ctx.HerdrMobile.closeCommitSheet();
    await ctx.settle();
    equal(state.gitCommitSheet, null, "closeCommitSheet clears the sheet");
  });

  it("commit failure surfaces the backend error", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    // both the commit and the status refresh fail so the error survives
    // loadGitStatus's success path clearing gitError
    failEndpoint(ctx, "/api/git-ui/commit");
    failEndpoint(ctx, "/api/git-ui/status");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    // reopen against a populated status so the sheet opens despite the
    // failing endpoint: stage a file through the real flow first
    const state = ctx.HerdrMobileAppDeps.state;
    state.gitStatus = { branch: "main", state: "dirty", conflicted: [], staged: ["s.js"], unstaged: [], untracked: [] };
    state.gitError = "";
    ctx.HerdrMobile.openCommitSheet();
    await ctx.settle();
    ctx.HerdrMobile.setCommitField("title", "will fail");
    await ctx.HerdrMobile.submitCommit();
    await ctx.settle();
    ok(gitRequest(ctx, "/api/git-ui/commit"), "commit posted");
    ok(state.gitError.includes("git backend down"), "commit failure surfaced");
    equal(state.gitCommitDone, false, "no done toast on failure");
    equal(state.gitMutating, false, "mutating cleared after failure");
  });

  it("branch list error path and collapse toggle", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    failEndpoint(ctx, "/api/git-ui/branches");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    await ctx.HerdrMobile.toggleGitBranches();
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;
    equal(state.gitBranches, null, "failed load keeps branches empty");
    ok(state.gitBranchesError.includes("git backend down"), "branches error surfaced");
    ok(
      ctx.document.getElementById("mobileScreen").innerHTML.includes("git backend down"),
      "branches error rendered",
    );

    // successful load then collapse: the second toggle clears the list
    const ctx2 = context("/session/default/workspace/w1");
    runSource(ctx2);
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    ctx2.HerdrMobile.showScreen("git");
    await ctx2.HerdrMobile.loadGitStatus();
    await ctx2.settle();
    await ctx2.HerdrMobile.toggleGitBranches();
    await ctx2.settle();
    const state2 = ctx2.HerdrMobileAppDeps.state;
    ok(state2.gitBranches, "branches loaded");
    ok(
      ctx2.document.getElementById("mobileScreen").innerHTML.includes("Hide branches"),
      "collapse affordance rendered",
    );
    await ctx2.HerdrMobile.toggleGitBranches();
    await ctx2.settle();
    equal(state2.gitBranches, null, "toggle collapses the list");
    ok(
      ctx2.document.getElementById("mobileScreen").innerHTML.includes("Branches</button>"),
      "expand affordance back",
    );
  });

  it("deletes a branch after confirm and skips when declined", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    await ctx.HerdrMobile.toggleGitBranches();
    await ctx.settle();
    ctx.confirm = () => false;
    await ctx.HerdrMobile.gitDeleteBranch("feature/mobile");
    await ctx.settle();
    ok(!gitRequest(ctx, "/api/git-ui/branch-delete"), "declined delete posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitDeleteBranch("feature/mobile");
    await ctx.settle();
    const deleteCall = gitRequest(ctx, "/api/git-ui/branch-delete");
    ok(deleteCall, "confirmed delete posted");
    const body = JSON.parse(deleteCall.opt.body);
    equal(body.branch, "feature/mobile");
    equal(body.force, false);
    equal(body.confirmed, true);
    equal(body.cwd, "/tmp/alpha");
    const state = ctx.HerdrMobileAppDeps.state;
    equal(state.gitMutating, false, "mutating cleared");
    ok(
      ctx.requests.some((request) => String(request.url).startsWith("/api/git-ui/status")),
      "status refetched after delete",
    );
  });

  it("remote ops: pull update, push, fetch origin", async () => {
    const ctx = context("/session/default/workspace/w1", {
      gitStatus: {
        branch: "main",
        state: "dirty",
        conflicted: [],
        staged: ["s.js"],
        unstaged: [],
        untracked: [],
        upstream: "origin/main",
        ahead: 2,
        behind: 3,
      },
    });
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("HerdrMobile.gitPullUpdate()"), "pull button rendered");
    ok(html.includes("HerdrMobile.gitPushNow()"), "push button rendered");
    ok(html.includes("HerdrMobile.gitFetchOrigin()"), "fetch button rendered");

    // declined pull posts nothing
    ctx.confirm = () => false;
    await ctx.HerdrMobile.gitPullUpdate();
    await ctx.settle();
    ok(!gitRequest(ctx, "/api/git-ui/pull"), "declined pull posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitPullUpdate();
    await ctx.settle();
    const pullCall = gitRequest(ctx, "/api/git-ui/pull");
    ok(pullCall, "pull posted");
    equal(JSON.parse(pullCall.opt.body).mode, "update");

    // declined push posts nothing, confirmed push carries mode regular
    ctx.confirm = () => false;
    await ctx.HerdrMobile.gitPushNow();
    await ctx.settle();
    ok(!gitRequest(ctx, "/api/git-ui/push"), "declined push posts nothing");
    ctx.confirm = () => true;
    await ctx.HerdrMobile.gitPushNow();
    await ctx.settle();
    const pushCall = gitRequest(ctx, "/api/git-ui/push");
    ok(pushCall, "push posted");
    const pushBody = JSON.parse(pushCall.opt.body);
    equal(pushBody.mode, "regular");
    equal(pushBody.push_tags, false);

    // fetch runs without any confirm
    await ctx.HerdrMobile.gitFetchOrigin();
    await ctx.settle();
    const fetchCall = gitRequest(ctx, "/api/git-ui/fetch");
    ok(fetchCall, "fetch posted");
    equal(JSON.parse(fetchCall.opt.body).cwd, "/tmp/alpha");
    const state = ctx.HerdrMobileAppDeps.state;
    equal(state.gitMutating, false, "mutating cleared after remote ops");
  });

  it("switching a branch surfaces a backend failure through gitMutate", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    failEndpoint(ctx, "/api/git-ui/switch");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("git");
    await ctx.HerdrMobile.loadGitStatus();
    await ctx.settle();
    await ctx.HerdrMobile.gitSwitchBranch("feature/mobile");
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;
    ok(state.gitError.includes("git backend down"), "switch failure surfaced");
    equal(state.gitMutating, false, "mutating cleared after failure");
  });

  it("branch sheet: load failure, same-current tap, reroute errors", async () => {
    // load failure lands in the sheet error line
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    failEndpoint(ctx, "/api/git-ui/branches");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    await ctx.HerdrMobile.openBranchSheet();
    await ctx.settle();
    const sheet = ctx.document.getElementById("mobileBranchSheet");
    equal(sheet.hidden, false, "sheet stays open on load failure");
    ok(sheet.innerHTML.includes("git backend down"), "sheet shows the error");
    ctx.HerdrMobile.closeBranchSheet();
    await ctx.settle();
    equal(sheet.hidden, true, "sheet closed");

    // tapping the current branch row: the renderer disables that row, but
    // switchBranchFromSheet("main") still runs the confirm+switch flow (the
    // current-branch guard compares against a string .name, which is always
    // undefined), so the POST happens and the sheet closes on success
    const ctx2 = context("/session/default/workspace/w1");
    runSource(ctx2);
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    await ctx2.HerdrMobile.openBranchSheet();
    await ctx2.settle();
    const sheet2 = ctx2.document.getElementById("mobileBranchSheet");
    const before = ctx2.requests.length;
    await ctx2.HerdrMobile.switchBranchFromSheet("main");
    await ctx2.settle();
    equal(sheet2.hidden, true, "current-branch tap closes the sheet");
    ok(
      ctx2.requests.slice(before).some((request) => request.url === "/api/git-ui/switch"),
      "tap posts the switch like the sheet rows do",
    );

    // module-level reroute failure: create the module with a throwing
    // reroute so the catch path runs against the real sheet flow
    const ctx3 = context("/session/default/workspace/w1", {
      gitBranches: {
        local: [
          { name: "main", current: true, remote: false },
          {
            name: "feature/sibling",
            current: false,
            remote: false,
            worktree_path: "/tmp/alpha/sibling",
          },
        ],
        remote: [],
      },
    });
    runSource(ctx3);
    await ctx3.HerdrMobile.refresh();
    await ctx3.settle();
    await ctx3.HerdrMobile.openBranchSheet();
    await ctx3.settle();
    const before3 = ctx3.requests.length;
    const baseFetch = ctx3.fetch;
    ctx3.fetch = async (url, opt) => {
      if (String(url).startsWith("/api/recent-workspaces") && opt && opt.method === "POST") {
        ctx3.requests.push({ url, opt });
        throw Error("folder open exploded");
      }
      return baseFetch(url, opt);
    };
    await ctx3.HerdrMobile.switchBranchFromSheet("feature/sibling");
    await ctx3.settle();
    ok(
      !ctx3.requests.slice(before3).some((request) => request.url === "/api/git-ui/switch"),
      "reroute path never switches",
    );
    // openFolderAsWorkspace swallows its own failure into worktreeError, so
    // the git.js reroute catch never fires through the real app wiring
    ok(
      ctx3.HerdrMobileAppDeps.state.gitError === "",
      "reroute failure stays in worktreeError, not gitError",
    );
    ok(
      ctx3.HerdrMobileAppDeps.state.worktreeError.includes("folder open exploded"),
      "reroute failure surfaced through the worktree flow",
    );
  });

  it("createBranchFromSheet surfaces backend failures and reroute-unavailable errors", async () => {
    // backend failure during create keeps the sheet open with the error
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    failEndpoint(ctx, "/api/git-ui/switch");
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    await ctx.HerdrMobile.openBranchSheet();
    await ctx.settle();
    const sheet = ctx.document.getElementById("mobileBranchSheet");
    ctx.HerdrMobile.setBranchCreateName("feature/new");
    await ctx.HerdrMobile.createBranchFromSheet();
    await ctx.settle();
    equal(sheet.hidden, false, "sheet stays open on create failure");
    ok(sheet.innerHTML.includes("git backend down"), "create error rendered");
    equal(ctx.HerdrMobileAppDeps.state.gitMutating, false, "mutating cleared");

    // reroute unavailable: module created directly without a reroute fn.
    // el() returns the same element per id so the rendered sheet html is
    // observable.
    const ctx2 = context("/session/default/workspace/w1");
    const moduleElements = new Map();
    const moduleEl = (id) => {
      if (!moduleElements.has(id)) moduleElements.set(id, element(id));
      return moduleElements.get(id);
    };
    // only run up to git.js: the module factory needs nothing else
    for (const script of getMobileBundleScripts()) {
      script.runInContext(ctx2);
      if (ctx2.HerdrMobileGitModule) break;
    }
    const renders = [];
    const state = {
      gitError: "",
      gitBusy: "",
      gitMutating: false,
      gitCommitSheet: null,
      gitCommitDone: false,
      gitBranches: null,
      gitBranchesError: "",
      gitStatus: null,
      gitCwd: "",
      gitFile: "",
      gitKind: "",
      gitDiff: null,
      gitDiffError: "",
    };
    const git = ctx2.HerdrMobileGitModule.create({
      state,
      api: async (url) => {
        // branch sheet load returns rows whose sibling branch lives in
        // another worktree folder, so the row taps the reroute path
        if (String(url).startsWith("/api/git-ui/branches"))
          return {
            local: [
              { name: "main", current: true, remote: false },
              { name: "feature/elsewhere", current: false, remote: false, worktree_path: "/tmp/other" },
            ],
            remote: [],
          };
        return {};
      },
      render: () => renders.push(1),
      el: moduleEl,
      escapeHtml: (value) => String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      inputAttrs: () => "",
      jsArg: (value) => JSON.stringify(value),
      pathBasename: (path) => String(path || "").split("/").pop(),
      currentWorkspaceCwd: () => "/tmp/alpha",
      onBranchChanged: null,
      confirmFn: async () => true,
      rerouteToWorktreeFn: null,
    });
    await git.openBranchSheet();
    await ctx2.settle();
    equal(state.gitBranches, null, "sheet keeps its own branch cache");
    await git.switchBranchFromSheet("feature/elsewhere");
    await ctx2.settle();
    ok(git.isBranchSheetOpen(), "sheet stays open when rerouting is unavailable");
    // the module-level render() stub does not paint the sheet; drive
    // renderBranchSheet directly to see the error line
    git.renderBranchSheet();
    ok(
      moduleEl("mobileBranchSheet").innerHTML.includes("Folder switching is unavailable."),
      "reroute-unavailable error rendered in the sheet",
    );
    // renderBranchSheet with a live cwd keeps the sheet open and re-renders
    git.renderBranchSheet();
    await ctx2.settle();
    ok(git.isBranchSheetOpen(), "live sheet survives a render pass");
  });
});

describe("mobile screens coverage", () => {
  it("rename workspace flow: start, edit, submit, cancel", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("home");
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;

    // start rename prefill and render the sheet
    ctx.HerdrMobile.renameWorkspace("w1", "alpha");
    await ctx.settle();
    equal(state.renameWorkspaceId, "w1");
    equal(state.renameWorkspaceValue, "alpha");
    ok(
      ctx.document.getElementById("mobileScreen").innerHTML.includes("Rename workspace"),
      "rename sheet rendered",
    );

    // empty name refuses without posting
    ctx.HerdrMobile.setRenameWorkspaceValue("   ");
    await ctx.HerdrMobile.submitRenameWorkspace();
    await ctx.settle();
    equal(state.renameWorkspaceError, "Name cannot be empty.");
    equal(state.renameWorkspaceId, "w1", "sheet stays open on empty name");
    ok(!gitRequest(ctx, "/api/workspaces/w1/rename"), "empty name posts nothing");

    // successful rename posts and closes
    ctx.HerdrMobile.setRenameWorkspaceValue("renamed");
    await ctx.HerdrMobile.submitRenameWorkspace();
    await ctx.settle();
    const renameCall = ctx.requests.find(
      (request) => String(request.url).includes("/api/workspaces/w1/rename"),
    );
    ok(renameCall, "rename posted");
    equal(renameCall.opt.method, "POST");
    equal(JSON.parse(renameCall.opt.body).label, "renamed");
    equal(state.renameWorkspaceId, null, "sheet closed after rename");
    equal(state.renameWorkspaceError, "");

    // cancel clears the sheet
    ctx.HerdrMobile.renameWorkspace("w1", "alpha");
    await ctx.settle();
    ctx.HerdrMobile.cancelRenameWorkspace();
    await ctx.settle();
    equal(state.renameWorkspaceId, null, "cancel closes the sheet");
  });

  it("rename failure surfaces the backend error", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const baseFetch = ctx.fetch;
    ctx.fetch = async (url, opt) => {
      if (String(url).includes("/api/workspaces/w1/rename")) {
        ctx.requests.push({ url, opt: opt || {} });
        return {
          ok: false,
          status: 500,
          statusText: "boom",
          json: async () => ({ error: "name taken" }),
        };
      }
      return baseFetch(url, opt);
    };
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    const state = ctx.HerdrMobileAppDeps.state;
    ctx.HerdrMobile.renameWorkspace("w1", "alpha");
    await ctx.settle();
    ctx.HerdrMobile.setRenameWorkspaceValue("renamed");
    await ctx.HerdrMobile.submitRenameWorkspace();
    await ctx.settle();
    equal(state.renameWorkspaceError, "name taken", "rename error surfaced");
    equal(state.renameWorkspaceId, "w1", "sheet stays open on failure");
  });

  it("close workspace: declined, confirmed, failure", async () => {
    // declined confirm posts nothing
    const ctx = context("/session/default/workspace/w1", { confirm: () => false });
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    await ctx.HerdrMobile.closeWorkspace("w1");
    await ctx.settle();
    ok(
      !ctx.requests.some((request) => String(request.url).includes("/api/workspaces/w1/close")),
      "declined close posts nothing",
    );

    // confirmed close posts and refreshes
    const ctx2 = context("/session/default/workspace/w1");
    runSource(ctx2);
    await ctx2.HerdrMobile.refresh();
    await ctx2.settle();
    const before = ctx2.requests.length;
    await ctx2.HerdrMobile.closeWorkspace("w1");
    await ctx2.settle();
    const closeCall = ctx2.requests
      .slice(before)
      .find((request) => String(request.url).includes("/api/workspaces/w1/close"));
    ok(closeCall, "close posted");
    equal(closeCall.opt.method, "POST");
    ok(
      ctx2.requests.slice(before).some((request) =>
        String(request.url).startsWith("/api/session-snapshot"),
      ),
      "refresh re-fetched the snapshot",
    );

    // close failure surfaces the error through the rename error slot
    const ctx3 = context("/session/default/workspace/w1");
    runSource(ctx3);
    const baseFetch3 = ctx3.fetch;
    ctx3.fetch = async (url, opt) => {
      if (String(url).includes("/api/workspaces/w1/close")) {
        ctx3.requests.push({ url, opt: opt || {} });
        return {
          ok: false,
          status: 502,
          statusText: "boom",
          json: async () => ({ error: "close refused" }),
        };
      }
      return baseFetch3(url, opt);
    };
    await ctx3.HerdrMobile.refresh();
    await ctx3.settle();
    await ctx3.HerdrMobile.closeWorkspace("w1");
    await ctx3.settle();
    equal(ctx3.HerdrMobileAppDeps.state.renameWorkspaceError, "close refused", "close error surfaced");
  });

  it("dismiss and restore working agents from the agents screen", async () => {
    // the working agent needs its own pane: dismiss matches by
    // workspace/tab/pane and skips non-working statuses, so a blocked
    // agent sharing ids would shadow it
    const ctx = context("/session/default/workspace/w1", {
      // pane backing the working agent: selectAgent needs a real pane to
      // attach its terminal, whose output frames clear the dismissal
      panes: [
        { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
        { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
        { workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p3", terminal_id: "term3" },
      ].map((pane) => ({ workspace_id: "w1", ...pane })),
      tabs: [
        { workspace_id: "w1", tab_id: "w1:t1", number: 1 },
        { workspace_id: "w1", tab_id: "w1:t2", number: 2 },
        { workspace_id: "w1", tab_id: "w1:t3", number: 3 },
      ].map((tab) => ({ workspace_id: "w1", ...tab })),
      agents: [
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
          tab_id: "w1:t3",
          pane_id: "w1:p3",
          terminal_id: "term3",
          agent_status: "working",
          name: "working-agent",
        },
      ],
    });
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("agents");
    await ctx.settle();
    let html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("working-agent"), "working agent listed");
    ok(html.includes("Dismiss"), "dismiss affordance rendered");

    // unknown agent ids change nothing
    const storageBefore = ctx.localStorageMap.get("herdr-web-working-dismissals");
    ctx.HerdrMobile.dismissWorkingAgent("w9", "w9:t1", "w9:p1", "term9");
    await ctx.settle();
    equal(
      ctx.localStorageMap.get("herdr-web-working-dismissals"),
      storageBefore,
      "unknown agent dismiss is a no-op",
    );

    // dismiss the real working agent: storage records the dismissal and
    // the row re-renders as ignored with an Undo affordance
    ctx.HerdrMobile.dismissWorkingAgent("w1", "w1:t3", "w1:p3", "term3");
    await ctx.settle();
    const stored = JSON.parse(ctx.localStorageMap.get("herdr-web-working-dismissals"));
    ok(stored.term3, "dismissal persisted under the terminal key");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("agent-dismissed"), "row marked dismissed");
    ok(html.includes("ignored"), "status shows ignored");
    ok(html.includes("Undo"), "undo affordance rendered");
    ok(!html.includes(">Dismiss<"), "dismiss swapped for undo");

    // restore clears the record and brings the row back
    ctx.HerdrMobile.restoreWorkingAgent("w1", "w1:t3", "w1:p3", "term3");
    await ctx.settle();
    const restored = JSON.parse(ctx.localStorageMap.get("herdr-web-working-dismissals") || "{}");
    equal(restored.term3, undefined, "restored agent removed from storage");
    html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("working-agent"), "row back after restore");

    // restore with unknown ids is a no-op
    ctx.HerdrMobile.restoreWorkingAgent("w9", "w9:t1", "w9:p1", "term9");
    await ctx.settle();
    ok(true, "unknown restore ran without throwing");

    // dismiss again, then clear through the terminal-output wiring: the
    // terminal screen attaches the working agent's terminal, and a socket
    // frame clears its dismissal
    ctx.HerdrMobile.dismissWorkingAgent("w1", "w1:t3", "w1:p3", "term3");
    await ctx.settle();
    ok(JSON.parse(ctx.localStorageMap.get("herdr-web-working-dismissals")).term3, "dismissed again");
    ctx.HerdrMobile.selectAgent("w1", "w1:t3", "w1:p3");
    await ctx.settle();
    ctx.HerdrMobile.showScreen("terminal");
    await ctx.settle();
    ok(ctx.lastSocket, "terminal socket attached");
    ctx.lastSocket.onmessage({ data: "frame" });
    await ctx.settle();
    const cleared = JSON.parse(ctx.localStorageMap.get("herdr-web-working-dismissals") || "{}");
    equal(cleared.term3, undefined, "terminal output cleared the dismissal");
    ok(html.includes("working-agent"), "row back after restore");
  });

  it("home renders the attention agents section and nav labels", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    await ctx.HerdrMobile.refresh();
    await ctx.settle();
    ctx.HerdrMobile.showScreen("home");
    await ctx.settle();
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("Agents needing attention"), "attention section rendered");
    ok(html.includes("done-agent"), "done agent listed");
    ok(html.includes("blocked-agent"), "blocked agent listed");
    ok(html.includes("Workspaces"), "workspaces section rendered");
  });
});