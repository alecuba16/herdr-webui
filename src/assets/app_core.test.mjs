import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeThemeColors,
  tabActivityLabel,
  terminalPasteInput,
  terminalWheelScrollBatch,
} = require("./shared/core.js");

describe("branchPathSlug", () => {
  it("lowercases and collapses separators", () => {
    assert.equal(
      branchPathSlug("PAIINF-228-gpu-slicing2"),
      "paiinf-228-gpu-slicing2",
    );
    assert.equal(branchPathSlug("feature/foo_bar baz"), "feature-foo-bar-baz");
  });

  it("uses fallback for empty slugs", () => {
    assert.equal(branchPathSlug("---"), "worktree");
    assert.equal(branchPathSlug(""), "worktree");
  });
});

describe("normalizeAbsolutePath", () => {
  it("normalizes dot segments in absolute paths", () => {
    assert.equal(
      normalizeAbsolutePath("/repo/../worktrees/app"),
      "/worktrees/app",
    );
    assert.equal(
      normalizeAbsolutePath("/repo/./app//branch"),
      "/repo/app/branch",
    );
  });

  it("leaves relative and home paths unchanged", () => {
    assert.equal(normalizeAbsolutePath("../worktrees"), "../worktrees");
    assert.equal(normalizeAbsolutePath("~/worktrees"), "~/worktrees");
  });
});

describe("terminalPasteInput", () => {
  it("converts pasted newlines to non-submitting spaces", () => {
    assert.equal(terminalPasteInput("a\nb\r\nc\rd", false), "a b c d");
  });

  it("drops trailing pasted newlines", () => {
    assert.equal(terminalPasteInput("run command\n", false), "run command");
  });

  it("wraps bracketed paste when enabled", () => {
    assert.equal(
      terminalPasteInput("hello\n", true),
      "\x1b[200~hello\x1b[201~",
    );
  });
});

describe("tabActivityLabel", () => {
  const now = 1_000_000_000;

  it("formats update ages without sub-minute churn", () => {
    assert.equal(tabActivityLabel(now - 30_000, now), "<1m");
    assert.equal(tabActivityLabel(now - 5 * 60_000, now), "5m ago");
    assert.equal(tabActivityLabel(now - 61 * 60_000, now), ">1h");
    assert.equal(tabActivityLabel(now - 25 * 60 * 60_000, now), ">1d");
  });
});

describe("terminalWheelScrollBatch", () => {
  it("accumulates small pixel deltas before scrolling", () => {
    const first = terminalWheelScrollBatch(0, 10, 0, 3, 30);
    assert.equal(first.lines, 0);
    assert.equal(first.direction, null);

    const second = terminalWheelScrollBatch(first.remainder, 30, 0, 3, 30);
    assert.equal(second.lines, 1);
    assert.equal(second.direction, "down");
  });

  it("uses the configured line speed per wheel step", () => {
    assert.deepEqual(terminalWheelScrollBatch(0, 100, 0, 1, 30), {
      direction: "down",
      lines: 1,
      remainder: 0,
    });
    assert.deepEqual(terminalWheelScrollBatch(0, -100, 0, 5, 30), {
      direction: "up",
      lines: 5,
      remainder: 0,
    });
  });

  it("normalizes line-mode mouse wheel deltas", () => {
    assert.deepEqual(terminalWheelScrollBatch(0, 3, 1, 4, 30), {
      direction: "down",
      lines: 4,
      remainder: 0,
    });
  });
});

describe("normalizeThemeColors", () => {
  const defaults = {
    dark: { background: "#111111", foreground: "#eeeeee" },
    light: { background: "#ffffff", foreground: "#111111" },
  };

  it("keeps valid lowercase custom colors", () => {
    assert.deepEqual(
      normalizeThemeColors(
        { dark: { background: "#ABCDEF" }, light: { foreground: "#222222" } },
        defaults,
      ),
      {
        dark: { background: "#abcdef", foreground: "#eeeeee" },
        light: { background: "#ffffff", foreground: "#222222" },
      },
    );
  });

  it("falls back when values are invalid", () => {
    assert.deepEqual(
      normalizeThemeColors({ dark: { background: "red" } }, defaults),
      defaults,
    );
  });
});
