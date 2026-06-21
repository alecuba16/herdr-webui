import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeThemeColors,
  terminalPasteInput,
} = require("./app_core.js");

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
  it("keeps pasted newlines as non-submitting line feeds", () => {
    assert.equal(terminalPasteInput("a\nb\r\nc\rd", false), "a\nb\nc\nd");
  });

  it("wraps bracketed paste when enabled", () => {
    assert.equal(
      terminalPasteInput("hello\n", true),
      "\x1b[200~hello\n\x1b[201~",
    );
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
