import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

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
    TextDecoder,
    TextEncoder,
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
          this.writes = [];
          this.bridge = { usingAltScreen: () => !normalBuffer };
        }
        async init() { return this; }
        focus() {}
        resize() {}
        write(data) { this.writes.push(data); }
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

function lastWrite(adapter) {
  const writes = adapter.wterm && adapter.wterm.writes;
  return writes && writes[writes.length - 1];
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

describe("terminal adapter inline image fallback", () => {
  it("summarizes iTerm2 inline image OSC without leaking raw payload", async () => {
    const { adapter } = await createAdapter();

    adapter.write(`before\x1b]1337;File=inline=1:${Buffer.from("png").toString("base64")}\x07after`);

    const text = lastWrite(adapter);
    ok(text.includes("before"));
    ok(text.includes("after"));
    ok(text.includes("inline image omitted: iTerm2 graphics"));
    ok(text.includes("chafa --symbols=braille"));
    ok(!text.includes("\x1b]1337;File="));
  });

  it("summarizes Kitty graphics data from byte frames", async () => {
    const { adapter } = await createAdapter();
    const bytes = new TextEncoder().encode("a\x1b_Gf=100;AAAA\x1b\\z");

    adapter.write(bytes);

    const text = lastWrite(adapter);
    ok(text.includes("a"));
    ok(text.includes("z"));
    ok(text.includes("inline image omitted: Kitty graphics"));
    ok(!text.includes("\x1b_G"));
  });

  it("summarizes SIXEL graphics sequences but leaves other DCS sequences untouched", async () => {
    const { adapter } = await createAdapter();

    adapter.write("x\x1bPq#0;2;0;0;0\x1b\\y\x1bP+qnot-sixel\x1b\\");

    const text = lastWrite(adapter);
    ok(text.includes("inline image omitted: SIXEL graphics"));
    ok(text.includes("\x1bP+qnot-sixel\x1b\\"));
  });

  it("buffers split inline image sequences until the terminator arrives", async () => {
    const { adapter } = await createAdapter();

    adapter.write("pre\x1b]1337;File=inline=1:QU");
    adapter.write("JD\x07post");

    equal(lastWrite(adapter), "\r\n[inline image omitted: iTerm2 graphics, payload 3 B; wterm does not render raster image protocols yet. Use chafa --symbols=braille --colors=full for text previews.]\r\npost");
    ok(adapter.wterm.writes[0].includes("pre"));
    ok(!adapter.wterm.writes[0].includes("\x1b]1337;File="));
  });

  it("buffers inline image markers split before the full protocol prefix", async () => {
    const { adapter } = await createAdapter();

    adapter.write(new TextEncoder().encode("pre\x1b]"));
    adapter.write("1337;File=inline=1:QQ==\x07post");

    equal(adapter.wterm.writes[0], "pre");
    ok(lastWrite(adapter).includes("inline image omitted: iTerm2 graphics"));
    ok(lastWrite(adapter).endsWith("post"));
  });
});
