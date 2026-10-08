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

function makeElement(textarea = null) {
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
    querySelector(selector) { return selector === "textarea" ? textarea : null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
  };
  return element;
}

function wheelEvent(deltaY, extra = {}) {
  return {
    deltaY,
    deltaMode: 0,
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...extra,
  };
}

async function createAdapter({ normalBuffer = true, wheelReports = false, rows = 24, cols = 80, core, inputGate = null } = {}) {
  const source = readFileSync(new URL("./shared/terminal_adapter.js", import.meta.url), "utf8");
  const textarea = inputGate
    ? {
        readOnly: false,
        blurCount: 0,
        focus() { this.focusCount = (this.focusCount || 0) + 1; },
        blur() { this.blurCount += 1; },
      }
    : null;
  const container = makeElement(textarea);
  const reports = [];
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
    document: {
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (this.listeners.get(type) === listener) this.listeners.delete(type);
      },
    },
    open() {},
    HerdrWtermBundle: {
      WTerm: class FakeWTerm {
        constructor(_container, options) {
          this.options = options;
          this.writes = [];
          this.bridge = { usingAltScreen: () => !normalBuffer };
        }
        async init() { return this; }
        focus() { this.focusCount = (this.focusCount || 0) + 1; }
        resize() {}
        write(data) { this.writes.push(data); }
        destroy() { this.destroyed = true; }
      },
      GhosttyCore: {
        async load() { return {}; },
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const adapter = await ctx.HerdrTerminalRenderer.create(container, {
    rows,
    cols,
    core,
    links: false,
    ...(wheelReports ? { onWheelMouseReport: (report) => reports.push(report) } : {}),
    ...(inputGate ? { inputGate } : {}),
  });
  return { adapter, container, ctx, reports, textarea };
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

describe("terminal adapter mobile input gate", () => {
  it("keeps the textarea and adapter focus gated until input is enabled", async () => {
    let enabled = false;
    const gate = () => !enabled;
    gate.enable = () => { enabled = true; };
    const { adapter, container, textarea } = await createAdapter({ inputGate: gate });

    equal(textarea.readOnly, true);
    adapter.focus();
    equal(adapter.wterm.focusCount, undefined);

    const focusin = container.listeners.get("focusin");
    ok(focusin);
    focusin({ target: textarea });
    equal(textarea.blurCount, 1);

    adapter.enableInput();
    equal(textarea.readOnly, false);
    equal(adapter.wterm.focusCount, 1);
    focusin({ target: textarea });
    equal(textarea.blurCount, 1);
  });

  it("cleans up click-focus listeners and interrupted gestures", async () => {
    const { ctx } = await createAdapter();
    const target = makeElement();
    let focused = 0;
    const cleanup = ctx.HerdrTerminalRenderer.attachClickFocus(target, () => { focused += 1; });
    const pointerdown = target.listeners.get("pointerdown");
    ok(pointerdown);

    pointerdown({ button: 0, shiftKey: false, clientX: 10, clientY: 10 });
    ok(ctx.document.listeners.has("mousemove"));
    ok(ctx.document.listeners.has("mouseup"));

    cleanup();
    ok(!target.listeners.has("pointerdown"));
    ok(!ctx.document.listeners.has("mousemove"));
    ok(!ctx.document.listeners.has("mouseup"));
    equal(focused, 0);
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

  it("passes Kitty graphics through on the Ghostty core", async () => {
    const { adapter } = await createAdapter({ core: "ghostty" });

    adapter.write("a\x1b_Gf=100;AAAA\x1b\\z");

    equal(lastWrite(adapter), "a\x1b_Gf=100;AAAA\x1b\\z");
  });

  it("passes split Kitty chunks through on the Ghostty core", async () => {
    const { adapter } = await createAdapter({ core: "ghostty" });

    adapter.write("pre\x1b_Gf=100,m=1;AA");
    adapter.write("AA\x1b\\post");

    equal(adapter.wterm.writes[0], "pre");
    equal(lastWrite(adapter), "\x1b_Gf=100,m=1;AAAA\x1b\\post");
  });

  it("still summarizes iTerm2 and Sixel on the Ghostty core", async () => {
    const { adapter } = await createAdapter({ core: "ghostty" });

    adapter.write(`\x1b]1337;File=inline=1:${Buffer.from("png").toString("base64")}\x07`);
    adapter.write("x\x1bPq#0;2;0;0;0\x1b\\y");

    ok(adapter.wterm.writes[0].includes("inline image omitted: iTerm2 graphics"));
    ok(lastWrite(adapter).includes("inline image omitted: SIXEL graphics"));
  });

  it("still summarizes Kitty graphics on the adapter-level wterm core", async () => {
    // The adapter itself defaults to wterm when constructed without a core;
    // every real caller passes the normalized app setting (ghostty default).
    const { adapter } = await createAdapter();

    adapter.write("a\x1b_Gf=100;AAAA\x1b\\z");

    const text = lastWrite(adapter);
    ok(text.includes("inline image omitted: Kitty graphics"));
    ok(!text.includes("\x1b_G"));
  });
});

describe("terminal adapter mouse-mode tracking", () => {
  it("tracks DECSET/DECRST mouse params from string output", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    ok(typeof apply === "function");

    const state = { tracking: false, sgrMouse: false };
    apply("\x1b[?1049h\x1b[?1000;1006h", state);
    equal(state.tracking, true);
    equal(state.sgrMouse, true);

    apply("\x1b[?1006l", state);
    equal(state.sgrMouse, false);
    equal(state.tracking, true);

    apply("\x1b[?1000l", state);
    equal(state.tracking, false);
  });

  it("ignores non-mouse CSI params and non-private sequences", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    const state = { tracking: false, sgrMouse: false };

    apply("\x1b[?12;25h\x1b[31mfoo\x1b[2J", state);
    equal(state.tracking, false);
    equal(state.sgrMouse, false);

    apply("\x1b[1000;1006h", state);
    equal(state.tracking, false, "non-private CSI must not set mouse mode");

    apply("\x1b[?1006h", state);
    equal(state.sgrMouse, true);
    equal(state.tracking, false, "SGR alone must not enable tracking");
  });

  it("recognizes 1002 and 1003 tracking modes", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    const state = { tracking: false, sgrMouse: false };

    apply("\x1b[?1002;1006h", state);
    equal(state.tracking, true);
    equal(state.sgrMouse, true);

    apply("\x1b[?1002;1006l", state);
    equal(state.tracking, false);
    equal(state.sgrMouse, false);

    apply("\x1b[?1003h", state);
    equal(state.tracking, true);
  });

  it("rejoins DECSET sequences split across writes", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    const state = { tracking: false, sgrMouse: false, carry: "" };

    apply("\x1b[?1000;", state);
    equal(state.tracking, false);
    apply("1006h", state);
    equal(state.tracking, true);
    equal(state.sgrMouse, true);
    equal(state.carry, "");
  });

  it("decodes binary frames and tracks modes from Uint8Array output", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    const state = { tracking: false, sgrMouse: false, carry: "" };

    const bytes = new TextEncoder().encode("\x1b[?1049h\x1b[?1000;1006h");
    apply(bytes, state);
    equal(state.tracking, true);
    equal(state.sgrMouse, true);
  });

  it("drops impossible carry instead of growing without bound", async () => {
    const { ctx } = await createAdapter();
    const apply = ctx.HerdrTerminalRenderer.applyMouseModeSequences;
    const state = { tracking: false, sgrMouse: false, carry: "" };

    apply("x".repeat(40) + "\x1b", state);
    equal(state.carry, "\x1b");
    apply("y".repeat(40), state);
    equal(state.carry, "", "ESC followed by non-CSI bytes is dropped");
    apply("\x1b[?1000h", state);
    equal(state.tracking, true);
  });
});

