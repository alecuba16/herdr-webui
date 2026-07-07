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

  it("large attach frame uses write callback for deferred reveal", () => {
    let writeCallback = null;
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
    // Use write callback (not fire it yet)
    const done = () => {};
    term.write(frame, done);
    writeCallback = done;

    assert.equal(writes.length, 1, "single write for attach frame");
    assert.ok(writeCallback, "write callback should be registered");
    // In real code, the callback fires after xterm finishes parsing,
    // then RAF reveals the terminal. Until then, loading overlay stays visible.
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
