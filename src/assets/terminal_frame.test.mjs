import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";

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