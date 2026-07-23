import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeStyle() {
  return {
    setProperty(name, value) {
      this[name] = String(value);
    },
  };
}

function makeElement() {
  const listeners = new Map();
  const element = {
    listeners,
    style: makeStyle(),
    innerHTML: "",
    _scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 200,
    get scrollTop() {
      return this._scrollTop;
    },
    set scrollTop(value) {
      const max = Math.max(0, (this.scrollHeight || 0) - (this.clientHeight || 0));
      this._scrollTop = Math.max(0, Math.min(max, Number(value) || 0));
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    contains() { return false; },
    querySelector() { return null; },
  };
  return element;
}

function wheelEvent(deltaY, extra = {}) {
  return {
    deltaY,
    deltaMode: 0,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...extra,
  };
}

async function createAdapter({ normalBuffer = true } = {}) {
  const source = readFileSync(new URL("./shared/terminal_adapter.js", import.meta.url), "utf8");
  const container = makeElement();
  const ctx = {
    console,
    setTimeout(fn) { fn(); return 1; },
    requestAnimationFrame(fn) { fn(); return 1; },
    getComputedStyle() {
      return { getPropertyValue(name) { return name === "--term-row-height" ? "20" : ""; }, lineHeight: "20px" };
    },
    getSelection() { return null; },
    open() {},
    HerdrWtermBundle: {
      WTerm: class FakeWTerm {
        constructor(_container, options) {
          this.options = options;
          this.bridge = { usingAltScreen: () => !normalBuffer };
        }
        async init() { return this; }
        focus() {}
        resize() {}
        write() {}
        destroy() { this.destroyed = true; }
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const adapter = await ctx.HerdrTerminalRenderer.create(container, { rows: 24, links: false });
  return { adapter, container };
}

describe("terminal adapter wheel scrolling", () => {
  it("scrolls local wterm scrollback by wheel rows", async () => {
    const { container } = await createAdapter();
    const listener = container.listeners.get("wheel");
    ok(listener);

    const event = wheelEvent(40);
    listener(event);

    equal(event.defaultPrevented, true);
    equal(event.propagationStopped, true);
    equal(container.scrollTop, 440);
  });

  it("does not consume wheel when the alternate screen owns scrolling", async () => {
    const { container } = await createAdapter({ normalBuffer: false });
    const listener = container.listeners.get("wheel");
    ok(listener);

    const event = wheelEvent(40);
    listener(event);

    equal(event.defaultPrevented, false);
    equal(container.scrollTop, 400);
  });

  it("maps line and page wheel units to terminal rows", async () => {
    const { container } = await createAdapter();
    const listener = container.listeners.get("wheel");
    ok(listener);

    listener(wheelEvent(3, { deltaMode: 1 }));
    equal(container.scrollTop, 460);

    listener(wheelEvent(-1, { deltaMode: 2 }));
    equal(container.scrollTop, 0);
  });

  it("removes the wheel listener on destroy", async () => {
    const { adapter, container } = await createAdapter();
    ok(container.listeners.get("wheel"));

    adapter.destroy();

    equal(container.listeners.get("wheel"), undefined);
  });
});
