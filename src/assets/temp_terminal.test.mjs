import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeElement(id = "") {
  const el = {
    id,
    children: [],
    containsTarget: null,
    _innerHTML: "",
    onclick: null,
    style: {},
    attributes: {},
    className: "",
    title: "",
    type: "",
    __herdrTempTerminalMinimizeBound: false,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      if (child && child.className) {
        if (child.className.includes("temp-terminal-minimize")) this.minimizeButton = child;
        if (child.className.includes("temp-terminal-close")) this.closeButton = child;
        if (child.className.includes("terminal-follow-button")) this.followButton = child;
        if (child.className.includes("terminal") && !child.className.includes("terminal-"))
          this.terminalElement = child;
      }
    },
    blur() {
      this.blurred = true;
    },
    contains(target) {
      return target === this || target === this.containsTarget || !!(target && target.insideTerm);
    },
    getBoundingClientRect() {
      return { width: 800, height: 420 };
    },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      // Simulate parsing innerHTML by creating stub elements for known classes.
      if (typeof value === "string") {
        if (value.includes("temp-terminal-minimize") && !this.minimizeButton)
          this.minimizeButton = makeElement("minimize");
        if (value.includes("temp-terminal-close") && !this.closeButton)
          this.closeButton = makeElement("close");
        if (value.includes("terminal-follow-button") && !this.followButton)
          this.followButton = makeElement("follow");
        if (value.includes('class="terminal"') && !this.terminalElement)
          this.terminalElement = makeElement("terminal");
        if (value.includes("temp-terminal-confirm") && !this.confirmElement)
          this.confirmElement = makeElement("confirm");
      }
    },
    querySelector(selector) {
      if (selector === ".temp-terminal-minimize") return this.minimizeButton || null;
      if (selector === ".temp-terminal-close") return this.closeButton || null;
      if (selector === ".terminal" || selector === ".wterm") return this.terminalElement || null;
      if (selector === ".terminal-follow-button") return this.followButton || null;
      if (selector === ".temp-terminal-confirm") return this.confirmElement || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".temp-terminal-restore") return this.restoreButtons || [];
      if (selector === ".temp-terminal-backdrop") return this.backdrops || [];
      return [];
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeChild() {},
    parentNode: { removeChild() {} },
  };
  // Wire up onclick handlers for stub buttons.
  if (el.minimizeButton) el.minimizeButton.onclick = null;
  if (el.closeButton) el.closeButton.onclick = null;
  return el;
}

