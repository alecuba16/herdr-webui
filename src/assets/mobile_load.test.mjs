import { describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";
import vm from "node:vm";

function element(id = "") {
  return {
    id,
    classList: { toggle() {}, add() {}, remove() {} },
    dataset: {},
    style: { setProperty() {} },
    disabled: false,
    hidden: false,
    innerHTML: "",
    open: false,
    textContent: "",
    clientWidth: 360,
    clientHeight: 520,
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    querySelectorAll() {
      return [];
    },
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
  const navButtons = ["home", "search", "terminal", "more"].map(
    (screen) => Object.assign(element(), { dataset: { screen } }),
  );
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
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
      createElement: () => element(),
      getElementById: getElement,
      querySelectorAll: (selector) =>
        selector === ".mobile-nav button" ? navButtons : [],
      hidden: false,
      addEventListener(event, listener) {
        (listeners[event] || (listeners[event] = [])).push(listener);
      },
    },
    history: {
      pushState(_state, _title, path) {
        historyCalls.push({ type: "push", path });
      },
      replaceState(_state, _title, path) {
        historyCalls.push({ type: "replace", path });
      },
      calls: historyCalls,
    },
    location: {
      pathname,
      href: "",
      protocol: "http:",
      host: "127.0.0.1:8787",
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
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
      scrollToLine(line) {
        this.scrolledToLine = line;
      }
      scrollToBottom() {
        this.scrolledToBottom = true;
        this.buffer.active.viewportY = this.buffer.active.baseY;
      }
      focus() {}
      clear() {}
      dispose() {
        terminalStats.disposed += 1;
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
                      tab_id: "w1:t2",
                      pane_id: "w1:p2",
                      terminal_id: "term2",
                      agent_status: "working",
                      name: "working-agent",
                    },
                  ],
                };
      return { ok: true, status: 200, json: async () => ({ result }) };
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
  ctx.dispatchDocumentEvent = (event) => {
    for (const listener of listeners[event] || []) listener();
  };
  ctx.window = Object.assign(ctx, {
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
  });
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

describe("mobile bundle load", () => {
  const source =
    readFileSync(new URL("./shared/core.js", import.meta.url), "utf8") +
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
    readFileSync(new URL("./shared/terminal_scroll.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/core.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/attention.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/file_browser.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");


  it("renders temporary terminal capture hint on mobile", () => {
    const mobileSource = readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");
    const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");

    match(mobileSource, /Input captured · Ctrl\+G detaches/);
    match(mobileSource, /aria-label="Minimize temporary terminal"/);
    match(mobileSource, /aria-label="Detach temporary terminal"/);
    match(mobileCss, /\.temp-terminal-hint/);
    match(mobileCss, /\.temp-terminal-restore \{[\s\S]*?position: fixed;[\s\S]*?right: calc\(env\(safe-area-inset-right, 0px\) \+ 18px\);/);
    match(mobileCss, /height: min\(80vh, calc\(var\(--herdr-mobile-viewport-height\) - 24px\)\)/);
    match(mobileCss, /\.temp-terminal-body \{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
  });

  it("loads mobile shell without browser automation", () => {
    const ctx = context();
    doesNotThrow(() => vm.runInContext(source, ctx));
    ok(ctx.HerdrMobile);
  });

  it("renders mobile task hub and action search", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("mobile-task-hub"));
    ok(html.includes("Open workspace or worktree"));
    ok(html.includes("Search and actions"));
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
    ok(html.includes("Temporary terminal"));

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

  it("routes mobile backend headers and sockets from selected backend branches", async () => {
    for (const [storedBackend, expected] of [["external", "external-herdr"], ["external-herdr", "external-herdr"], ["builtin", "builtin"]]) {
      const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
      ctx.localStorage.setItem("herdr-session-backend", storedBackend);
      vm.runInContext(source, ctx);
      await ctx.HerdrMobile.refresh();
      const workspacesRequest = ctx.requests.find((request) => request.url === "/api/workspaces");
      equal(workspacesRequest.opt.headers["x-herdr-backend"], expected);
      ok(ctx.lastSocket.url.includes(`backend=${encodeURIComponent(expected)}`));
    }
    match(source, /state\.backendMode === "external" \|\| state\.backendMode === "external-herdr"/);
    match(source, /state\.backendMode === "builtin"/);
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
    equal(ctx.requests.length, before + 6);

    ctx.document.hidden = true;
    eventSocket.onclose();
    equal(ctx.pendingTimers.filter((timer) => !timer.cleared).length, 0);
    ctx.document.hidden = false;
    ctx.dispatchDocumentEvent("visibilitychange");
    equal(ctx.pendingTimers.filter((timer) => !timer.cleared).length, 2);
  });

  it("renders simplified mobile nav with More menu", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    match(source, /<button data-screen="home">Home<\/button>/);
    match(source, /<button data-screen="search">Search<\/button>/);
    match(source, /<button data-screen="terminal">Terminal<\/button>/);
    match(source, /<button data-screen="more">More<\/button>/);
    ok(!source.includes('data-screen="agents">Agents</button>'));
    doesNotThrow(() => ctx.HerdrMobile.showScreen("more"));
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("More tools"));
    ok(html.includes("HerdrMobile.showScreen('worktrees')"));
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

  it("renders all secondary tools in More while keeping direct routes available", () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.showScreen("more");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    for (const screen of ["agents", "panels", "worktrees", "files", "git", "settings"])
      ok(html.includes(`HerdrMobile.showScreen('${screen}')`));
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
    match(mobileSource, /"x-herdr-backend": currentSessionBackend\(\)/);
    match(mobileSource, /params\.push\("backend=" \+ encodeURIComponent\(currentSessionBackend\(\)\)\)/);
    match(mobileSource, /params\.join\("&"\)/);
    match(mobileSource, /state\.backendMode = settings\.backend_mode/);
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
    match(source, /resetTerminalMouseTracking\(term, terminalMouseReportingEnabled\(\)\)/);
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
    ok(html.includes("Discover worktrees"));
    doesNotThrow(() =>
      ctx.HerdrMobile.updateWorktreeField("worktreeBranch", "feature/mobile"),
    );
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

  it("recreates terminal after leaving and returning to terminal screen", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    ok(ctx.terminalStats.opened >= 1);
    ok(ctx.terminalStats.linksRegistered >= 1);
    ctx.HerdrMobile.showScreen("agents");
    equal(ctx.terminalStats.disposed, 1);
    equal(ctx.terminalStats.linkDisposed, 1);
    ctx.HerdrMobile.showScreen("terminal");
    ok(ctx.terminalStats.opened >= 2);
  });

  it("shows mobile terminal tail button and preserves scrollback on output", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    ok(source.includes("mobileTerminalFollowButton"));
    ok(source.includes('terminal.addEventListener("wheel", handleWheel, { passive: false })'));
    ok(source.includes('terminal.addEventListener("touchmove", handleTouchMove, { passive: false })'));
    ok(source.includes("function scrollLocal(term, direction, lines, afterScroll)"));
    ok(source.includes("HerdrTerminalScroll.scrollLocal(term, direction, lines"));
    equal(typeof ctx.HerdrMobile.scrollTerminalToBottom, "function");
    ctx.lastTerminal.buffer.active.baseY = 50;
    ctx.lastTerminal.buffer.active.viewportY = 20;
    ctx.lastTerminal.onScrollCallback();
    ok(ctx.document.getElementById("mobileTerminalFollowButton").hidden === false);
    ctx.lastSocket.onmessage({ data: "new output" });
    equal(ctx.lastTerminal.scrolledToLine, 20);
    ctx.HerdrMobile.scrollTerminalToBottom();
    ok(ctx.lastTerminal.scrolledToBottom);
  });

  it("captures mobile terminal paste before xterm native paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /sendPasteToTerminal\(text\)/);
    match(source, /sendInputData\(terminalPasteInput\(text, false\)\)/);
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
    ok(source.includes("mobile-tab-close"));
    equal(typeof ctx.HerdrMobile.closeCurrentPanel, "function");
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
    equal(ctx.HerdrMobile.currentSelection().tab, "w1:t2");
    equal(ctx.HerdrMobile.currentSelection().pane, "w1:p2");
    equal(ctx.history.calls.at(-1).path, "/session/default/workspace/w1/tab/t2/pane/p2");
  });
});
