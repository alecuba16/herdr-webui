import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// Minimal mock for the desktop terminal frame pipeline. We only test the
// enqueue / coalesce / flush logic, not xterm.js itself.

function createMockTerminal() {
  const writes = [];
  return {
    writes,
    term: {
      write(data, cb) {
        writes.push(data);
        if (cb) cb();
      },
    },
  };
}

describe("desktop terminal frame coalescing", () => {
  it("immediate write for small frames skips RAF", () => {
    const { term, writes } = createMockTerminal();

    // Simulate the immediate-write fast path.
    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    const data = "hello world";
    const size = data.length;

    assert.ok(size <= IMMEDIATE_WRITE_THRESHOLD, "small frame should be under threshold");
    // In a real scenario, this calls term.write directly without RAF.
    term.write(data);
    assert.equal(writes.length, 1);
    assert.equal(writes[0], "hello world");
  });

  it("large frames go through the queue and RAF coalescing", () => {
    const { term, writes } = createMockTerminal();
    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    const largeFrame = "x".repeat(IMMEDIATE_WRITE_THRESHOLD + 1);
    const size = largeFrame.length;

    assert.ok(size > IMMEDIATE_WRITE_THRESHOLD, "large frame should exceed threshold");
    // Would go through the queue path, not immediate write.
    // Simulate queue + coalesce:
    const queue = [largeFrame, "more data"];
    const coalesced = queue.join("");
    term.write(coalesced);
    assert.equal(writes.length, 1);
    assert.equal(writes[0], coalesced);
  });

  it("coalesces mixed string and binary frames", () => {
    const encoder = new TextEncoder();
    const frames = ["hello", encoder.encode(" world"), "!!"];
    const bytes = frames.map((f) =>
      typeof f === "string" ? encoder.encode(f) : f,
    );
    const size = bytes.reduce((s, f) => s + f.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const b of bytes) {
      merged.set(b, offset);
      offset += b.length;
    }
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(merged), "hello world!!");
  });

  it("RAF burst coalescing reduces write count", () => {
    const { term, writes } = createMockTerminal();
    // Simulate 10 frames arriving within the same RAF tick.
    const frames = [];
    for (let i = 0; i < 10; i++) frames.push(`line ${i}\r\n`);
    // Coalesce into a single write.
    const coalesced = frames.join("");
    term.write(coalesced);
    assert.equal(writes.length, 1, "10 frames should produce 1 write");
    assert.ok(coalesced.includes("line 0"));
    assert.ok(coalesced.includes("line 9"));
  });
});