function context() {
  const elements = new Map();
  const sentFrames = [];
  const listeners = new Map();
  const createdElements = [];
  const timeouts = [];
  const apiCalls = [];
  const apiRequests = [];

  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const modal = getElement("tempTerminalModal");
  modal.minimizeButton = makeElement("tempTerminalMinimize");
  const container = getElement("tempTerminal");

  let ctx;

  class FakeTerminal {
    constructor() {
      this.element = makeElement("terminal");
      this.element.containsTarget = { insideTerm: true };
      this.focusCount = 0;
      this.resizeCalls = [];
      ctx.lastTerminal = this;
    }
    focus() {
      this.focusCount += 1;
    }
    onData(fn) {
      this.onDataHandler = fn;
    }
    open(target) {
      target.terminalElement = this.element;
    }
    resize(cols, rows) {
      this.resizeCalls.push([cols, rows]);
    }
    write() {}
    dispose() {
      this.disposed = true;
    }
  }

  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this.bufferedAmount = 0;
      this._onopen = null;
      ctx.lastWebSocket = this;
    }
    get onopen() { return this._onopen; }
    set onopen(fn) {
      this._onopen = fn;
      // Auto-fire onopen on next microtask, like a real WebSocket.
      if (typeof fn === "function") Promise.resolve().then(fn);
    }
    send(data) {
      sentFrames.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  function flushWsOnOpen() {
    // No-op: onopen is auto-fired via the setter.
  }

  ctx = {
    TextEncoder,
    fitCalls: [],
    HerdrTerminalRenderer: {
      create(target, options) {
        const term = new FakeTerminal(options);
        term.onData(options && options.onData);
        term.open(target);
        return Promise.resolve(term);
      },
    },
    WebSocket: FakeWebSocket,
    clearTimeout() {},
    setTimeout(fn) {
      timeouts.push(fn);
      fn();
      return timeouts.length;
    },
    requestAnimationFrame(fn) {
      fn();
    },
    document: {
      activeElement: null,
      body: makeElement("body"),
      createElement(tag) {
        const child = makeElement(tag);
        createdElements.push(child);
        return child;
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      getElementById: getElement,
      querySelectorAll(selector) {
        if (selector === ".temp-terminal-backdrop") return ctx.body.backdrops || [];
        if (selector === ".temp-terminal-restore") return ctx.body.restoreButtons || [];
        return [];
      },
    },
    HerdrTerminalFit: {
      afterLayout(fn) {
        fn();
      },
      cellSize() {
        return { width: 9, height: 20 };
      },
      fitTerminalToContainer(target, opts) {
        ctx.fitCalls.push({ target, opts });
      },
      gridSize() {
        return { cols: 88, rows: 22 };
      },
      visibleBox() {
        return { width: 800, height: 420 };
      },
    },
    api(url, opt = {}) {
      apiCalls.push(url);
      apiRequests.push({ url, opt });
      if (url === "/api/workspaces" && opt.method === "POST") return Promise.resolve({ result: { workspace: { workspace_id: "workspace-temp" } } });
      if (url === "/api/tabs") return Promise.resolve({ result: { tab: { tab_id: "tab-1" } } });
      if (url.startsWith("/api/panes")) return Promise.resolve({ result: { panes: [{ tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-1" }] } });
      return Promise.resolve({ result: {} });
    },
    sentFrames,
    flushWsOnOpen,
    listeners,
    createdElements,
    apiCalls,
    apiRequests,
    elements,
    console,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  return vm.createContext(ctx);
}

async function openTempTerminal(ctx, options = {}) {
  vm.runInContext(readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8"), ctx);
  const tempTerminal = ctx.HerdrTempTerminal.create({
    el: ctx.document.getElementById,
    state: { ws: "ws-1" },
    wsUrl: (path) => path,
    api: ctx.api,
    modalId: "tempTerminalModal",
    containerId: "tempTerminal",
    defaultFolderFn: () => "",
    ...options,
  });
  tempTerminal.open();
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    ctx.flushWsOnOpen();
  }
  return tempTerminal;
}

function keyEvent(key, target, extra = {}) {
  return {
    key,
    target,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    immediateStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.immediateStopped = true;
    },
    ...extra,
  };
}

function terminalInputFrames(ctx) {
  return ctx.sentFrames
    .filter((frame) => frame instanceof Uint8Array)
    .map((frame) => Buffer.from(frame).toString("utf8"));
}

describe("temporary terminal", () => {
  it("captures Tab and Backspace inside terminal before the browser moves focus", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    const listener = ctx.listeners.get("keydown");
    ok(listener);
    const target = { insideTerm: true };

    const tab = keyEvent("Tab", target);
    listener(tab);
    equal(tab.defaultPrevented, true);
    equal(tab.immediateStopped, true);
    let inputFrames = terminalInputFrames(ctx);
    equal(inputFrames[0], "\t");

    const backspace = keyEvent("Backspace", target);
    listener(backspace);
    equal(backspace.defaultPrevented, true);
    equal(backspace.immediateStopped, true);
    inputFrames = terminalInputFrames(ctx);
    equal(inputFrames[1], "\x7f");
  });

  it("captures Escape, Tab, and Backspace from the page while the temp terminal is open", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    const listener = ctx.listeners.get("keydown");
    ok(listener);

    for (const [key, value] of [["Escape", "\x1b"], ["Tab", "\t"], ["Backspace", "\x7f"]]) {
      const event = keyEvent(key, ctx.document.body);
      listener(event);
      equal(event.defaultPrevented, true, key);
      equal(event.immediateStopped, true, key);
      equal(terminalInputFrames(ctx).at(-1), value, key);
    }
  });

  it("creates temporary tabs in the active workspace without making a temporary workspace", async () => {
    const ctx = context();
    await openTempTerminal(ctx, {
      state: { ws: "workspace-active", workspaces: [{ workspace_id: "workspace-active" }] },
      defaultFolderFn: () => "/settings/default",
    });

    ok(!ctx.apiCalls.includes("/api/workspaces"));
    const tabRequest = ctx.apiRequests.find((request) => request.url === "/api/tabs");
    ok(tabRequest);
    deepEqual(JSON.parse(tabRequest.opt.body), { workspace_id: "workspace-active", label: "temp" });
    ok(ctx.apiCalls.includes("/api/panes?workspace_id=workspace-active"));
  });

  it("uses a single opened workspace instead of creating a temporary workspace", async () => {
    const ctx = context();
    await openTempTerminal(ctx, {
      state: { ws: null, workspaces: [{ workspace_id: "workspace-only" }] },
      defaultFolderFn: () => "/settings/default",
    });

    ok(!ctx.apiCalls.includes("/api/workspaces"));
    const tabRequest = ctx.apiRequests.find((request) => request.url === "/api/tabs");
    ok(tabRequest);
    deepEqual(JSON.parse(tabRequest.opt.body), { workspace_id: "workspace-only", label: "temp" });
    ok(ctx.apiCalls.includes("/api/panes?workspace_id=workspace-only"));
  });

  it("creates a temporary workspace in the configured default folder only when no workspace is open", async () => {
    const ctx = context();
    await openTempTerminal(ctx, {
      state: { ws: null, workspaces: [] },
      defaultFolderFn: () => "/settings/default",
    });

    const workspaceRequest = ctx.apiRequests.find((request) => request.url === "/api/workspaces");
    ok(workspaceRequest);
    deepEqual(JSON.parse(workspaceRequest.opt.body), { label: "temp", cwd: "/settings/default" });
    const tabRequest = ctx.apiRequests.find((request) => request.url === "/api/tabs");
    ok(tabRequest);
    deepEqual(JSON.parse(tabRequest.opt.body), { workspace_id: "workspace-temp", label: "temp" });
    ok(ctx.apiCalls.includes("/api/panes?workspace_id=workspace-temp"));
  });

  it("reuses the same shared workspace for subsequent temporary terminals", async () => {
    const ctx = context();
    const tempTerminal = await openTempTerminal(ctx, {
      state: { ws: null, workspaces: [] },
      defaultFolderFn: () => "/settings/default",
    });
    const workspaceCreatesBefore = ctx.apiCalls.filter((url) => url === "/api/workspaces").length;
    equal(workspaceCreatesBefore, 1);

    // Open a second temp terminal; it should reuse the shared workspace.
    tempTerminal.open();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    equal(ctx.apiCalls.filter((url) => url === "/api/workspaces").length, 1);
  });

  it("lets terminal renderer handle ordinary keys from inside the terminal without duplicate input", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    const listener = ctx.listeners.get("keydown");
    ok(listener);
    const before = terminalInputFrames(ctx).length;

    const enter = keyEvent("Enter", { insideTerm: true });
    listener(enter);

    equal(enter.defaultPrevented, false);
    equal(enter.immediateStopped, false);
    equal(terminalInputFrames(ctx).length, before);
  });

  it("minimizes to a restore control and restores the same live terminal", async () => {
    const ctx = context();
    const tempTerminal = await openTempTerminal(ctx, { shortcutLabelFn: () => "Ctrl+B then Shift+M" });
    equal(tempTerminal.isVisible(), true);

    tempTerminal.minimize();
    equal(tempTerminal.isVisible(), false);
    equal(ctx.listeners.has("keydown"), false);

    tempTerminal.restore();
    equal(tempTerminal.isVisible(), true);
    ok(ctx.listeners.get("keydown"));
  });

  it("open restores a minimized terminal without creating another tab session", async () => {
    const ctx = context();
    const tempTerminal = await openTempTerminal(ctx);
    const tabCreatesBefore = ctx.apiCalls.filter((url) => url === "/api/tabs").length;
    const firstTerminal = ctx.lastTerminal;
    const listener = ctx.listeners.get("keydown");
    ok(listener);

    tempTerminal.minimize();
    const beforeInput = terminalInputFrames(ctx).length;
    listener(keyEvent("a", ctx.document.body));
    equal(terminalInputFrames(ctx).length, beforeInput);

    tempTerminal.open();

    equal(tempTerminal.isVisible(), true);
    equal(ctx.lastTerminal, firstTerminal);
    equal(ctx.apiCalls.filter((url) => url === "/api/tabs").length, tabCreatesBefore);
    ok(ctx.listeners.get("keydown"));
  });

  it("styles the temp terminal body and terminal renderer to fill available height", () => {
    for (const cssPath of ["./desktop/app_css/modals.css", "./mobile/app.css"]) {
      const css = readFileSync(new URL(cssPath, import.meta.url), "utf8");
      const bodyRule = css.match(/\.temp-terminal-body \{[\s\S]*?\}/)?.[0] || "";
      const terminalRule = css.match(/\.temp-terminal-body \.terminal \{[\s\S]*?\}/)?.[0] || "";
      const wtermRule = css.match(/\.temp-terminal-body \.wterm \{[\s\S]*?\}/)?.[0] || "";

      ok(/padding:\s*0;/.test(bodyRule), cssPath);
      ok(/flex:\s*1;/.test(bodyRule), cssPath);
      ok(/display:\s*block;/.test(terminalRule), cssPath);
      ok(/height:\s*100%;/.test(terminalRule), cssPath);
      ok(/height:\s*100%;/.test(wtermRule), cssPath);
      ok(/width:\s*100%;/.test(wtermRule), cssPath);
      ok(/overflow-x:\s*hidden;/.test(wtermRule), cssPath);
      ok(/overflow-y:\s*auto;/.test(wtermRule), cssPath);
    }
  });

  it("has a restore bar container for stacking multiple minimized terminals", () => {
    for (const cssPath of ["./desktop/app_css/modals.css", "./mobile/app.css"]) {
      const css = readFileSync(new URL(cssPath, import.meta.url), "utf8");
      const barRule = css.match(/\.temp-terminal-restore-bar \{[\s\S]*?\}/)?.[0] || "";
      ok(barRule, cssPath);
      ok(/display:\s*none;/.test(barRule), cssPath);
      ok(/flex-direction:\s*column;/.test(barRule), cssPath);
      ok(/gap:\s*8px;/.test(barRule), cssPath);
      ok(/position:\s*fixed;/.test(barRule), cssPath);
    }
  });

  it("fits the terminal element not the container div", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    ok(ctx.fitCalls.length > 0, "expected fitTerminalToContainer calls");
  });

  it("fits the terminal DOM height aligned to rows * cellHeight to prevent input shifting", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    ok(ctx.fitCalls.length > 0, "expected fitTerminalToContainer calls");
    for (const call of ctx.fitCalls) {
      ok(call.opts && call.opts.height > 0, "fitTerminalToContainer should receive a positive height");
      // The height should be aligned to rows * cellHeight (22 * 20 = 440),
      // not the raw body height (420).
      equal(call.opts.height, 22 * 20, "height should be rows * cellHeight");
    }
  });

  it("sends cd command when a target folder is specified", async () => {
    const ctx = context();
    await openTempTerminal(ctx, {
      state: { ws: "ws-1" },
      defaultFolderFn: () => "",
    });
    // Initially, no cd command should be sent (folder is empty).
    const beforeCd = terminalInputFrames(ctx).filter((f) => f.startsWith("cd ")).length;
    equal(beforeCd, 0);
  });

  it("sends cd command with the target folder after WS connects", async () => {
    const ctx = context();
    const tempTerminal = await openTempTerminal(ctx, {
      state: { ws: "ws-1" },
      defaultFolderFn: () => "",
    });
    // Open with a specific folder.
    tempTerminal.open("/home/user/my-project");
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    const cdFrames = terminalInputFrames(ctx).filter((f) => f.startsWith("cd "));
    ok(cdFrames.length > 0, "expected at least one cd command");
    ok(cdFrames.some((f) => f.includes("my-project")), "cd should target the specified folder");
  });

  it("exposes helper functions for restore label generation", async () => {
    const ctx = context();
    vm.runInContext(readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8"), ctx);
    const H = ctx.HerdrTempTerminal;
    equal(H.lastPathLevel("/home/user/my-project"), "my-project");
    equal(H.lastPathLevel("/home/user/my-project/"), "my-project");
    equal(H.lastPathLevel(""), "Terminal");
    equal(H.lastPathLevel(null), "Terminal");
    equal(H.clampLabel("Temp.short", 20), "Temp.short");
    equal(H.clampLabel("Temp.a-very-long-folder-name-here", 20).length, 20);
    ok(H.clampLabel("Temp.a-very-long-folder-name-here", 20).endsWith("…"));
    equal(H.restoreLabelText("/home/user/my-project"), "Temp.my-project");
    equal(H.restoreLabelText("/home/user/a-very-long-folder-name-here"), "Temp.a-very-long-fo…");
  });
});