describe("terminal adapter wheel-to-SGR forwarding", () => {
  it("emits SGR wheel reports on alt screen when tracking is on", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true });

    adapter.write("\x1b[?1049h\x1b[?1000;1006h");
    const listener = container.listeners.get("wheel");
    ok(listener);

    const event = wheelEvent(40);
    listener(event);

    equal(event.defaultPrevented, true);
    equal(event.immediatePropagationStopped, true);
    equal(reports.length, 1);
    equal(reports[0], "\x1b[<65;1;1M", "down wheel becomes ScrollDown at pointer cell");
  });

  it("maps scroll magnitude to repeated reports", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true });

    adapter.write("\x1b[?1000;1006h");
    const listener = container.listeners.get("wheel");
    listener(wheelEvent(-40));

    equal(reports.length, 1);
    equal(reports[0], "\x1b[<64;1;1M", "up wheel becomes a single ScrollUp report like xterm.js");
  });

  it("does not report when mouse tracking is disabled", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true });

    adapter.write("\x1b[?1049h");
    const listener = container.listeners.get("wheel");
    const event = wheelEvent(40);
    listener(event);

    equal(reports.length, 0);
    equal(event.defaultPrevented, false);
    equal(container.scrollTop, 400);
  });

  it("does not report without SGR encoding", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true });

    adapter.write("\x1b[?1000h");
    const listener = container.listeners.get("wheel");
    const event = wheelEvent(40);
    listener(event);

    equal(reports.length, 0, "X10/normal encoding cannot carry wheel reports");
    equal(event.defaultPrevented, false);
  });

  it("does not report when no callback is wired", async () => {
    const { adapter, container } = await createAdapter({ normalBuffer: false, wheelReports: false });

    adapter.write("\x1b[?1000;1006h");
    const listener = container.listeners.get("wheel");
    const event = wheelEvent(40);
    listener(event);

    equal(event.defaultPrevented, false);
    equal(container.scrollTop, 400);
  });

  it("resets to local scrollback scrolling when tracking is disabled again", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: true, wheelReports: true });

    // Normal buffer: local scroll even with tracking on
    adapter.write("\x1b[?1000;1006h");
    let listener = container.listeners.get("wheel");
    let event = wheelEvent(40);
    listener(event);
    equal(reports.length, 0);
    equal(container.scrollTop, 440);

    // Simulate switch to alt screen by the program
    adapter.wterm.bridge.usingAltScreen = () => true;
    event = wheelEvent(40);
    listener(event);
    equal(reports.length, 1);
    equal(container.scrollTop, 440, "no local scroll on alt screen");

    // Program disables tracking: back to no-op wheel (alt screen, no tracking)
    adapter.write("\x1b[?1000l");
    event = wheelEvent(40);
    listener(event);
    equal(reports.length, 1);
    equal(container.scrollTop, 440);
  });

  it("uses the tracked pointer cell for report coordinates", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true, cols: 80, rows: 24 });

    adapter.write("\x1b[?1000;1006h");
    const move = container.listeners.get("pointermove");
    ok(move, "pointermove listener registered");
    move({ clientX: 100, clientY: 60 });

    const listener = container.listeners.get("wheel");
    listener(wheelEvent(40));

    equal(reports[0], "\x1b[<65;12;4M", "cell 100/9=column 12, 60/20=row 4");
  });

  it("clamps pointer coordinates to the terminal grid", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true, cols: 80, rows: 24 });

    adapter.write("\x1b[?1000;1006h");
    const move = container.listeners.get("pointermove");
    move({ clientX: 9999, clientY: 9999 });

    const listener = container.listeners.get("wheel");
    listener(wheelEvent(40));

    equal(reports[0], "\x1b[<65;80;24M");
  });

  it("keeps a sane default cell when the pointer never moved", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true, cols: 80, rows: 24 });

    adapter.write("\x1b[?1000;1006h");
    const listener = container.listeners.get("wheel");
    listener(wheelEvent(40));

    equal(reports[0], "\x1b[<65;1;1M");
  });

  it("clamps coordinate inputs in sgrWheelReport", async () => {
    const { ctx } = await createAdapter();
    const report = ctx.HerdrTerminalRenderer.sgrWheelReport;
    ok(typeof report === "function");

    equal(report(true, 0, -5), "\x1b[<64;1;1M");
    equal(report(false, 2.9, 3.9), "\x1b[<65;2;3M");
    equal(report(true, NaN, NaN), "\x1b[<64;1;1M");
  });

  it("forwards wheel reports as adapter write-driven tracking via full write path", async () => {
    const { adapter, container, reports } = await createAdapter({ normalBuffer: false, wheelReports: true });

    // Write with callback, binary frame, split sequences: all must feed the tracker.
    adapter.write(new TextEncoder().encode("\x1b[?1049h"), () => {});
    adapter.write("\x1b[?100", () => {});
    adapter.write("0;1006h", () => {});
    equal(adapter.mouseMode().tracking, true);
    equal(adapter.mouseMode().sgr, true);

    const listener = container.listeners.get("wheel");
    listener(wheelEvent(40));
    equal(reports.length, 1);
    equal(reports[0], "\x1b[<65;1;1M");
  });

  it("removes the pointer listener on destroy", async () => {
    const { adapter, container } = await createAdapter({ wheelReports: true });
    ok(container.listeners.get("pointermove"));

    adapter.destroy();

    equal(container.listeners.get("pointermove"), undefined);
  });

  it("delegates a full palette to wterm setThemeColors for a repaint", async () => {
    const { adapter, ctx } = await createAdapter();
    const wterm = adapter.wterm;
    wterm.themeColorsCalls = [];
    wterm.setThemeColors = (colors) => { wterm.themeColorsCalls.push(colors); };

    const theme = {
      foreground: "#cdd6f4",
      background: "#11111b",
      cursor: "#89b4fa",
      selectionBackground: "#89b4fa",
      black: "#6c7086", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5", white: "#cdd6f4",
      brightBlack: "#9399b2", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#cba6f7", brightCyan: "#94e2d5", brightWhite: "#ffffff",
    };
    adapter.setTheme(theme);

    equal(wterm.themeColorsCalls.length, 1, "wterm.setThemeColors called once");
    const colors = wterm.themeColorsCalls[0];
    equal(colors.foreground, 0xcdd6f4, "foreground converted to 24-bit int");
    equal(colors.background, 0x11111b, "background converted to 24-bit int");
    equal(colors.palette.length, 16, "exactly 16 palette entries");
    equal(colors.palette[0], 0x6c7086, "palette order starts at black");
  });

  it("falls back to CSS vars when the palette is incomplete", async () => {
    const { adapter, container } = await createAdapter();
    const wterm = adapter.wterm;
    wterm.themeColorsCalls = [];
    wterm.setThemeColors = (colors) => { wterm.themeColorsCalls.push(colors); };

    adapter.setTheme({ foreground: "#cdd6f4", background: "#11111b" });

    equal(wterm.themeColorsCalls.length, 0, "no native call without cursor and palette");
    equal(container.style["--term-fg"], "#cdd6f4", "CSS var mirror applied");
    equal(container.style["--term-bg"], "#11111b", "CSS var mirror applied");
  });

  it("writes the selection background as --term-selection-bg", async () => {
    const { adapter, container } = await createAdapter();
    adapter.setTheme({ foreground: "#cdd6f4", selectionBackground: "#89b4fa" });
    equal(container.style["--term-selection-bg"], "#89b4fa", "selection var matches wterm.css contract");
  });
});