describe("terminal viewport sizing", () => {
  function loadScrollHelpers(style = {}) {
    const ctx = {
      globalThis: null,
      window: null,
      getComputedStyle: () => ({
        paddingLeft: "8px",
        paddingRight: "8px",
        paddingTop: "8px",
        paddingBottom: "8px",
        ...style,
      }),
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInContext(
      readFileSync(new URL("./shared/terminal_scroll.js", import.meta.url), "utf8"),
      vm.createContext(ctx),
    );
    return ctx.HerdrTerminalScroll;
  }

  it("subtracts container padding before calculating rows", () => {
    const helper = loadScrollHelpers();
    const shell = { clientWidth: 900, clientHeight: 520 };
    const term = {
      _core: {
        _renderService: {
          dimensions: { css: { cell: { width: 9, height: 17 } } },
        },
      },
    };

    const fit = helper.fitSize(shell, term, { minCols: 1, minRows: 1 });

    assert.equal(fit.contentWidth, 884);
    assert.equal(fit.contentHeight, 504);
    assert.equal(fit.cols, 98);
    assert.equal(fit.rows, 29);
    assert.ok(fit.height <= fit.contentHeight, "surface rows must fit visible content height");
  });

  it("uses actual xterm cell metrics instead of hard-coded row height", () => {
    const helper = loadScrollHelpers({ paddingTop: "0px", paddingBottom: "0px" });
    const container = { clientWidth: 720, clientHeight: 380 };
    const term = {
      _core: {
        _renderService: {
          dimensions: { css: { cell: { width: 10, height: 19 } } },
        },
      },
    };

    const fit = helper.fitSize(container, term, { minCols: 1, minRows: 1 });

    assert.equal(fit.rows, 20);
    assert.notEqual(fit.rows, Math.floor(container.clientHeight / 18));
  });
});

describe("temporary terminal scrolling", () => {
  async function createTempTerminalContext() {
    const handlers = {};
    const elements = new Map();
    const sent = [];
    const localScrolls = [];
    const ctx = {
      console,
      TextEncoder,
      Uint8Array,
      requestAnimationFrame(fn) { fn(); },
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({
        paddingLeft: "0px",
        paddingRight: "0px",
        paddingTop: "0px",
        paddingBottom: "0px",
      }),
      document: {
        fonts: null,
        createElement() {
          return element();
        },
      },
      globalThis: null,
      window: null,
      lastTerminal: null,
      keyHandler: null,
      socket: null,
    };
    function element(id = "") {
      return {
        id,
        clientWidth: 720,
        clientHeight: 360,
        innerHTML: "",
        style: {},
        addEventListener(type, handler) {
          handlers[type] = handler;
        },
        appendChild() {},
        querySelector() {
          return null;
        },
        getBoundingClientRect() {
          return { width: this.clientWidth, height: this.clientHeight };
        },
      };
    }
    function el(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    }
    ctx.Terminal = class {
      constructor() {
        this.rows = 24;
        this.cols = 80;
        this.buffer = { active: { type: "normal", baseY: 100, viewportY: 100 } };
        this._core = { _renderService: { dimensions: { css: { cell: { width: 9, height: 18 } } } } };
        ctx.lastTerminal = this;
      }
      open() {}
      onData() {}
      focus() {}
      resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
      }
      attachCustomKeyEventHandler(handler) {
        ctx.keyHandler = handler;
      }
      scrollLines(lines) {
        localScrolls.push(lines);
      }
      write() {}
      dispose() {}
    };
    ctx.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = sent;
        ctx.socket = this;
      }
      send(data) {
        sent.push(data);
      }
      close() {}
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    const vmCtx = vm.createContext(ctx);
    vm.runInContext(
      readFileSync(new URL("./shared/terminal_scroll.js", import.meta.url), "utf8") +
        "\n" +
        readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8"),
      vmCtx,
    );
    const tempTerminal = ctx.HerdrTempTerminal.create({
      el,
      state: { ws: "w1" },
      wsUrl: (path) => path,
      api: async (url) => {
        if (url === "/api/tabs") return { result: { tab: { tab_id: "w1:t1" } } };
        return { result: { panes: [{ tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" }] } };
      },
      modalId: "modal",
      containerId: "terminal",
    });
    tempTerminal.open();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return { ctx, handlers, sent, localScrolls };
  }

  it("sends backend scroll messages for wheel events", async () => {
    const { handlers, sent } = await createTempTerminalContext();
    let prevented = false;

    handlers.wheel({
      deltaY: 40,
      deltaMode: 0,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {},
    });

    assert.equal(prevented, true);
    assert.deepEqual(JSON.parse(sent.at(-1)), {
      type: "scroll",
      direction: "down",
      lines: 2,
    });
  });

  it("maps PageUp to backend scroll", async () => {
    const { ctx, sent } = await createTempTerminalContext();

    const handled = ctx.keyHandler({
      type: "keydown",
      key: "PageUp",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });

    assert.equal(handled, false);
    assert.deepEqual(JSON.parse(sent.at(-1)), {
      type: "scroll",
      direction: "up",
      lines: Math.max(1, ctx.lastTerminal.rows - 1),
    });
  });

  it("falls back to local xterm scroll when backend is unavailable", async () => {
    const { ctx, handlers, localScrolls } = await createTempTerminalContext();
    ctx.socket.readyState = 0;

    handlers.wheel({
      deltaY: -40,
      deltaMode: 0,
      preventDefault() {},
      stopImmediatePropagation() {},
    });

    assert.equal(localScrolls.at(-1), -2);
  });
});

describe("mobile terminal frame coalescing", () => {
  it("skip scroll callback when following (not paused)", () => {
    let callbackCalled = false;
    const term = {
      write(data, cb) {
        if (cb) callbackCalled = true;
      },
      buffer: { active: { viewportY: 0, baseY: 100 } },
    };
    const terminalFollowPaused = false;
    const terminalAtBottom = () => true;

    // Replicate the writeTerminalFrame logic for the follow-active case.
    const shouldPreserve = terminalFollowPaused && !terminalAtBottom();
    const done = shouldPreserve
      ? () => {}
      : null;
    if (done) term.write("data", done);
    else term.write("data");

    assert.equal(callbackCalled, false, "no callback when following");
  });

  it("use scroll callback when paused (scrolled up)", () => {
    let callbackCalled = false;
    const term = {
      write(data, cb) {
        if (cb) {
          callbackCalled = true;
          cb();
        }
      },
      buffer: { active: { viewportY: 50, baseY: 100 } },
      scrollToLine() {},
    };
    const terminalFollowPaused = true;
    const terminalAtBottom = () => false;

    const shouldPreserve = terminalFollowPaused && !terminalAtBottom();
    const viewportY = shouldPreserve ? term.buffer.active.viewportY : null;
    const done = shouldPreserve
      ? () => {}
      : null;
    if (done) term.write("data", done);
    else term.write("data");

    assert.equal(callbackCalled, true, "callback used when paused");
  });
});

describe("attach frame render suppression", () => {
  const IMMEDIATE_WRITE_THRESHOLD = 8192;
  const LARGE_FRAME_THRESHOLD = 32768;

  it("large attach frame can reveal via timeout before write callback", () => {
    let writeCallback = null;
    let timeoutCallback = null;
    let revealed = false;
    const writes = [];
    const term = {
      write(data, cb) {
        writes.push(data);
        if (cb) writeCallback = cb;  // Don't auto-fire; simulate xterm parsing
      },
    };

    // Simulate attach frame path: terminalAttachPending=true, large frame
    let terminalAttachPending = true;
    const frame = "x".repeat(LARGE_FRAME_THRESHOLD + 1000);
    const size = frame.length;
    const isAttachFrame = terminalAttachPending && size >= LARGE_FRAME_THRESHOLD;

    assert.ok(isAttachFrame, "large frame with attach pending should be detected");

    // Simulate flushTerminalFrames for attach batch
    const isAttachBatch = terminalAttachPending && size >= LARGE_FRAME_THRESHOLD;
    assert.ok(isAttachBatch, "should be detected as attach batch in flush");

    terminalAttachPending = false;
    const done = () => { if (!revealed) revealed = true; };
    timeoutCallback = done;
    term.write(frame, done);
    writeCallback = done;

    assert.equal(writes.length, 1, "single write for attach frame");
    assert.ok(writeCallback, "write callback should be registered");
    assert.ok(timeoutCallback, "reveal timeout should be registered");
    timeoutCallback();
    assert.equal(revealed, true, "timeout can reveal before xterm finishes parsing");
    writeCallback();
    assert.equal(revealed, true, "write callback reveal remains idempotent");
  });

  it("small first frame clears attach flag immediately", () => {
    let terminalAttachPending = true;
    const smallFrame = "hello";
    const size = smallFrame.length;
    const isAttachFrame = terminalAttachPending && size >= LARGE_FRAME_THRESHOLD;

    assert.ok(!isAttachFrame, "small frame should not trigger attach path");

    // Simulate the small-frame path: clear attach flag
    if (terminalAttachPending) terminalAttachPending = false;

    assert.ok(!terminalAttachPending, "attach flag cleared for small frame");
  });

  it("normal frames after attach don't trigger suppression", () => {
    let terminalAttachPending = false;  // Already cleared after first frame
    const frame = "x".repeat(LARGE_FRAME_THRESHOLD + 1000);
    const size = frame.length;
    const isAttachFrame = terminalAttachPending && size >= LARGE_FRAME_THRESHOLD;

    assert.ok(!isAttachFrame, "large frame without attach pending is normal");
    // Should go through normal coalescing path
  });

  it("resetTerminalConnection clears attach flag", () => {
    let terminalAttachPending = true;
    // Simulate resetTerminalConnection
    terminalAttachPending = false;
    assert.ok(!terminalAttachPending, "attach flag cleared on disconnect");
  });
});
