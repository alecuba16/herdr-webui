import { describe, it } from "node:test";
import { doesNotThrow, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";
import vm from "node:vm";

function element(id = "") {
  return {
    id,
    classList: { toggle() {}, add() {}, remove() {} },
    dataset: {},
    style: { setProperty() {} },
    hidden: false,
    innerHTML: "",
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

function context(pathname = "/") {
  const elements = new Map();
  const localStorage = new Map();
  const historyCalls = [];
  const terminalStats = { disposed: 0, opened: 0 };
  const requests = [];
  const navButtons = ["home", "agents", "panels", "worktrees", "files", "git", "terminal"].map(
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
    setTimeout() {},
    clearTimeout() {},
    document: {
      body: element("body"),
      createElement: () => element(),
      getElementById: getElement,
      querySelectorAll: (selector) =>
        selector === ".mobile-nav button" ? navButtons : [],
      addEventListener() {},
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
      constructor() {
        this.readyState = 1;
        this.bufferedAmount = 0;
        ctx.lastSocket = this;
      }
      send() {}
      close() {}
    },
    fetch: async (url, opt = {}) => {
      requests.push({ url, opt });
      if (url === "/api/tabs" && opt.method === "POST")
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { tab: { tab_id: "w1:t3" } } }),
        };
      const result = url.includes("workspaces")
        ? {
            workspaces: [{ workspace_id: "w1", label: "alpha", pane_count: 1 }],
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
                },
              ],
            }
          : url.includes("tabs")
            ? {
                tabs: [
                  { workspace_id: "w1", tab_id: "w1:t1", number: 1 },
                  { workspace_id: "w1", tab_id: "w1:t2", number: 2 },
                ],
              }
            : url.includes("panes")
              ? {
                  panes: [
                    { tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
                    { tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term2" },
                  ],
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
                  ],
                };
      return { ok: true, status: 200, json: async () => ({ result }) };
    },
  };
  ctx.terminalStats = terminalStats;
  ctx.requests = requests;
  ctx.navButtons = navButtons;
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
    readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8") +
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

  it("loads mobile shell without browser automation", () => {
    const ctx = context();
    doesNotThrow(() => vm.runInContext(source, ctx));
    ok(ctx.HerdrMobile);
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
    ok(settingsHtml.includes("HerdrMobile.setTerminalFontFamily"));
    equal(typeof ctx.HerdrMobile.setTerminalFontFamily, "function");
    equal(typeof ctx.HerdrMobile.applyTerminalFontFamily, "function");
    doesNotThrow(() =>
      ctx.HerdrMobile.setTerminalFontFamily("Hack Nerd Font, monospace"),
    );
    doesNotThrow(() => ctx.HerdrMobile.showScreen("worktrees"));
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
    ctx.HerdrMobile.showScreen("agents");
    equal(ctx.terminalStats.disposed, 1);
    ctx.HerdrMobile.showScreen("terminal");
    ok(ctx.terminalStats.opened >= 2);
  });

  it("shows mobile terminal tail button and preserves scrollback on output", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("terminal");
    ok(source.includes("mobileTerminalFollowButton"));
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

  it("renders mobile worktree path input and discovers by cwd", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    ctx.HerdrMobile.showScreen("worktrees");
    ctx.HerdrMobile.updateWorktreeField("worktreeDiscoverPath", "~/code/repo");
    await ctx.HerdrMobile.loadWorktrees();
    ok(
      ctx.requests.some(
        (request) => request.url === "/api/worktrees?cwd=~%2Fcode%2Frepo",
      ),
    );
  });

  it("stores mobile default directory and prefills worktree discovery path", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);

    ctx.HerdrMobile.setDefaultDirectory("/tmp/code");
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

  it("shows highest-priority agent status in agents tab label", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    const agentsButton = ctx.navButtons.find(
      (button) => button.dataset.screen === "agents",
    );
    ok(agentsButton.innerHTML.includes("blocked"));
  });

  it("sorts mobile agents by attention priority", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.refresh();
    ctx.HerdrMobile.showScreen("agents");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.indexOf("blocked-agent") < html.indexOf("done-agent"));
  });

  it("shows worktree name as title and repo name as meta", async () => {
    const ctx = context("/session/default/workspace/w1/tab/t1/pane/p1");
    vm.runInContext(source, ctx);
    await ctx.HerdrMobile.loadWorktrees();
    ctx.HerdrMobile.showScreen("worktrees");
    const html = ctx.document.getElementById("mobileScreen").innerHTML;
    ok(html.includes("<strong>mobile-worktree</strong>"));
    ok(html.includes("<small>alpha</small>"));
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
});
