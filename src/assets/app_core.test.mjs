import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeThemeColors,
  resolveTerminalFontFamily,
  textValue,
  resolveWorktreeSource,
  checkedOutWorktreeForBranch,
  validateWorktreeCreate,
  buildWorktreeCreateBody,
  createFaviconNotifier,
  tabActivityLabel,
  terminalPasteInput,
} = require("./shared/core.js");

describe("createFaviconNotifier", () => {
  it("creates one icon link and only updates on state changes", () => {
    const links = [];
    const doc = {
      head: { appendChild: (link) => links.push(link) },
      querySelector: () => links[0] || null,
      createElement: () => ({ rel: "", type: "", href: "" }),
    };
    const notifier = createFaviconNotifier(doc);

    notifier.set("normal");
    const firstHref = links[0].href;
    notifier.set("normal");
    notifier.set("attention");

    assert.equal(links.length, 1);
    assert.equal(links[0].rel, "icon");
    assert.notEqual(links[0].href, firstHref);
    assert.equal(notifier.get(), "attention");
  });
});

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

describe("resolveTerminalFontFamily", () => {
  it("returns the default stack for blank values", () => {
    assert.equal(resolveTerminalFontFamily(""), resolveTerminalFontFamily());
    assert.equal(resolveTerminalFontFamily("   "), resolveTerminalFontFamily());
    assert.equal(resolveTerminalFontFamily(null), resolveTerminalFontFamily());
    assert.equal(resolveTerminalFontFamily(undefined), resolveTerminalFontFamily());
  });

  it("includes Nerd Font fallbacks in the default stack", () => {
    const fallback = resolveTerminalFontFamily("");
    assert.match(fallback, /Herdr JetBrainsMono Nerd Font Mono/);
    assert.match(fallback, /Symbols Nerd Font Mono/);
    assert.match(fallback, /JetBrainsMono Nerd Font Mono/);
    assert.match(fallback, /monospace/);
  });

  it("trims and preserves a user-provided font-family list", () => {
    assert.equal(
      resolveTerminalFontFamily("  'Iosevka Nerd Font', monospace  "),
      "'Iosevka Nerd Font', monospace",
    );
  });
});

describe("textValue", () => {
  it("extracts strings from primitive and object shapes", () => {
    assert.equal(textValue("alpha"), "alpha");
    assert.equal(textValue(42), "42");
    assert.equal(textValue(null), "");
    assert.equal(textValue(undefined), "");
    assert.equal(textValue({ path: "/repo" }), "/repo");
    assert.equal(textValue({ label: "main" }), "main");
  });
});

describe("resolveWorktreeSource", () => {
  it("keeps workspace anchor when path unchanged", () => {
    assert.deepEqual(
      resolveWorktreeSource({
        workspaceId: "ws1",
        sourcePath: "/repo/alpha",
        originalSource: "/repo/alpha",
      }),
      { workspace_id: "ws1", cwd: null },
    );
  });

  it("sends cwd when explicit workspace path edited", () => {
    assert.deepEqual(
      resolveWorktreeSource({
        workspaceId: "ws1",
        sourcePath: "/repo/other",
        originalSource: "/repo/alpha",
      }),
      { workspace_id: null, cwd: "/repo/other" },
    );
  });

  it("is path-first exclusive without workspace anchor", () => {
    assert.deepEqual(
      resolveWorktreeSource({
        sourcePath: "/repo/free",
        discoveredSource: { cwd: "/repo/free" },
      }),
      { workspace_id: null, cwd: "/repo/free" },
    );
  });

  it("uses fallback workspace when source path is blank", () => {
    assert.deepEqual(
      resolveWorktreeSource({
        sourcePath: "",
        discoveredSource: {},
        fallbackWorkspaceId: "ws-default",
      }),
      { workspace_id: "ws-default", cwd: null },
    );
  });
});

describe("checkedOutWorktreeForBranch", () => {
  const rows = [
    { branch: "main", path: "/repo/main", is_prunable: false },
    { branch: "dev", path: "/repo/dev", is_prunable: true },
  ];

  it("finds a checked-out branch across multiple lists", () => {
    assert.equal(
      checkedOutWorktreeForBranch("main", [rows])?.path,
      "/repo/main",
    );
  });

  it("skips prunable worktrees", () => {
    assert.equal(checkedOutWorktreeForBranch("dev", [rows]), null);
  });

  it("returns null for blank branch", () => {
    assert.equal(checkedOutWorktreeForBranch("", [rows]), null);
  });
});

describe("validateWorktreeCreate", () => {
  const lists = [[{ branch: "exists", path: "/repo/exists", is_prunable: false }]];

  it("requires a branch when generateWorktreeNames is false", () => {
    assert.match(
      validateWorktreeCreate({ branch: "", generateWorktreeNames: false }),
      /Branch name is required/,
    );
  });

  it("allows blank branch when generateWorktreeNames is true", () => {
    assert.equal(
      validateWorktreeCreate({
        branch: "",
        generateWorktreeNames: true,
        worktreeLists: lists,
      }),
      "",
    );
  });

  it("blocks an already checked-out branch", () => {
    assert.match(
      validateWorktreeCreate({
        branch: "exists",
        generateWorktreeNames: true,
        worktreeLists: lists,
      }),
      /already checked out/,
    );
  });
});

describe("buildWorktreeCreateBody", () => {
  it("builds the API body from resolved source and form fields", () => {
    assert.deepEqual(
      buildWorktreeCreateBody({
        source: { workspace_id: "ws1", cwd: null },
        branch: "feature/x",
        base: "main",
        label: "my-label",
        path: "/repo/worktrees/x",
        pullBase: true,
      }),
      {
        workspace_id: "ws1",
        cwd: null,
        branch: "feature/x",
        base: "main",
        label: "my-label",
        path: "/repo/worktrees/x",
        pull_base: true,
      },
    );
  });

  it("uses cwd instead of workspace_id when source path is edited", () => {
    assert.deepEqual(
      resolveWorktreeSource({
        workspaceId: "ws1",
        sourcePath: "/repo",
        originalSource: "",
      }),
      { workspace_id: null, cwd: "/repo" },
    );
  });

  it("nullifies blank fields", () => {
    assert.deepEqual(
      buildWorktreeCreateBody({
        source: { workspace_id: null, cwd: "/repo" },
        branch: "",
        base: "",
        label: "",
        path: "",
      }),
      {
        workspace_id: null,
        cwd: "/repo",
        branch: null,
        base: null,
        label: null,
        path: null,
        pull_base: false,
      },
    );
  });
});
