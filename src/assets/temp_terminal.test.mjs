import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeElement(id = "") {
  return {
    id,
    children: [],
    containsTarget: null,
    innerHTML: "",
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
    querySelector(selector) {
      if (selector === ".temp-terminal-minimize") return this.minimizeButton || null;
      if (selector === ".xterm") return this.xtermElement || null;
      return null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function context() {
  const elements = new Map();
  const sentFrames = [];
  const listeners = new Map();
  const createdButtons = [];
  const timeouts = [];

  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const modal = getElement("tempTerminalModal");
  modal.minimizeButton = makeElement("tempTerminalMinimize");
  const container = getElement("tempTerminal");

  class FakeTerminal {
    constructor() {
      this.element = makeElement("xterm");
      this.element.containsTarget = { insideTerm: true };
      this.focusCount = 0;
      this.resizeCalls = [];
      context.lastTerminal = this;
    }
    focus() {
      this.focusCount += 1;
    }
    onData(fn) {
      this.onDataHandler = fn;
    }
    open(target) {
      target.xtermElement = this.element;
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
      context.lastWebSocket = this;
    }
    send(data) {
      sentFrames.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  const ctx = {
    TextEncoder,
    Terminal: FakeTerminal,
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
        createdButtons.push(child);
        return child;
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      getElementById: getElement,
    },
    HerdrTerminalFit: {
      afterLayout(fn) {
        fn();
      },
      cellSize() {
        return { width: 9, height: 20 };
      },
      fitXtermToContainer() {},
      gridSize() {
        return { cols: 88, rows: 22 };
      },
      visibleBox() {
        return { width: 800, height: 420 };
      },
    },
    api(url) {
      if (url === "/api/tabs") return Promise.resolve({ result: { tab: { tab_id: "tab-1" } } });
      if (url.startsWith("/api/panes")) return Promise.resolve({ result: { panes: [{ tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-1" }] } });
      return Promise.resolve({ result: {} });
    },
    sentFrames,
    listeners,
    createdButtons,
    elements,
    console,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  return vm.createContext(ctx);
}

async function openTempTerminal(ctx) {
  vm.runInContext(readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8"), ctx);
  const tempTerminal = ctx.HerdrTempTerminal.create({
    el: ctx.document.getElementById,
    state: { ws: "ws-1" },
    wsUrl: (path) => path,
    api: ctx.api,
    modalId: "tempTerminalModal",
    containerId: "tempTerminal",
    defaultFolderFn: () => "",
  });
  tempTerminal.open();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

describe("temporary terminal", () => {
  it("captures Tab and Backspace inside xterm before the browser moves focus", async () => {
    const ctx = context();
    await openTempTerminal(ctx);
    const listener = ctx.listeners.get("keydown");
    ok(listener);
    const target = { insideTerm: true };

    const tab = keyEvent("Tab", target);
    listener(tab);
    equal(tab.defaultPrevented, true);
    equal(tab.immediateStopped, true);
    let inputFrames = ctx.sentFrames.filter((frame) => frame instanceof Uint8Array);
    equal(Buffer.from(inputFrames[0]).toString("utf8"), "\t");

    const backspace = keyEvent("Backspace", target);
    listener(backspace);
    equal(backspace.defaultPrevented, true);
    equal(backspace.immediateStopped, true);
    inputFrames = ctx.sentFrames.filter((frame) => frame instanceof Uint8Array);
    equal(Buffer.from(inputFrames[1]).toString("utf8"), "\x7f");
  });

  it("minimizes to a corner restore control and restores the same live terminal", async () => {
    const ctx = context();
    const tempTerminal = await openTempTerminal(ctx);
    const modal = ctx.elements.get("tempTerminalModal");
    const restoreButton = ctx.createdButtons.find((button) => button.className === "temp-terminal-restore");
    ok(restoreButton);
    equal(tempTerminal.isVisible(), true);

    tempTerminal.minimize();
    equal(tempTerminal.isVisible(), false);
    equal(modal.style.display, "none");
    equal(modal.attributes["aria-hidden"], "true");
    equal(restoreButton.style.display, "inline-flex");
    equal(ctx.listeners.has("keydown"), false);

    restoreButton.onclick();
    equal(tempTerminal.isVisible(), true);
    equal(modal.style.display, "grid");
    equal(modal.attributes["aria-hidden"], undefined);
    equal(restoreButton.style.display, "none");
    ok(ctx.listeners.get("keydown"));
  });
});
