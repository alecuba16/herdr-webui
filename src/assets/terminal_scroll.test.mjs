import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const terminalScroll = require("./shared/terminal_scroll.js");

function term({ normal = true, rowHeight = 20 } = {}) {
  return {
    scrollCalls: [],
    usesNormalBuffer() {
      return normal;
    },
    rowHeight() {
      return rowHeight;
    },
    scrollLines(lines) {
      this.scrollCalls.push(lines);
    },
  };
}

describe("terminal scroll compatibility shim", () => {
  it("maps pixel, line, and page wheel units to terminal rows", () => {
    const fakeTerm = term();

    assert.equal(
      terminalScroll.wheelLines(fakeTerm, { deltaY: 40, deltaMode: 0 }, 24),
      2,
    );
    assert.equal(
      terminalScroll.wheelLines(fakeTerm, { deltaY: 3, deltaMode: 1 }, 24),
      3,
    );
    assert.equal(
      terminalScroll.wheelLines(fakeTerm, { deltaY: -1, deltaMode: 2 }, 24),
      24,
    );
  });

  it("preserves old scrollLocal contract for cached app boot scripts", () => {
    const fakeTerm = term();
    let afterScroll = 0;

    assert.equal(
      terminalScroll.scrollLocal(fakeTerm, "up", 3, () => { afterScroll += 1; }),
      true,
    );
    assert.deepEqual(fakeTerm.scrollCalls, [-3]);
    assert.equal(afterScroll, 1);
  });

  it("returns false when old cached scripts call scrollLocal without renderer support", () => {
    assert.equal(terminalScroll.scrollLocal({}, "down", 2), false);
  });
});
