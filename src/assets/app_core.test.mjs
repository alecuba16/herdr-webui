import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeOrder,
  normalizeThemeColors,
  resolveTerminalFontFamily,
  textValue,
  resolveWorktreeSource,
  checkedOutWorktreeForBranch,
  formatWorktreeActivityDate,
  worktreeActivityLabel,
  sortWorktreesByRecent,
  validateWorktreeCreate,
  buildWorktreeCreateBody,
  createFaviconNotifier,
  terminalPasteInput,
  stripTerminalMouseReports,
  stripTerminalQueryReplies,
  inputAttrs,
} = require("./shared/core.js");

describe("inputAttrs (shared helper)", () => {
  it("emits the full keyboard guard set; adding/removing an attr fails here", () => {
    // Deliberate pin: behavioral tests cover rendered markup incidentally,
    // this pins the helper itself so a trimmed attr cannot land silently.
    // Static scan checks call-site interpolation, not emitted content.
    assert.match(inputAttrs(), /autocomplete="off"/);
    assert.match(inputAttrs(), /autocorrect="off"/);
    assert.match(inputAttrs(), /autocapitalize="none"/);
    assert.match(inputAttrs(), /spellcheck="false"/);
    assert.match(inputAttrs(), /writingsuggestions="false"/);
    assert.match(inputAttrs(), /translate="no"/);
    assert.ok(!inputAttrs().includes("enterkeyhint"), "no hint without argument");
    assert.match(inputAttrs("search"), /enterkeyhint="search"/);
    assert.ok(inputAttrs("search").includes(inputAttrs()));
    assert.ok(!inputAttrs('"><img onerror=alert(1)>').includes('enterkeyhint="\"><img'), "hint must be escaped");
  });
});

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

describe("hashId", () => {
  it("hashes short stable base36 ids (shared editor-mount key helper)", () => {
    const { hashId } = require("./shared/core.js");
    assert.equal(typeof hashId("src/app.rs"), "string");
    assert.equal(hashId("src/app.rs"), hashId("src/app.rs"));
    assert.notEqual(hashId("src/app.rs"), hashId("src/app2.rs"));
    assert.equal(hashId(""), "0");
    assert.equal(hashId(null), "0");
    assert.match(hashId("x".repeat(500)), /^[0-9a-z]+$/);
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

describe("normalizeOrder", () => {
  it("deduplicates, filters, and appends missing allowed values", () => {
    assert.deepEqual(
      normalizeOrder("files,unknown,files,workspaces", [
        "workspaces",
        "files",
        "content",
      ]),
      ["files", "workspaces", "content"],
    );
  });

  it("accepts array input while preserving allowed order", () => {
    assert.deepEqual(
      normalizeOrder(["CONTENT", "files"], ["workspaces", "files", "content"]),
      ["content", "files", "workspaces"],
    );
  });
});

describe("terminalPasteInput", () => {
  it("preserves pasted newlines while normalizing CRLF and CR", () => {
    assert.equal(terminalPasteInput("a\nb\r\nc\rd", false), "a\nb\nc\nd");
  });

  it("preserves trailing pasted newlines", () => {
    assert.equal(terminalPasteInput("run command\n", false), "run command\n");
  });

  it("wraps bracketed paste when enabled", () => {
    assert.equal(
      terminalPasteInput("hello\n", true),
      "\x1b[200~hello\n\x1b[201~",
    );
  });
});

describe("stripTerminalMouseReports", () => {
  it("removes SGR hover reports that shell prompts echo as text", () => {
    assert.equal(
      stripTerminalMouseReports("\x1b[<35;105;1M\x1b[<35;110;2Mcmd"),
      "cmd",
    );
  });

  it("removes SGR click, drag, release, and wheel reports", () => {
    const input = "a\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<64;11;5Mb";
    assert.equal(stripTerminalMouseReports(input), "ab");
  });

  it("removes legacy X10 mouse reports and preserves keyboard input", () => {
    assert.equal(stripTerminalMouseReports("a\x1b[M !!b"), "ab");
    assert.equal(stripTerminalMouseReports("hello\r"), "hello\r");
  });

  it("preserves mouse reports when explicitly enabled", () => {
    const input = "a\x1b[<35;105;1M\x1b[M !!b";
    assert.equal(stripTerminalMouseReports(input, true), input);
  });
});

describe("stripTerminalQueryReplies", () => {
  it("removes complete OSC color query replies while preserving normal input", () => {
    const input = "a\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x07b";
    assert.equal(stripTerminalQueryReplies(input, {}), "ab");
  });

  it("removes bare repeated color reply fragments like a browser terminal can echo", () => {
    const input = "10;rgb:ffff/ffff/ffff\\11;rgb:0000/0000/0000\\10;rgb:ffff/ffff/ffff";
    assert.equal(stripTerminalQueryReplies(input, {}), "");
  });

  it("carries split replies across input frames", () => {
    const state = {};
    assert.equal(stripTerminalQueryReplies("cmd\n10;rgb:ffff/", state), "cmd\n");
    assert.equal(stripTerminalQueryReplies("ffff/ffff\\next", state), "next");
    assert.equal(state.carry || "", "");
  });

  it("does not hold ordinary numeric input while looking for bare replies", () => {
    const state = {};
    assert.equal(stripTerminalQueryReplies("1", state), "1");
    assert.equal(stripTerminalQueryReplies("0", state), "0");
    assert.equal(stripTerminalQueryReplies("\x1b", state), "\x1b");
    assert.equal(state.carry || "", "");
  });
});

describe("Git log rendering", () => {
  it("keeps full ref labels available in hover markup and renders copy commit id button", () => {
    const context = {
      window: {},
      document: { querySelectorAll() { return []; } },
    };
    context.window.window = context.window;
    // log.js renders filter inputs with inputAttrs(...) from the shared helpers.
    vm.runInNewContext("if (typeof inputAttrs !== 'function') inputAttrs = (hint) => ` autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\" writingsuggestions=\"false\" translate=\"no\" enterkeyhint=\"${hint}\"`", context);
    vm.runInNewContext(readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8"), context);

    const hash = "0123456789abcdef0123456789abcdef01234567";
    const longLabel = "origin/feature/very-long-branch-name-that-should-not-be-ellipsis-in-hover-card";
    const html = context.window.HerdrGitLog.render({
      esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); },
      arg: encodeURIComponent,
      data: { rows: [{ graph: "*", hash, labels: [longLabel], title: "Demo", date: "today", author: "Tester", lane: 0 }] },
      selected: [],
      filters: {},
    });

    assert.match(html, new RegExp(`title="${longLabel}"`));
    assert.match(html, /class="git-ui-log-hover-card"/);
    assert.ok(html.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent(hash)}','Commit%20id')`));
    assert.match(html, /Copy Commit id/);
    assert.ok(html.includes(`<strong>${hash}</strong>`), "hover card still shows the full hash");
  });

  it("hover card renders labeled field rows with one copy command per field and per tag", () => {
    const context = {
      window: {},
      document: { querySelectorAll() { return []; } },
    };
    context.window.window = context.window;
    vm.runInNewContext("if (typeof inputAttrs !== 'function') inputAttrs = (hint) => ` autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\" writingsuggestions=\"false\" translate=\"no\" enterkeyhint=\"${hint}\"`", context);
    vm.runInNewContext(readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8"), context);

    const hash = "1234567890abcdef1234567890abcdef12345678";
    const html = context.window.HerdrGitLog.render({
      esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); },
      arg: encodeURIComponent,
      data: { rows: [{ graph: "*", hash, labels: ["HEAD -> main", "tag: v1.2.3", "tag: release-4", "main"], title: "Tagged demo", date: "2 days ago", exact_date: "2026-10-05T10:00:00Z", author: "Jane Dev <jane@example.com>", lane: 0 }] },
      selected: [],
      filters: {},
    });

    // Labeled rows exist for every field.
    for (const label of ["Commit id", "Tags", "Author", "Date"]) {
      assert.ok(html.includes(`class="git-ui-log-hover-field-label">${label}</span>`), `field row for ${label}`);
    }
    // One copy command per field: commit id, author, date, message.
    assert.ok(html.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent(hash)}','Commit%20id')`));
    assert.ok(html.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent("Jane Dev <jane@example.com>")}','Author')`));
    assert.ok(html.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent("2026-10-05T10:00:00Z")}','Date')`));
    assert.ok(html.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent("Tagged demo")}','Commit%20message')`));
    // Each tag renders as its own chip with its own copy command; the
    // "tag: " prefix is stripped inside the hover card (the row tooltip
    // still spells labels verbatim, by design).
    const cardHtml = html.slice(html.indexOf("git-ui-log-hover-card"));
    assert.ok(cardHtml.includes(`class="git-ui-log-hover-tag">v1.2.3`), "tag chip v1.2.3");
    assert.ok(cardHtml.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent("v1.2.3")}','Tag%20v1.2.3')`), "copy for tag v1.2.3");
    assert.ok(cardHtml.includes(`HerdrGitUi.copyScopeValue(event,'${encodeURIComponent("release-4")}','Tag%20release-4')`), "copy for tag release-4");
    assert.ok(!cardHtml.includes("tag: v1.2.3"), "tag prefix stripped from display");
    // Branch/HEAD labels stay in the chip row, not in the Tags field.
    assert.ok(cardHtml.includes("git-ui-log-hover-labels"));
  });

  it("hover card shows None for a tagless commit and hides copy buttons for empty fields", () => {
    const context = {
      window: {},
      document: { querySelectorAll() { return []; } },
    };
    context.window.window = context.window;
    vm.runInNewContext("if (typeof inputAttrs !== 'function') inputAttrs = (hint) => ` autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\" writingsuggestions=\"false\" translate=\"no\" enterkeyhint=\"${hint}\"`", context);
    vm.runInNewContext(readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8"), context);

    const html = context.window.HerdrGitLog.render({
      esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); },
      arg: encodeURIComponent,
      data: { rows: [{ graph: "*", hash: "abcdefabcdef", labels: ["main"], title: "No tags here", date: "", author: "", lane: 0 }] },
      selected: [],
      filters: {},
    });

    assert.ok(html.includes("class=\"git-ui-log-hover-empty\">None</span>"), "Tags shows None");
    assert.ok(html.includes("Unknown"), "empty author/date show Unknown");
    assert.ok(!html.includes("'Author')"), "no Author copy button when the author is empty");
    assert.ok(!html.includes("'Date')"), "no Date copy button when the date is empty");
    assert.ok(html.includes("HerdrGitUi.copyScopeValue(event,'abcdefabcdef','Commit%20id')"), "hash copy always present");
  });

  it("copy commands survive tags and authors containing apostrophes or quotes", () => {
    const context = {
      window: {},
      document: { querySelectorAll() { return []; } },
    };
    context.window.window = context.window;
    vm.runInNewContext("if (typeof inputAttrs !== 'function') inputAttrs = (hint) => ` autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\" writingsuggestions=\"false\" translate=\"no\" enterkeyhint=\"${hint}\"`", context);
    vm.runInNewContext(readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8"), context);

    // Git refnames allow ' and "; commit authors are free text. Both land
    // in onclick JS strings and title attributes, so the rendered markup
    // must not break the JS string or the attribute.
    const html = context.window.HerdrGitLog.render({
      esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },
      arg: encodeURIComponent,
      data: { rows: [{ graph: "*", hash: "feedfacefeedface", labels: ["tag: don't", "tag: say\"hi", "main"], title: "Apostrophes", date: "now", author: "O'Brien <o'b@example.com>", lane: 0 }] },
      selected: [],
      filters: {},
    });

    const cardHtml = html.slice(html.indexOf("git-ui-log-hover-card"));
    // Apostrophes are percent-encoded in the onclick args: the JS string
    // stays intact and decodes back to the original tag/author. Plain
    // encodeURIComponent leaves ' unescaped, hence the explicit %27 pins.
    const jsArg = (value) => encodeURIComponent(value).replace(/'/g, "%27");
    assert.ok(cardHtml.includes("'Tag%20don%27t')"), "tag with apostrophe encodes %27 in the kind");
    assert.ok(cardHtml.includes(`'${jsArg("don't")}','Tag%20don%27t')`), "tag with apostrophe encodes %27 in the value");
    assert.ok(cardHtml.includes(`'${jsArg("O'Brien <o'b@example.com>")}','Author')`), "author with apostrophes encodes %27");
    // No raw apostrophe may remain inside an onclick attribute: every
    // remaining ' in onclick would close the JS string early.
    for (const onclick of cardHtml.match(/onclick="[^"]*"/g) || []) {
      assert.ok(!/onclick="[^"]*'"/.test(onclick), `raw apostrophe inside onclick: ${onclick}`);
    }
    // Quotes in a tag escape the title attribute so it cannot break out.
    assert.ok(cardHtml.includes('title="Copy Tag say&quot;hi"'), "quote in tag is escaped in the title");
    assert.ok(!cardHtml.includes('title="Copy Tag say"hi"'), "no unescaped quote in title attribute");
  });

  it("uses the backend-provided lane instead of recomputing it from the graph (C6)", () => {
    const context = {
      window: {},
      document: { querySelectorAll() { return []; } },
    };
    context.window.window = context.window;
    // log.js renders filter inputs with inputAttrs(...) from the shared helpers.
    vm.runInNewContext("if (typeof inputAttrs !== 'function') inputAttrs = (hint) => ` autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\" writingsuggestions=\"false\" translate=\"no\" enterkeyhint=\"${hint}\"`", context);
    vm.runInNewContext(readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8"), context);
    const laneColor = context.window.HerdrGitLog.laneColor;

    const render = (lane) => context.window.HerdrGitLog.render({
      esc(value) { return String(value); },
      arg: encodeURIComponent,
      data: { rows: [{ graph: "* |", hash: "h1", labels: [], title: "Demo", date: "", author: "", lane }] },
      selected: [],
      filters: {},
    });

    // lane=2 (backend-computed) must win: the graph string alone would put
    // this commit on lane 0. Assert on the row's own --lane style so the
    // commit-dot accent (always var(--accent)) does not mask the check.
    const html = render(2);
    const laneMatch = html.match(/git-ui-log-row[^>]*style="--lane:([^;"]+)/);
    assert.ok(laneMatch, "row carries a --lane style");
    assert.equal(laneMatch[1], laneColor(2), "row --lane matches the payload lane color");
    assert.notEqual(laneMatch[1], laneColor(0), "row does not fall back to the graph-parsed lane 0");

    // Legacy rows without lane still fall back to graph parsing.
    const legacy = render(undefined);
    assert.ok(legacy.includes(laneColor(0)), "legacy row without lane falls back to graph lane 0");
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

describe("worktree recent activity helpers", () => {
  it("sorts worktrees by newest commit date and formats the visible label", () => {
    const rows = [
      { label: "old", path: "/repo/old", last_commit_at: "2024-01-01T10:00:00Z" },
      { label: "new", path: "/repo/new", latest_commit_timestamp: 1_800_000_000 },
      { label: "unknown", path: "/repo/unknown" },
    ];

    assert.deepEqual(sortWorktreesByRecent(rows).map((row) => row.label), ["new", "old", "unknown"]);
    assert.match(worktreeActivityLabel(rows[0]), /^Latest commit \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(worktreeActivityLabel({ last_commit_display: "2025-01-01 09:30" }), "Latest commit 2025-01-01 09:30");
    assert.equal(formatWorktreeActivityDate({}), "");
    assert.equal(worktreeActivityLabel({}), "Latest commit unknown");
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

describe("HerdrFileTree search helpers", () => {
  function loadTree() {
    const context = { window: {} };
    const iconSource = readFileSync(new URL("./shared/file_icons.js", import.meta.url), "utf8");
    const treeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");
    vm.runInNewContext(iconSource, context);
    vm.runInNewContext(treeSource, context);
    return context.window.HerdrFileTree;
  }

  it("filters folder search to actual partial matches while preserving parent breadcrumbs", () => {
    const tree = loadTree();
    const rows = tree.searchTreeEntriesByKind([
      { kind: "dir", name: "alphaFolder", path: "alphaFolder" },
      { kind: "dir", name: "nested", path: "alphaFolder/nested" },
      { kind: "dir", name: "partialMatchDir", path: "beta/partialMatchDir" },
    ], "dir", "partial");

    assert.deepEqual(Array.from(rows, (entry) => entry.path), ["beta", "beta/partialMatchDir"]);
    assert.equal(rows[1].name, "partialMatchDir");
  });

  it("preserves parent breadcrumbs for filtered file results", () => {
    const tree = loadTree();
    const rows = tree.searchTreeEntriesByKind([
      { kind: "file", name: "app.rs", path: "src/app.rs" },
      { kind: "file", name: "app_test.rs", path: "src/nested/app_test.rs" },
    ], "file", "app");

    assert.deepEqual(Array.from(rows, (entry) => [entry.kind, entry.path]), [
      ["dir", "src"],
      ["file", "src/app.rs"],
      ["dir", "src/nested"],
      ["file", "src/nested/app_test.rs"],
    ]);
  });

  it("uses backend-provided git status for directories", () => {
    const tree = loadTree();
    const rows = tree.applyGitStatus([
      { kind: "dir", name: "src", path: "src" },
      { kind: "file", name: "app.rs", path: "src/app.rs" },
    ], { src: "deleted", "src/app.rs": "modified" });

    assert.equal(rows[0].status, "deleted");
    assert.equal(rows[1].status, "modified");
  });

  it("renders branch-changed files with the blue git-changed row class", () => {
    const tree = loadTree();
    // Backend "changed" merge: branch-only committed file, parent dir, and
    // a working-tree modified file that must keep its stronger status.
    const rows = tree.applyGitStatus([
      { kind: "dir", name: "src", path: "src", expanded: false },
      { kind: "file", name: "branch.rs", path: "src/branch.rs" },
      { kind: "file", name: "dirty.rs", path: "src/dirty.rs" },
      { kind: "file", name: "plain.rs", path: "plain.rs" },
    ], {
      src: "changed",
      "src/branch.rs": "changed",
      "src/dirty.rs": "modified",
    });
    const html = tree.renderEntries(rows, { callback: "Tree" });

    const branchRow = html.match(/class="herdr-tree-row[^"]*"[^>]*title="src\/branch\.rs"/);
    assert.ok(branchRow, "branch.rs row must render");
    assert.match(branchRow[0], /git-changed/, "branch-only committed file must get the blue class");
    const dirtyRow = html.match(/class="herdr-tree-row[^"]*"[^>]*title="src\/dirty\.rs"/);
    assert.ok(dirtyRow, "dirty.rs row must render");
    assert.doesNotMatch(dirtyRow[0], /git-changed/, "working-tree modified must not be downgraded to blue");
    const plainRow = html.match(/class="herdr-tree-row[^"]*"[^>]*title="plain\.rs"/);
    assert.ok(plainRow, "plain.rs row must render");
    assert.doesNotMatch(plainRow[0], /git-/, "untouched file must stay uncolored");
  });

  it("renders folder and file type icons from names and extensions", () => {
    const tree = loadTree();
    const html = tree.renderEntries([
      { kind: "dir", name: "src", path: "src", expanded: false },
      { kind: "file", name: "app.tsx", path: "src/app.tsx" },
      { kind: "file", name: "Cargo.toml", path: "Cargo.toml" },
      { kind: "file", name: "unknown", path: "unknown" },
    ], { callback: "Tree" });

    assert.doesNotMatch(html, /herdr-tree-icon-folder-src/);
    assert.match(html, /herdr-tree-icon-filetype-react" data-glyph="TSX"/);
    assert.match(html, /herdr-tree-icon-filetype-rust" data-glyph="RS"/);
    assert.match(html, /herdr-tree-icon-file"/);
  });
});

describe("HerdrEditor line number helpers", () => {
  async function createFallbackEditor(options) {
    const parent = { innerHTML: "", querySelector() { return null; } };
    const context = { window: {}, document: { createElement() { return {}; }, body: { appendChild(script) { script.onerror(); } } }, Promise };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);
    context.window.HerdrEditor.create(Object.assign({ parent, path: "demo.txt", content: "a\nb", readonly: true }, options || {}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return parent.innerHTML;
  }

  it("shows line numbers by default in fallback previews after CodeMirror load failure", async () => {
    const html = await createFallbackEditor();
    assert.match(html, /herdr-editor-numbered-code/);
    assert.match(html, />1<\/span><span>2<\/span>/);
    assert.match(html, /class="herdr-editor-find"[^>]*hidden/);
    assert.match(html, /herdr-editor-find-toggle/);
    assert.match(html, /herdr-editor-replace-query[^>]*disabled/);
  });

  it("can hide line numbers in fallback previews after CodeMirror load failure", async () => {
    const html = await createFallbackEditor({ lineNumbers: false });
    assert.doesNotMatch(html, /herdr-editor-numbered-code/);
  });

  it("prefers backend-prebuilt numbered preview HTML and gates client-built previews at 256 KB (C5)", async () => {
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    const boot = () => {
      const parent = { innerHTML: "", querySelector() { return null; } };
      const context = { window: {}, document: { createElement() { return {}; }, body: { appendChild(script) { script.onerror(); } } }, Promise };
      vm.runInNewContext(source, context);
      return { parent, create: (opts) => context.window.HerdrEditor.create(Object.assign({ parent, path: "big.log", content: "a\nb", readonly: true }, opts)) };
    };

    // Prebuilt backend HTML is injected verbatim (already escaped in Rust).
    let env = boot();
    env.create({ linesHtml: { gutter: "<span>1</span><span>2</span>", code: "a&lt;b\nb" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(env.parent.innerHTML, /herdr-editor-numbered-code/);
    assert.match(env.parent.innerHTML, /<span>1<\/span><span>2<\/span>/);
    assert.match(env.parent.innerHTML, /a&lt;b/);

    // Files larger than the gate without prebuilt HTML render a size hint
    // instead of building per-line HTML on the main thread.
    env = boot();
    env.create({ size: 512 * 1024, content: "x".repeat(512 * 1024) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(env.parent.innerHTML, /File too large for the fallback preview \(512\.0 KB\)/);
    assert.doesNotMatch(env.parent.innerHTML, /herdr-editor-numbered-code/);

    // Small files still build the numbered preview client-side.
    env = boot();
    env.create({ size: 2048, content: "a\nb" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(env.parent.innerHTML, /herdr-editor-numbered-code/);
    assert.match(env.parent.innerHTML, /<span>1<\/span><span>2<\/span>/);

    // Gated preview keeps a working editor api (find toolbar wiring intact).
    env = boot();
    const api = env.create({ size: 512 * 1024, content: "x".repeat(512 * 1024) });
    assert.equal(typeof api.getValue, "function");
    assert.equal(api.getValue().length, 512 * 1024);
  });

  it("wires a working editor api in the CodeMirror-load-failure fallback", async () => {
    const textarea = { value: "a\nb", addEventListener() {}, focus() {}, setSelectionRange() {} };
    const toolbar = { hidden: true, querySelector() { return null; } };
    const parent = {
      innerHTML: "",
      _herdrEditorApi: null,
      querySelector(selector) {
        if (selector === "textarea") return textarea;
        if (selector === ".herdr-editor-find") return toolbar;
        return null;
      },
    };
    const context = { window: {}, document: { createElement() { return {}; }, body: { appendChild(script) { script.onerror(); } } }, Promise, localStorage: { getItem() { return null; }, setItem() {} } };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    const editor = context.window.HerdrEditor.create({ parent, path: "demo.txt", content: "a\nb", readonly: true });
    assert.equal(parent._herdrEditorApi, editor);
    assert.equal(typeof editor.getValue, "function");
    assert.equal(editor.getValue(), "a\nb");
    // The fallback path previously referenced `api` before definition, so
    // opening the find toolbar after a load failure threw. openFind must
    // work against the fallback api.
    assert.equal(context.window.HerdrEditor.openFind(parent), true);
    assert.equal(toolbar.hidden, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(parent.innerHTML.includes("herdr-editor-numbered-code") || parent.innerHTML.includes("herdr-editor-find"), true);
  });


  it("keeps the returned API stable when CodeMirror loads lazily", async () => {
    const mount = { innerHTML: "" };
    const parent = {
      innerHTML: "",
      _herdrEditorApi: null,
      querySelector(selector) {
        return selector === ".herdr-editor-mount" ? mount : null;
      },
    };
    let editorValue = "a\nb";
    let destroyed = false;
    const view = { state: {} };
    const context = {
      window: {},
      document: {
        createElement() {
          return { async: false, src: "", onload: null, onerror: null };
        },
        body: {
          appendChild(script) {
            context.window.HerdrCodeMirror = {
              create() {
                return {
                  view,
                  getValue() { return editorValue; },
                  setValue(value) { editorValue = String(value); },
                  selectRange() {},
                  replaceRange(from, to, value) {
                    editorValue = editorValue.slice(0, from) + value + editorValue.slice(to);
                  },
                  destroy() { destroyed = true; },
                };
              },
            };
            script.onload();
          },
        },
      },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    const api = context.window.HerdrEditor.create({
      parent,
      path: "demo.txt",
      content: editorValue,
      readonly: false,
      hideFind: true,
    });
    assert.equal(parent._herdrEditorApi, api);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(parent._herdrEditorApi, api);
    assert.equal(api.getValue(), "a\nb");
    assert.equal(api._view, view);
    api.setValue("changed");
    assert.equal(api.getValue(), "changed");
    api.destroy();
    assert.equal(destroyed, true);
    assert.equal(parent._herdrEditorApi, undefined);
  });

  it("reattaches a pending lazy editor before CodeMirror mounts", async () => {
    const makeParent = (mount) => ({
      innerHTML: "",
      _herdrEditorApi: null,
      querySelector(selector) {
        return selector === ".herdr-editor-mount" ? mount : null;
      },
    });
    const firstMount = { innerHTML: "" };
    const nextMount = { innerHTML: "" };
    const parent = makeParent(firstMount);
    const nextParent = makeParent(nextMount);
    let script;
    let readyCalls = 0;
    let editorValue = "a\nb";
    const view = { state: {} };
    const context = {
      window: {},
      document: {
        createElement() {
          return { async: false, src: "", onload: null, onerror: null };
        },
        body: {
          appendChild(child) {
            script = child;
          },
        },
      },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    const api = context.window.HerdrEditor.create({
      parent,
      path: "demo.txt",
      content: editorValue,
      readonly: false,
      onReady() { readyCalls += 1; },
    });
    api.attach(nextParent);
    assert.equal(parent._herdrEditorApi, undefined);
    assert.equal(nextParent._herdrEditorApi, api);

    context.window.HerdrCodeMirror = {
      create() {
        return {
          view,
          getValue() { return editorValue; },
          setValue(value) { editorValue = String(value); },
          destroy() {},
        };
      },
    };
    script.onload();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(nextParent._herdrEditorApi, api);
    assert.equal(readyCalls, 1);
    assert.equal(api._view, view);
    assert.equal(firstMount.innerHTML, "");
    assert.equal(nextMount.innerHTML, "");
  });

  it("renders a floating find toggle on headerless mounts (A1)", async () => {
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    const boot = () => {
      const parent = { innerHTML: "", querySelector() { return null; } };
      const context = { window: {}, document: { createElement() { return {}; }, body: { appendChild(script) { script.onerror(); } } }, Promise, localStorage: { getItem() { return null; }, setItem() {} } };
      vm.runInNewContext(source, context);
      return { parent, create: (opts) => context.window.HerdrEditor.create(Object.assign({ parent, path: "demo.txt", content: "a\nb", readonly: true }, opts)) };
    };

    // Headerless readonly preview: the floating toggle must exist and open the toolbar.
    let env = boot();
    env.create({ hideHeader: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(env.parent.innerHTML, /herdr-editor-find-toggle herdr-editor-find-float/);
    assert.equal((env.parent.innerHTML.match(/herdr-editor-find-toggle/g) || []).length, 1, "no duplicate toggles");

    // Headerless edit mode (mobile editor) also gets one.
    env = boot();
    env.create({ hideHeader: true, readonly: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((env.parent.innerHTML.match(/herdr-editor-find-float/g) || []).length, 1);

    // Headered mounts keep the header toggle only (no float).
    env = boot();
    env.create({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(env.parent.innerHTML, /class="herdr-editor-head"/);
    assert.doesNotMatch(env.parent.innerHTML, /herdr-editor-find-float/);

    // hideFind suppresses every find affordance.
    env = boot();
    env.create({ hideHeader: true, hideFind: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(env.parent.innerHTML, /herdr-editor-find-toggle/);
    assert.doesNotMatch(env.parent.innerHTML, /herdr-editor-find"/);

    // hideFindToggle suppresses only the floating button: the toolbar
    // stays so a strip-level control can still open it (desktop panes).
    env = boot();
    env.create({ hideHeader: true, hideFindToggle: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(env.parent.innerHTML, /herdr-editor-find-float/);
    assert.match(env.parent.innerHTML, /class="herdr-editor-find"/);
  });

  it("memoizes find scans and invalidates on text or query change (D3)", () => {
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    let text = "needle one needle two needle three";
    const toolbarParts = {};
    function makePart() {
      return { value: "", checked: false, hidden: false, textContent: "", handlers: {}, addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }, fire(type, event) { for (const fn of this.handlers[type] || []) fn(Object.assign({ key: "", preventDefault() {}, stopPropagation() {} }, event)); } };
    }
    for (const key of ["query", "status", "matchCase", "regex", "prev", "next", "one", "all", "replacement"]) toolbarParts[key] = makePart();
    const toolbar = {
      hidden: true,
      querySelector(selector) {
        const map = {
          ".herdr-editor-find-query": "query", ".herdr-editor-find-status": "status",
          ".herdr-editor-find-case": "matchCase", ".herdr-editor-find-regex": "regex",
          ".herdr-editor-find-prev": "prev", ".herdr-editor-find-next": "next",
          ".herdr-editor-replace-query": "replacement",
          ".herdr-editor-replace-one": "one", ".herdr-editor-replace-all": "all",
        };
        return toolbarParts[map[selector]] || null;
      },
    };
    const textareaNode = { value: text };
    const parent = {
      querySelector(selector) {
        if (selector === ".herdr-editor-find") return toolbar;
        if (selector === "textarea") return textareaNode;
        return null;
      },
      addEventListener() {},
    };
    const context = {
      window: {},
      document: { createElement() { return {}; }, body: { appendChild(script) { script.onerror(); } } },
      Promise, localStorage: { getItem() { return null; }, setItem() {} },
    };
    vm.runInNewContext(source, context);
    const api = context.window.HerdrEditor.create({ parent, path: "demo.txt", content: text, readonly: true });
    assert.equal(typeof api.getValue, "function");
    const setText = (value) => { textareaNode.value = value; };

    const { query, status, prev, next, matchCase } = toolbarParts;
    query.value = "needle";
    next.fire("click");
    assert.match(status.textContent, /^1\/3$/);
    next.fire("click");
    assert.match(status.textContent, /^2\/3$/);
    prev.fire("click");
    assert.match(status.textContent, /^1\/3$/);

    // New query must invalidate the memo and rescan.
    query.value = "two";
    next.fire("click");
    assert.match(status.textContent, /^1\/1$/);

    // Option change must invalidate too: case-insensitive "Needle" finds 3.
    matchCase.checked = false;
    query.value = "Needle";
    next.fire("click");
    assert.match(status.textContent, /^1\/3$/);
    // Flipping matchCase on must rescan and find nothing.
    matchCase.checked = true;
    next.fire("click");
    assert.match(status.textContent, /No matches/);

    // Text change must invalidate: a changed document rescans.
    setText("needle fresh");
    query.value = "fresh";
    next.fire("click");
    assert.match(status.textContent, /^1\/1$/);

    // Full navigation cycle still lands on correct ranges (memo reuse path).
    setText("a needle b needle c needle");
    query.value = "needle";
    next.fire("click"); next.fire("click");
    assert.match(status.textContent, /^2\/3$/);
    assert.equal(api.getValue().length > 0, true);
  });

  it("supports match-case and regex range detection", () => {
    const context = { window: {}, document: { createElement() { return {}; }, body: { appendChild() {} } }, Promise };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    const helper = context.window.HerdrEditor;
    assert.equal(helper.findRanges("Alpha alpha alpha-42", "alpha", { matchCase: false, regex: false }).ranges.length, 3);
    assert.equal(helper.findRanges("Alpha alpha alpha-42", "alpha", { matchCase: true, regex: false }).ranges.length, 2);
    const regexResult = helper.findRanges("Alpha alpha alpha-42", "alpha-\\d+", { matchCase: true, regex: true });
    assert.equal(regexResult.ranges.length, 1);
    assert.equal(regexResult.ranges[0].to, "Alpha alpha alpha-42".length);
    assert.match(helper.findRanges("text", "[", { matchCase: false, regex: true }).error, /Invalid regex/);
  });

  it("captures Cmd/Ctrl+F inside file editors to show Herdr find", () => {
    const localStorage = new Map();
    const parentKeydowns = [];
    let queryKeydown = null;
    const parentKeydown = (event) => { for (const handler of parentKeydowns.slice().reverse()) handler(event); };
    const query = {
      value: "",
      focused: false,
      selected: false,
      focus() { this.focused = true; },
      select() { this.selected = true; },
      addEventListener(type, handler) { if (type === "keydown") queryKeydown = handler; },
    };
    const toolbar = {
      hidden: true,
      querySelector(selector) {
        if (selector === ".herdr-editor-find-query") return query;
        if (selector === ".herdr-editor-find-status") return { textContent: "" };
        return { checked: false, value: "", addEventListener() {} };
      },
    };
    const mount = { innerHTML: "" };
    const parent = {
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".herdr-editor-mount") return mount;
        if (selector === ".herdr-editor-find") return toolbar;
        return null;
      },
      addEventListener(type, handler) { if (type === "keydown") parentKeydowns.push(handler); },
      removeEventListener() {},
    };
    const context = {
      window: {
        HerdrCodeMirror: {
          create() { return { getValue() { return "abc"; }, setValue() {}, selectRange() {}, destroy() {} }; },
        },
      },
      localStorage: {
        getItem: (key) => localStorage.get(key) || null,
        setItem: (key, value) => localStorage.set(key, String(value)),
      },
      document: { createElement() { return {}; }, body: { appendChild() {} } },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    const editor = context.window.HerdrEditor.create({ parent, path: "demo.js", content: "abc", readonly: true });
    let prevented = false;
    parentKeydown({ key: "f", metaKey: true, ctrlKey: false, altKey: false, preventDefault() { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    assert.equal(toolbar.hidden, false);
    assert.equal(query.focused, true);
    assert.equal(query.selected, true);

    queryKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.equal(toolbar.hidden, true);

    editor.toggleFind(true);
    assert.equal(toolbar.hidden, false);
    editor.toggleFind(true);
    assert.equal(toolbar.hidden, true);
    assert.equal(parent._herdrEditorApi, editor);

    toolbar.hidden = true;
    prevented = false;
    localStorage.set("herdr-web-options", JSON.stringify({ editorFindShortcutEnabled: false }));
    parentKeydown({ key: "f", ctrlKey: true, metaKey: false, altKey: false, preventDefault() { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
    assert.equal(prevented, false);
    assert.equal(toolbar.hidden, true);
    // Ctrl+G still works with the find shortcut disabled (different feature).
    context.prompt = () => null;
    parentKeydown({ key: "g", ctrlKey: true, metaKey: false, altKey: false, preventDefault() { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    prevented = false;
  });

  it("enables replace controls only for editable fallback editors", async () => {
    const html = await createFallbackEditor({ readonly: false });
    assert.match(html, /<textarea/);
    assert.match(html, /class="herdr-editor-find"[^>]*hidden/);
    assert.doesNotMatch(html, /herdr-editor-replace-query[^>]*disabled/);
  });

  it("opens and focuses the hidden find toolbar", () => {
    const context = {
      window: {},
      document: { createElement() { return {}; }, body: { appendChild() {} } },
      Promise,
      setTimeout(fn) { fn(); },
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);
    const query = {
      focused: false,
      selected: false,
      focus() { this.focused = true; },
      select() { this.selected = true; },
    };
    const toolbar = {
      hidden: true,
      querySelector(selector) { return selector === ".herdr-editor-find-query" ? query : null; },
    };
    const parent = {
      querySelector(selector) { return selector === ".herdr-editor-find" ? toolbar : null; },
    };

    assert.equal(context.window.HerdrEditor.openFind(parent), true);
    assert.equal(toolbar.hidden, false);
    assert.equal(query.focused, true);
    assert.equal(query.selected, true);
  });

  it("starts read-only previews with the CodeMirror shell and then mounts CodeMirror", async () => {
    const calls = [];
    const mount = {
      set innerHTML(value) { parent.innerHTML = String(value); },
      get innerHTML() { return parent.innerHTML; },
    };
    const parent = {
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".herdr-editor-mount" && this.innerHTML.includes("herdr-editor-mount")) return mount;
        return null;
      },
    };
    const context = {
      window: {},
      document: {
        createElement() { return {}; },
        body: {
          appendChild(script) {
            context.window.HerdrCodeMirror = {
              create(opts) {
                calls.push(opts);
                opts.parent.innerHTML = `<div class="cm-content cm-lineWrapping" contenteditable="${opts.readonly === false ? "true" : "false"}"></div>`;
                return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
              },
            };
            script.onload();
          },
        },
      },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    context.window.HerdrEditor.create({ parent, path: "demo.js", content: "const x = 1;", readonly: true, hideHeader: true, lineNumbers: true });
    assert.match(parent.innerHTML, /herdr-editor cm/);
    assert.match(parent.innerHTML, /herdr-editor-loading/);
    assert.doesNotMatch(parent.innerHTML, /herdr-editor-numbered-code/);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].readonly, true);
    assert.equal(calls[0].content, "const x = 1;");
    assert.equal(calls[0].lineNumbers, true);
    assert.match(parent.innerHTML, /cm-content/);
    assert.doesNotMatch(parent.innerHTML, /herdr-editor-loading/);
  });

  it("starts editable editors with the same CodeMirror shell", async () => {
    const calls = [];
    const mount = {
      set innerHTML(value) { parent.innerHTML = String(value); },
      get innerHTML() { return parent.innerHTML; },
    };
    const parent = {
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".herdr-editor-mount" && this.innerHTML.includes("herdr-editor-mount")) return mount;
        return null;
      },
    };
    const context = {
      window: {},
      document: {
        createElement() { return {}; },
        body: {
          appendChild(script) {
            context.window.HerdrCodeMirror = {
              create(opts) {
                calls.push(opts);
                opts.parent.innerHTML = `<div class="cm-content cm-lineWrapping" contenteditable="${opts.readonly === false ? "true" : "false"}"></div>`;
                return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
              },
            };
            script.onload();
          },
        },
      },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    context.window.HerdrEditor.create({ parent, path: "demo.js", content: "let x = 1;", readonly: false, hideHeader: true, lineNumbers: true });
    assert.match(parent.innerHTML, /herdr-editor cm/);
    assert.match(parent.innerHTML, /herdr-editor-loading/);
    assert.doesNotMatch(parent.innerHTML, /<textarea/);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].readonly, false);
    assert.equal(calls[0].content, "let x = 1;");
    assert.match(parent.innerHTML, /contenteditable="true"/);
    assert.doesNotMatch(parent.innerHTML, /herdr-editor-loading/);
  });

  it("uses preloaded CodeMirror immediately for read-only file opens", () => {
    const calls = [];
    const mount = {
      set innerHTML(value) { parent.innerHTML = String(value); },
      get innerHTML() { return parent.innerHTML; },
    };
    const parent = {
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".herdr-editor-mount" && this.innerHTML.includes("herdr-editor-mount")) return mount;
        return null;
      },
    };
    const context = {
      window: {
        HerdrCodeMirror: {
          create(opts) {
            calls.push(opts);
            opts.parent.innerHTML = `<div spellcheck="false" autocorrect="off" autocapitalize="off" writingsuggestions="false" translate="no" contenteditable="false" style="tab-size: 4;" class="cm-content cm-lineWrapping" role="textbox" aria-multiline="true" data-language="python"></div>`;
            return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
          },
        },
      },
      document: { createElement() { return {}; }, body: { appendChild() { throw new Error("should not load CodeMirror dynamically"); } } },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);

    context.window.HerdrEditor.create({ parent, path: "demo.py", content: "print('x')", readonly: true, hideHeader: true, lineNumbers: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].readonly, true);
    assert.match(parent.innerHTML, /class="cm-content cm-lineWrapping"/);
    assert.match(parent.innerHTML, /contenteditable="false"/);
    assert.match(parent.innerHTML, /data-language="python"/);
    assert.doesNotMatch(parent.innerHTML, /herdr-editor-loading/);
  });
});


describe("HerdrEditor goto-line and position readout (A5)", () => {
  function makeLine(number) { return { number, from: (number - 1) * 4, to: number * 4 - 1 }; }
  function makeView() {
    return {
      state: {
        doc: {
          lines: 3,
          lineAt(pos) { return makeLine(Math.floor(pos / 4) + 1); },
          line(no) { return makeLine(Math.min(Math.max(1, no), 3)); },
        },
        selection: { main: { head: 4 } },
      },
    };
  }
  // Doc model: 3 lines of 3 chars + separators => line N starts at (N-1)*4.
  function makeContext() {
    const readout = { hidden: true, textContent: "" };
    const calls = { selected: [] };
    const cm = {
      create() {
        return {
          getValue() { return "aaa\nbbb\nccc"; },
          setValue() {},
          selectRange(from, to) { calls.selected.push({ from, to }); },
          destroy() {},
          view: makeView(),
        };
      },
    };
    const context = {
      window: { HerdrCodeMirror: cm },
      document: { createElement() { return {}; }, body: { appendChild() {} } },
      localStorage: { getItem: () => null, setItem: () => {} },
      Promise,
    };
    const source = readFileSync(new URL("./shared/editor.js", import.meta.url), "utf8");
    vm.runInNewContext(source, context);
    return { context, readout, calls };
  }

  it("gotoLine clamps, jumps, and rejects bad input", () => {
    const { context, calls } = makeContext();
    const parent = { querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    const editor = context.window.HerdrEditor.create({ parent, path: "demo.js", content: "aaa\nbbb\nccc", readonly: true });
    assert.equal(context.window.HerdrEditor.gotoLine(parent, editor, 2), true);
    assert.deepEqual(calls.selected, [{ from: 4, to: 4 }]);
    assert.equal(context.window.HerdrEditor.gotoLine(parent, editor, 99), true); // clamps to line 3
    assert.deepEqual(calls.selected.slice(-1), [{ from: 8, to: 8 }]);
    assert.equal(context.window.HerdrEditor.gotoLine(parent, editor, 0), true); // clamps to line 1
    assert.deepEqual(calls.selected.slice(-1), [{ from: 0, to: 0 }]);
    assert.equal(context.window.HerdrEditor.gotoLine(parent, editor, "abc"), false); // NaN
    assert.equal(context.window.HerdrEditor.gotoLine(parent, editor, null), false); // no prompt -> cancelled
  });

  it("cursorPosition reads line and col from the CodeMirror view", () => {
    const { context } = makeContext();
    const api = context.window.HerdrEditor;
    const view = makeView(); // head 4 -> line 2, col 1 (line.from = 4)
    const position = api.cursorPosition({ _view: view });
    assert.equal(position.line, 2);
    assert.equal(position.col, 1);
    assert.equal(api.cursorPosition({ _view: null }), null);
    assert.equal(api.cursorPosition(null), null);
  });

  it("Ctrl+G inside an editor triggers goto-line via prompt", () => {
    const { context, calls } = makeContext();
    const parent = { querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    context.window.HerdrEditor.create({ parent, path: "demo.js", content: "aaa\nbbb\nccc", readonly: true });
    const handler = parent.__herdrEditorGotoHandler;
    assert.ok(handler, "goto handler bound");
    context.prompt = (message) => { context.lastPrompt = message; return "2"; };
    let prevented = false;
    handler({ key: "g", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
    assert.match(context.lastPrompt, /Go to line \(1-3\)/);
    assert.deepEqual(calls.selected, [{ from: 4, to: 4 }]);
  });

  it("position readout updates from the view without DOM churn", () => {
    const { context, readout } = makeContext();
    const parentHandlers = {};
    const nodes = {};
    const parent = {
      _herdrEditorApi: null,
      get innerHTML() { return ""; },
      set innerHTML(html) {
        nodes[".herdr-editor-find"] = { hidden: true, querySelector: () => null, addEventListener() {} };
        nodes[".herdr-editor-position"] = readout;
      },
      querySelector(selector) { return nodes[selector] || null; },
      addEventListener(type, handler) {
        if (type !== "keydown") return;
        parentHandlers.__all = (parentHandlers.__all || []).concat(handler);
        parentHandlers.keydown = (event) => { for (const h of parentHandlers.__all.slice().reverse()) h(event); };
      },
      removeEventListener() {},
    };
    context.window.HerdrEditor.create({ parent, path: "demo.js", content: "aaa\nbbb\nccc", readonly: true });
    assert.equal(readout.hidden, false, "readout visible once a view exists");
    assert.equal(readout.textContent, "Ln 2, Col 1");
  });
});


describe("desktop file browser editor integration", () => {
  class FakeElement {
    constructor(document, tag = "div") {
      this.ownerDocument = document;
      this.tag = tag;
      this.children = [];
      this.parentNode = null;
      this.className = "";
      this.style = {};
      this.classList = {
        _classes: new Set(),
        add(...tokens) { for (const t of tokens) this._classes.add(t); },
        remove(...tokens) { for (const t of tokens) this._classes.delete(t); },
        contains(token) { return this._classes.has(token); },
        toggle(token, force) {
          if (force === true || (force === undefined && !this._classes.has(token))) this._classes.add(token);
          else this._classes.delete(token);
        },
      };
      this.scrollTop = 0;
      this.value = "";
      this.dataset = {};
      this._id = "";
      this._innerHTML = "";
      this._attributes = {};
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; }
    setAttribute(name, value) { this._attributes[name] = String(value); }
    set id(value) {
      this._id = String(value || "");
      if (this._id) this.ownerDocument.nodes.set(this._id, this);
    }
    get id() { return this._id; }
    set innerHTML(value) {
      this._innerHTML = String(value || "");
      for (const match of this._innerHTML.matchAll(/id="([^"]+)"/g)) {
        if (!this.ownerDocument.nodes.has(match[1])) {
          const node = new FakeElement(this.ownerDocument);
          node.id = match[1];
          node.parentNode = this;
        }
      }
    }
    get innerHTML() { return this._innerHTML; }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    // One-token matcher: "#id", ".class", "tag.class", "[data-x]". The
    // pane flow composes them with descendant whitespace below.
    static matchesToken(node, token) {
      const classes = String(node.className || "").split(/\s+/).filter(Boolean);
      const tag = String(node.tag || "").toLowerCase();
      let rest = token;
      let attrName = null;
      let attrValue = null;
      const attrMatch = rest.match(/^([^\[]+)\[([^=\]]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]$/)
        || rest.match(/^\[([^=\]]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]$/);
      if (attrMatch) {
        const lead = rest.slice(0, rest.indexOf("["));
        attrName = attrMatch[1];
        attrValue = attrMatch[2] != null ? attrMatch[2].replace(/^["']|["']$/g, "") : null;
        rest = lead;
      }
      if (rest) {
        if (rest.startsWith("#")) {
          if (node.id !== rest.slice(1)) return false;
        } else if (rest.startsWith(".")) {
          if (!classes.includes(rest.slice(1))) return false;
        } else if (rest.includes(".")) {
          const [t, c] = rest.split(".");
          if (tag !== t.toLowerCase() || !classes.includes(c)) return false;
        } else if (tag !== rest.toLowerCase()) return false;
      }
      if (attrName != null) {
        const camel = attrName.replace(/^data-/, "").replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        const value = attrName.startsWith("data-") ? node.dataset[camel] : Object.prototype.hasOwnProperty.call(node._attributes, attrName) ? node._attributes[attrName] : null;
        if (attrValue != null && String(value) !== attrValue) return false;
        if (attrValue == null && value == null) return false;
      }
      return true;
    }
    querySelectorAll(selector) {
      const tokens = String(selector).trim().split(/\s+/);
      const results = [];
      const visit = (node, depth) => {
        for (const child of node.children || []) {
          if (FakeElement.matchesToken(child, tokens[depth])) {
            if (depth === tokens.length - 1) results.push(child);
            else visit(child, depth + 1);
          }
          visit(child, depth);
        }
      };
      visit(this, 0);
      return results;
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) this.ownerDocument.nodes.set(child.id, child);
      return child;
    }
    remove() {
      if (this.id) this.ownerDocument.nodes.delete(this.id);
      if (this.parentNode && Array.isArray(this.parentNode.children)) {
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
      }
    }
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    focus() {}
    setSelectionRange() {}
  }

  function createFakeDocument() {
    const doc = {
      nodes: new Map(),
      activeElement: null,
      listeners: {},
      addEventListener(type, listener, options) {
        const phase = options === true || (options && options.capture) ? "capture" : "bubble";
        const key = `${type}:${phase}`;
        if (!this.listeners[key]) this.listeners[key] = [];
        this.listeners[key].push(listener);
      },
      createElement(tag) { return new FakeElement(doc, tag); },
      getElementById(id) {
        if (!doc.nodes.has(id) && String(id || "").startsWith("fileBrowserEditor-")) {
          const node = new FakeElement(doc);
          node.id = id;
        }
        return doc.nodes.get(id) || null;
      },
      querySelector(selector) { return doc.body ? doc.body.querySelectorAll(selector)[0] || null : null; },
      querySelectorAll(selector) { return doc.body ? doc.body.querySelectorAll(selector) : []; },
    };
    doc.body = new FakeElement(doc, "body");
    doc.head = new FakeElement(doc, "head");
    return doc;
  }

  it("renders current folder up control and treats home as a stable root", async () => {
    const document = createFakeDocument();
    const requests = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url) => {
        requests.push(String(url));
        return {
          ok: true,
          async json() {
            const path = decodeURIComponent((String(url).match(/path=([^&]*)/) || [null, ""])[1]);
            return { path, entries: [{ kind: "file", name: "demo.txt", path: path ? `${path}/demo.txt` : "demo.txt" }], git_status: null };
          },
        };
      },
      confirm: () => true,
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    assert.equal(context.window.HerdrFileTree.parentDirectory("~"), "~");
    assert.equal(context.window.HerdrFileTree.parentDirectory("~/code"), "~");

    await context.window.HerdrFileBrowser.openAt({ cwd: "~" }, "src", { kind: "dir" });
    const html = document.getElementById("fileBrowserPanel").innerHTML;
    assert.match(html, /herdr-file-tree-current/);
    assert.match(html, /↑ Up/);
    assert.doesNotMatch(html, /herdr-tree-row dir up/);

    context.window.HerdrFileBrowser.up();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(requests.at(-1), /cwd=~/);
    assert.match(requests.at(-1), /path=/);
  });

  it("executes file browser context menu actions from delegated button clicks", async () => {
    const document = createFakeDocument();
    const requests = [];
    const clipboardWrites = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } },
      fetch: async (url, options = {}) => {
        const text = String(url);
        requests.push({ url: text, options });
        return {
          ok: true,
          async json() {
            if (text.startsWith("/api/git-ui/permalink")) return { url: "https://bitbucket.org/team/repo/src/abc/demo.txt" };
            return { path: "", entries: [{ kind: "file", name: "demo.txt", path: "demo.txt" }], git_status: null };
          },
        };
      },
      prompt: () => "renamed.txt",
      confirm: () => true,
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    await context.window.HerdrFileBrowser.open({ cwd: "/repo" });
    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("demo.txt"), "file");
    assert.match(document.getElementById("fileBrowserPanel").innerHTML, /data-file-menu-action="rename"/);
    assert.match(document.getElementById("fileBrowserPanel").innerHTML, /data-file-menu-action="copyPermalink"/);

    const click = async (action) => {
      const button = { dataset: { fileMenuAction: action } };
      button.closest = (selector) => selector === ".file-browser-menu [data-file-menu-action]" ? button : null;
      const textNodeTarget = { parentElement: button };
      await document.listeners["click:capture"].at(-1)({
        target: textNodeTarget,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.immediateStopped = true; },
      });
    };

    await click("rename");
    assert.ok(requests.some((request) => request.url === "/api/file-browser/rename"));
    assert.match(requests.find((request) => request.url === "/api/file-browser/rename").options.body, /renamed\.txt/);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /file-browser-menu/);

    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("demo.txt"), "file");
    await click("copyPermalink");
    assert.ok(requests.some((request) => request.url.startsWith("/api/git-ui/permalink?cwd=%2Frepo&path=demo.txt")));
    assert.deepEqual(clipboardWrites, ["https://bitbucket.org/team/repo/src/abc/demo.txt"]);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /file-browser-menu/);
  });

  it("opens a right-clicked git checkout through worktree.open", async () => {
    const document = createFakeDocument();
    const bodies = [];
    const navigations = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
        showBlocking() {},
        hideBlocking() {},
        go(ws, tab, pane) { navigations.push([ws, tab, pane]); },
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url, options = {}) => {
        const text = String(url);
        bodies.push({ url: text, body: options.body || null });
        return {
          ok: true,
          async json() {
            if (text.startsWith("/api/worktrees?")) {
              return {
                result: {
                  worktrees: [
                    { path: "/home/repo", branch: "main", is_linked_worktree: true },
                    { path: "/home/repo-wt-feature", branch: "feature", is_linked_worktree: true },
                  ],
                },
              };
            }
            if (text === "/api/worktrees/open") {
              return {
                result: {
                  workspace: { workspace_id: "ws9" },
                  tab: { tab_id: "tab9" },
                  root_pane: { pane_id: "pane9" },
                },
              };
            }
            return { path: "", entries: [{ kind: "dir", name: "repo", path: "repo" }, { kind: "dir", name: "plain", path: "plain" }, { kind: "file", name: "demo.txt", path: "demo.txt" }], git_status: null, root: "/home" };
          },
        };
      },
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
      go(ws, tab, pane) { navigations.push([ws, tab, pane]); },
      showBlocking() {},
      hideBlocking() {},
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    await context.window.HerdrFileBrowser.open({ cwd: "/home" });
    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("repo"), "dir");
    const html = document.getElementById("fileBrowserPanel").innerHTML;
    assert.match(html, /data-file-menu-action="openWorkspaceHere"/);
    assert.match(html, /Open workspace here<\/span>/);

    const button = { dataset: { fileMenuAction: "openWorkspaceHere" } };
    button.closest = (selector) => selector === ".file-browser-menu [data-file-menu-action]" ? button : null;
    const textNodeTarget = { parentElement: button };
    await document.listeners["click:capture"].at(-1)({
      target: textNodeTarget,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });

    const detection = bodies.find((request) => request.url.startsWith("/api/worktrees?cwd="));
    assert.ok(detection, "worktree detection request fired");
    assert.ok(detection.url.includes(encodeURIComponent("/home/repo")), "detection targets the absolute folder");
    const opened = bodies.find((request) => request.url === "/api/worktrees/open");
    assert.ok(opened, "worktree.open request fired for the matched checkout");
    assert.match(opened.body, /"path":"\/home\/repo"/);
    assert.ok(!bodies.some((request) => request.url === "/api/workspaces"), "git checkout skips workspace create");
    assert.deepEqual(navigations, [["ws9", "tab9", "pane9"]]);
  });

  it("opens a right-clicked plain folder as a workspace and records it in recents", async () => {
    const document = createFakeDocument();
    const bodies = [];
    const navigations = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
        showBlocking() {},
        hideBlocking() {},
        go(ws, tab, pane) { navigations.push([ws, tab, pane]); },
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url, options = {}) => {
        const text = String(url);
        bodies.push({ url: text, body: options.body || null });
        return {
          ok: true,
          async json() {
            if (text.startsWith("/api/worktrees?")) return { result: { worktrees: [] } };
            if (text === "/api/workspaces") {
              return {
                result: {
                  workspace: { workspace_id: "ws2" },
                  tab: { tab_id: "tab2" },
                  root_pane: { pane_id: "pane2" },
                },
              };
            }
            if (text === "/api/recent-workspaces/record") return { ok: true };
            return { path: "", entries: [{ kind: "dir", name: "plain", path: "plain" }, { kind: "file", name: "demo.txt", path: "demo.txt" }], git_status: null, root: "/home" };
          },
        };
      },
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
      go(ws, tab, pane) { navigations.push([ws, tab, pane]); },
      showBlocking() {},
      hideBlocking() {},
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    await context.window.HerdrFileBrowser.open({ cwd: "/home" });
    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("plain"), "dir");
    const button = { dataset: { fileMenuAction: "openWorkspaceHere" } };
    button.closest = (selector) => selector === ".file-browser-menu [data-file-menu-action]" ? button : null;
    const textNodeTarget = { parentElement: button };
    await document.listeners["click:capture"].at(-1)({
      target: textNodeTarget,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });

    assert.ok(!bodies.some((request) => request.url === "/api/worktrees/open"), "plain folder skips worktree.open");
    const created = bodies.find((request) => request.url === "/api/workspaces");
    assert.ok(created, "workspace create request fired");
    assert.match(created.body, /"cwd":"\/home\/plain"/);
    assert.match(created.body, /"label":"plain"/);
    const recorded = bodies.find((request) => request.url === "/api/recent-workspaces/record");
    assert.ok(recorded, "recents record request fired");
    assert.match(recorded.body, /"path":"\/home\/plain"/);
    assert.deepEqual(navigations, [["ws2", "tab2", "pane2"]]);
  });

  it("treats a folder inside a repo as a plain folder", async () => {
    const document = createFakeDocument();
    const bodies = [];
    const navigations = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url, options = {}) => {
        const text = String(url);
        bodies.push({ url: text, body: options.body || null });
        return {
          ok: true,
          async json() {
            // Rows belong to the enclosing repo: none matches the clicked
            // subdir, and worktree.open answers with the already-open
            // workspace instead of creating a duplicate.
            if (text.startsWith("/api/worktrees?")) {
              return {
                result: {
                  worktrees: [
                    { path: "/home/repo", branch: "main", is_linked_worktree: true },
                    { path: "/home/repo-wt", branch: "feature", is_linked_worktree: true },
                  ],
                },
              };
            }
            if (text === "/api/workspaces") {
              return {
                result: {
                  workspace: { workspace_id: "ws-existing" },
                  tab: { tab_id: "tab-existing" },
                  root_pane: { pane_id: "pane-existing" },
                },
              };
            }
            if (text === "/api/recent-workspaces/record") return { ok: true };
            return { path: "", entries: [{ kind: "dir", name: "repo", path: "repo" }, { kind: "file", name: "demo.txt", path: "demo.txt" }], git_status: null, root: "/home" };
          },
        };
      },
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
      go(ws, tab, pane) { navigations.push([ws, tab, pane]); },
      showBlocking() {},
      hideBlocking() {},
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    // repo/docs is inside the repo but is not a checkout row.
    await context.window.HerdrFileBrowser.open({ cwd: "/home" });
    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("repo/docs"), "dir");
    const button = { dataset: { fileMenuAction: "openWorkspaceHere" } };
    button.closest = (selector) => selector === ".file-browser-menu [data-file-menu-action]" ? button : null;
    const textNodeTarget = { parentElement: button };
    await document.listeners["click:capture"].at(-1)({
      target: textNodeTarget,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });

    assert.ok(!bodies.some((request) => request.url === "/api/worktrees/open"), "subdir inside repo is not opened as a checkout");
    const created = bodies.find((request) => request.url === "/api/workspaces");
    assert.ok(created, "subdir inside repo falls back to workspace create");
    assert.match(created.body, /"cwd":"\/home\/repo\/docs"/);
    assert.deepEqual(navigations, [["ws-existing", "tab-existing", "pane-existing"]]);
  });

  it("keeps Open workspace here off the file menu and ignores it for file rows", async () => {
    const document = createFakeDocument();
    const bodies = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: { create() { return { getValue() { return ""; }, setValue() {}, destroy() {} }; } },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        rememberWorkspaceShellMode() {},
        syncShellModeButtons() {},
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserAllowParent: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url, options = {}) => {
        const text = String(url);
        bodies.push({ url: text, body: options.body || null });
        return {
          ok: true,
          async json() {
            return { path: "", entries: [{ kind: "dir", name: "repo", path: "repo" }, { kind: "file", name: "demo.txt", path: "demo.txt" }], git_status: null, root: "/home" };
          },
        };
      },
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    await context.window.HerdrFileBrowser.open({ cwd: "/home" });
    context.window.HerdrFileBrowser.menu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 34 }, encodeURIComponent("demo.txt"), "file");
    const html = document.getElementById("fileBrowserPanel").innerHTML;
    assert.doesNotMatch(html, /data-file-menu-action="openWorkspaceHere"/);

    // A forged file-kind click cannot reach the open flow either.
    const button = { dataset: { fileMenuAction: "openWorkspaceHere" } };
    button.closest = (selector) => selector === ".file-browser-menu [data-file-menu-action]" ? button : null;
    const textNodeTarget = { parentElement: button };
    await document.listeners["click:capture"].at(-1)({
      target: textNodeTarget,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });
    assert.ok(!bodies.some((request) => request.url.startsWith("/api/worktrees?cwd=")), "file rows never trigger detection");
    assert.ok(!bodies.some((request) => request.url === "/api/workspaces"), "file rows never trigger workspace create");
  });

// ---- center-pane editor tab flow (Phase 3b) ---------------------------
  // Files open as per-file editor tabs (editor:<path>) in the center pane
  // strip. The harness boots the real workspace_panes module next to the
  // file browser registry, so tests exercise the same open/mount/close
  // loop the desktop shell uses: Panes.openEditorTab -> registry fetch ->
  // mountEditorTab -> pane strip render. The old sidebar-surface tests
  // (lock toggle, eye toggle, tree Preview, tab context menu, Split) died
  // with the rehost; the editor behaviors they covered live on here.

  function makePaneHarness(options = {}) {
    const document = createFakeDocument();
    const editorCalls = [];
    const requests = [];
    const confirmCalls = [];
    const keydownListeners = [];
    let confirmAnswer = options.confirmAnswer != null ? options.confirmAnswer : true;
    const diskFiles = options.diskFiles || {};
    const harness = {
      document,
      editorCalls,
      requests,
      confirmCalls,
      keydownListeners,
      setConfirm(answer) { confirmAnswer = answer; },
      setDiskContent(path, content, hash) { diskFiles[path] = { content, hash }; },
    };
    const context = {
      window: {
        addEventListener(type, listener) {
          if (type === "keydown") keydownListeners.push(listener);
        },
        HerdrEditor: {
          create(opts) {
            editorCalls.push({ path: opts.path, content: opts.content, readonly: opts.readonly, markdownPreview: opts.markdownPreview, searchHighlight: opts.searchHighlight, onChange: opts.onChange, lineNumbers: opts.lineNumbers });
            // Mirror the real mount contract: a .herdr-editor wrapper in
            // the parent, and onReady fired synchronously (CodeMirror is
            // preloaded in tests). The registry caches at onReady.
            const wrapper = document.createElement("div");
            wrapper.className = "herdr-editor";
            wrapper.innerHTML = '<div class="cm-content"></div>';
            opts.parent.appendChild(wrapper);
            opts.parent._herdrEditorApi = { toggleFind() { editorCalls.at(-1).toggledFind = true; } };
            if (typeof opts.onReady === "function") opts.onReady();
            return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
          },
          // Mirrors shared/editor.js openFind: the parent is the pane
          // editor container, the mounted api lives on the inner mount
          // node (ensureEditorMountPoint), like the find bar lives inside
          // the mounted editor markup. Returns false with no mounted editor.
          openFind(parent) {
            if (!parent) return false;
            const mount = parent.querySelector && parent.querySelector(".pane-editor-mount");
            if (!mount || !mount._herdrEditorApi) return false;
            const call = editorCalls.at(-1);
            if (call) call.toggledFind = true;
            return true;
          },
          isMarkdownPath(path) { return /\.md$/i.test(String(path || "")); },
        },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
        HerdrWorkspacePanes: null,
      },
      document,
      localStorage: {
        getItem(key) {
          if (String(key) === "herdr-web-workspace-panes") return harness.panesStorage || "{}";
          return JSON.stringify({ fileBrowserLineNumbers: true, fileBrowserGitStatus: false });
        },
        setItem(key, value) {
          if (String(key) === "herdr-web-workspace-panes") harness.panesStorage = String(value);
        },
      },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url, opts) => {
        const text = String(url);
        requests.push({ url: text, options: opts || {} });
        const reply = (body) => ({ ok: true, async json() { return body; } });
        if (text.startsWith("/api/file-browser/file")) {
          const path = decodeURIComponent((text.match(/path=([^&]+)/) || [null, ""])[1]);
          if (opts && opts.method === "POST") {
            const payload = JSON.parse(opts.body);
            diskFiles[path] = { content: payload.content, hash: `hash-${harness.postCount = (harness.postCount || 0) + 1}` };
            return reply({ hash: diskFiles[path].hash });
          }
          if (text.includes("max_bytes=262144")) {
            return reply({ path, content: "x".repeat(262144), hash: "", binary: false, truncated: true, size: 2 * 1024 * 1024, preview_bytes: 262144 });
          }
          const disk = diskFiles[path] || { content: `content of ${path}`, hash: "hash-load" };
          return reply({ path, content: text.includes("hash_only=true") ? "" : disk.content, hash: disk.hash, binary: false, truncated: !!disk.truncated, size: disk.size || disk.content.length });
        }
        const cwd = decodeURIComponent((text.match(/cwd=([^&]+)/) || [null, "/repo"])[1]);
        return reply({ root: cwd, home: "/home", path: "", entries: [], git_status: null });
      },
      confirm(message) { confirmCalls.push(String(message)); return confirmAnswer; },
      HerdrAppHelpers: require("./shared/core.js"),
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      Date,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      getComputedStyle: () => ({ getPropertyValue() { return "14"; } }),
    };
    context.window.window = context.window;
    context.window.document = document;
    // The panes module and the registry read bare bundle identifiers;
    // hoist every one the VM cannot resolve from the window object.
    context.window.fetch = context.fetch;
    context.window.confirm = (message) => { confirmCalls.push(String(message)); return confirmAnswer; };
    context.window.localStorage = context.localStorage;
    context.window.navigator = context.navigator;
    context.window.getComputedStyle = context.getComputedStyle;
    context.window.HerdrAppHelpers = context.HerdrAppHelpers;
    context.window.state = { ws: "ws", tabs: [{ tab_id: "terminal", label: "panel 1" }], tab: "terminal", allTabs: [], workspacePanes: {} };
    context.window.el = (id) => document.getElementById(id);
    context.window.workspaceShellKey = (id) => `ws|${id}`;
    context.window.workspacePath = () => "/repo";
    context.window.selectedOrDefaultWorkspace = () => ({ workspace_id: "ws", cwd: "/repo" });
    context.window.escapeHtml = (value) => String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    context.window.escapeAttr = (value) => String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
    context.window.panelVisibleLabel = (tab) => (tab && (tab.label || tab.title)) || "panel";
    context.window.panelRenameInitialLabel = () => "panel";
    context.window.tabTitle = (tab) => (tab && (tab.label || tab.title)) || "panel";
    context.window.tabHoverInfo = () => "";
    context.window.panesByTabIndex = () => new Map();
    context.window.startTabRename = () => {};
    context.window.closeTab = () => {};
    context.window.newTab = () => {};
    context.window.titleWithWebuiShortcut = (title) => title;
    context.window.go = () => {};
    context.window.appRefreshIconButton = context.appRefreshIconButton;
    // Mirror app.html: #workspacePanes hosts the pane skeleton and parks
    // #terminalShell inside it.
    const workspacePanes = document.createElement("div");
    workspacePanes.id = "workspacePanes";
    document.body.appendChild(workspacePanes);
    const terminalShell = document.createElement("div");
    terminalShell.id = "terminalShell";
    workspacePanes.appendChild(terminalShell);

    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), vm.createContext(context.window));
    vm.runInNewContext(readFileSync(new URL("./desktop/app_js/workspace_panes.js", import.meta.url), "utf8"), vm.createContext(context.window));
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), vm.createContext(context.window));
    harness.context = context;
    harness.FB = context.window.HerdrFileBrowser;
    harness.Panes = context.window.HerdrWorkspacePanes;
    harness.stripHtml = () => {
      const pane = document.querySelector("#workspacePanes .workspace-pane");
      const strip = pane && pane.querySelector(".pane-tab-strip");
      return strip ? strip.innerHTML : "";
    };
    harness.containerFor = (path) => document.getElementById("pane-editor-" + require("./shared/core.js").hashId(path));
    return harness;
  }

  it("opens files editable by default as center-pane editor tabs", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Tab identity and strip markup come from the panes module.
    const root = h.Panes.paneRoot();
    assert.deepEqual([...root.tabs], ["terminal", "editor:src/demo.py"]);
    assert.equal(root.active, "editor:src/demo.py");
    const strip = h.stripHtml();
    assert.match(strip, /pane-tab editor active/);
    assert.match(strip, /data-tab-kind="editor"/);
    assert.match(strip, /data-tab-id="editor:src\/demo\.py"/);
    assert.match(strip, /<span class="pane-tab-label">demo\.py<\/span>/);
    assert.match(strip, /closeEditorTab\('src%2Fdemo\.py'\)/);
    assert.doesNotMatch(strip, /pane-tab-dirty/);

    // Editable by default: the editor mounts in the pane content slot.
    assert.equal(h.editorCalls.at(-1).path, "src/demo.py");
    assert.equal(h.editorCalls.at(-1).readonly, false);
    assert.equal(h.editorCalls.at(-1).lineNumbers, true);
    const container = h.containerFor("src/demo.py");
    assert.ok(container, "per-file editor container exists");
    assert.equal(container.className, "pane-editor-container");
    assert.equal(container.dataset.path, "src/demo.py");
    assert.equal(h.FB.activeEditorPath(), "src/demo.py");
    assert.equal(h.FB.editorFor("src/demo.py").editing, true);

    // Opening another file mounts its own container; the old one hides.
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = h.containerFor("src/demo.py");
    const second = h.containerFor("src/other.py");
    assert.equal(first.style.display, "none");
    assert.equal(second.style.display, "");
    assert.equal(h.FB.activeEditorPath(), "src/other.py");
  });

  it("opens markdown files read-only with rendered preview", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("README.md");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const file = h.FB.editorFor("README.md");
    assert.equal(file.editing, false, "markdown opens read-only so the preview engages");
    assert.equal(h.editorCalls.at(-1).readonly, true);
    assert.equal(h.editorCalls.at(-1).markdownPreview, true);
    assert.equal(h.editorCalls.at(-1).path, "README.md");
  });

  it("syncs the dirty dot in the pane strip live from editor changes", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(h.stripHtml(), /pane-tab-dirty/);

    h.editorCalls.at(-1).onChange("content of src/demo.py\nplus edits");
    assert.match(h.stripHtml(), /pane-tab-dirty/);
    const file = h.FB.editorFor("src/demo.py");
    assert.equal(file.dirty, true);
    assert.equal(file.draft, "content of src/demo.py\nplus edits");

    // Reverting the text clears the dot without a remount.
    h.editorCalls.at(-1).onChange("content of src/demo.py");
    assert.doesNotMatch(h.stripHtml(), /pane-tab-dirty/);
  });

  it("reuses the editor instance across remounts and recreates it on content change (C4)", async () => {
    const h = makePaneHarness();
    const creates = [];
    const destroys = [];
    const origCreate = h.context.window.HerdrEditor.create;
    h.context.window.HerdrEditor.create = function (opts) {
      // Build a real .herdr-editor wrapper child so the registry can cache
      // and reattach it like it does with the real CodeMirror mount.
      const wrapper = h.document.createElement("div");
      wrapper.className = "herdr-editor";
      opts.parent.appendChild(wrapper);
      const api = { toggleFind() {}, destroy() { destroys.push(opts.path); } };
      opts.parent._herdrEditorApi = api;
      creates.push({ path: opts.path, content: opts.content });
      if (typeof opts.onReady === "function") opts.onReady();
      return api;
    };
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Switch back: same content and editability, the cached wrapper is
    // reattached, no new create() call.
    const createsBefore = creates.length;
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(creates.length, createsBefore, "no recreate for unchanged signature");
    assert.equal(h.FB.activeEditorPath(), "src/demo.py");

    // A content change invalidates the signature: recreate on next mount.
    h.FB.editorFor("src/demo.py").draft = "changed draft";
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(creates.length > createsBefore, "content change recreates the editor");
    assert.equal(creates.at(-1).content, "changed draft");
  });

  it("does not reattach a wrapper cached before the lazy CodeMirror mount settled", async () => {
    // Regression (Phase 3b live smoke): the first editor open of a session
    // races the lazy CodeMirror load. HerdrEditor.create() mounts a loading
    // shell and swaps in the real editor later; the registry must cache the
    // wrapper at onReady (after the swap), never at create-return time. A
    // cache entry holding the loading shell used to satisfy reactivation
    // and reattached a dead wrapper: buttons rendered, no editor.
    const h = makePaneHarness();
    const creates = [];
    // Deferred queue standing in for ensureCodeMirror().then(...): the test
    // pumps it manually so the swap happens strictly after openEditorTab
    // returned, like a real network script load.
    const pendingSettles = [];
    // The real create() opens with parent.innerHTML = codeMirrorShellHtml()
    // (a loading shell) and the lazy mount later REPLACES that shell before
    // onReady. FakeElement.innerHTML does not detach children, so the stub
    // models both replaces by dropping old .herdr-editor children first.
    const clearWrappers = (parent) => {
      for (const child of [...(parent.children || [])]) {
        if (String(child.className || "").split(/\s+/).includes("herdr-editor")) parent.removeChild(child);
      }
    };
    h.context.window.HerdrEditor.create = function (opts) {
      clearWrappers(opts.parent);
      const wrapper = h.document.createElement("div");
      wrapper.className = "herdr-editor";
      const loading = h.document.createElement("div");
      loading.className = "herdr-editor-loading";
      wrapper.appendChild(loading);
      opts.parent.appendChild(wrapper);
      const api = { toggleFind() {}, destroy() {} };
      opts.parent._herdrEditorApi = api;
      creates.push(opts.path);
      pendingSettles.push(() => {
        // The lazy mount replaces the shell: swap wrapper children for the
        // real editor markup, then fire onReady (cache write point).
        clearWrappers(opts.parent);
        const settled = h.document.createElement("div");
        settled.className = "herdr-editor";
        const cm = h.document.createElement("div");
        cm.className = "cm-content";
        settled.appendChild(cm);
        opts.parent.appendChild(settled);
        if (typeof opts.onReady === "function") opts.onReady();
      });
      return api;
    };
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(creates.filter((p) => p === "src/demo.py").length, 1, "first open creates the editor");

    // Reactivation while the lazy mount is still in flight: nothing was
    // cached yet (onReady never ran), so the registry must NOT reattach
    // the loading shell; it recreates. The old code cached the shell at
    // create-return time and reattached it dead.
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(creates.filter((p) => p === "src/demo.py").length, 2, "no stale reattach while the lazy mount is pending");

    // Settle the live create (the second demo.py one): the cache now holds
    // the real editor wrapper, written at onReady.
    pendingSettles[2]();
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(creates.filter((p) => p === "src/demo.py").length, 2, "reattaches the onReady-cached wrapper");
    const container = h.containerFor("src/demo.py");
    const mount = container.querySelector(".pane-editor-mount");
    assert.ok(mount, "mount point exists in the container");
    const wrapper = mount.querySelector(".herdr-editor");
    assert.ok(wrapper, "wrapper reattached");
    assert.ok(wrapper.querySelector(".cm-content"), "reattached wrapper carries the real editor, not the loading shell");
    assert.ok(!wrapper.querySelector(".herdr-editor-loading"), "no loading shell in the reattached wrapper");
  });

  it("keeps editor state per workspace and forgets it with the workspace", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws-a", cwd: "/repo-a" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.editorCalls.at(-1).onChange("draft for repo-a");

    // Same path in another workspace has its own state.
    await h.FB.open({ workspace_id: "ws-b", cwd: "/repo-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fileB = h.FB.editorFor("src/demo.py");
    assert.equal(fileB.dirty, false, "fresh workspace starts clean");
    assert.equal(fileB.draft, "content of src/demo.py");

    // Back to ws-a: the draft survives the workspace switch.
    await h.FB.open({ workspace_id: "ws-a", cwd: "/repo-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.FB.editorFor("src/demo.py").draft, "draft for repo-a");
    assert.equal(h.FB.editorFor("src/demo.py").dirty, true);

    // forgetWorkspace drops the cached drafts and editor state.
    h.FB.forgetWorkspace({ workspace_id: "ws-a" });
    await h.FB.open({ workspace_id: "ws-a", cwd: "/repo-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.FB.editorFor("src/demo.py").draft, "content of src/demo.py", "draft forgotten with the workspace");
  });

  it("keeps a dirty tab when close confirmation is declined and closes it when confirmed", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.editorCalls.at(-1).onChange("dirty draft");

    // Declined: the tab stays, state stays. The registry's closeEditorTab
    // is the confirm gate (the panes wrapper returns void).
    h.setConfirm(false);
    let closed = await h.FB.closeEditorTab(encodeURIComponent("src/demo.py"));
    assert.equal(closed, false);
    assert.ok(h.Panes.paneRoot().tabs.includes("editor:src/demo.py"));
    assert.ok(h.FB.editorFor("src/demo.py"), "state kept while close is declined");
    assert.equal(h.confirmCalls.length, 1);
    assert.match(h.confirmCalls[0], /src\/demo\.py/);

    // Confirmed: tab dropped from the tree, state and container released.
    h.setConfirm(true);
    closed = await h.FB.closeEditorTab(encodeURIComponent("src/demo.py"));
    assert.equal(closed, true);
    assert.ok(!h.Panes.paneRoot().tabs.includes("editor:src/demo.py"));
    assert.ok(!h.FB.editorFor("src/demo.py"), "state dropped after confirmed close");
    assert.equal(h.containerFor("src/demo.py"), null, "container removed with the tab");
  });

  it("opening the same path twice reuses the tab without a duplicate fetch (A3)", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fetchesBefore = h.requests.filter((r) => r.url.startsWith("/api/file-browser/file")).length;
    assert.equal(fetchesBefore, 1);

    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fetchesAfter = h.requests.filter((r) => r.url.startsWith("/api/file-browser/file")).length;
    assert.equal(fetchesAfter, fetchesBefore, "no duplicate fetch for an open tab");
    const editorTabs = h.Panes.paneRoot().tabs.filter((tabId) => tabId.startsWith("editor:"));
    assert.deepEqual([...editorTabs], ["editor:src/demo.py"], "one tab per path");
  });

  it("reopens from content search with a highlight and forces the source view", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("README.md");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.editorCalls.at(-1).markdownPreview, true);

    // openAt with a highlight is the search palette path: same tab, source
    // view forced so the match line is visible.
    await h.FB.openAt({ workspace_id: "ws", cwd: "/repo" }, "README.md", { highlight: "needle" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const file = h.FB.editorFor("README.md");
    assert.equal(file.searchHighlight, "needle");
    assert.equal(file.previewSource, true);
    assert.equal(h.editorCalls.at(-1).markdownPreview, false, "highlight forces the source view");
    const editorTabs = h.Panes.paneRoot().tabs.filter((tabId) => tabId.startsWith("editor:"));
    assert.deepEqual([...editorTabs], ["editor:README.md"], "search open reuses the existing tab");
  });

  it("offers and serves a partial preview for oversized files (A4)", async () => {
    const h = makePaneHarness({ diskFiles: { "big.log": { content: "", hash: "hash-empty", truncated: true, size: 2 * 1024 * 1024 } } });
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("big.log");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Plain truncated open: placeholder with the load-partial button.
    const containerHtml = () => h.containerFor("big.log").innerHTML;
    assert.match(containerHtml(), /File too large to preview/);
    assert.match(containerHtml(), /Load first 256 KB/);

    // Load the partial preview: backend budget read, read-only source mount.
    await h.FB.loadPartial(encodeURIComponent("big.log"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(h.requests.some((r) => r.url.includes("max_bytes=262144")), "partial fetch uses the budget param");
    assert.equal(h.editorCalls.at(-1).readonly, true, "partial preview mounts read-only");
    assert.equal(h.editorCalls.at(-1).markdownPreview, false, "partial preview is a source view");
    assert.equal(h.FB.editorFor("big.log").partialPreview, true);
    assert.doesNotMatch(containerHtml(), /Load first 256 KB/);

    // Reload (plain path) clears the partial marker back to the placeholder.
    await h.FB.reload(encodeURIComponent("big.log"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(containerHtml(), /File too large to preview/);
    assert.equal(h.FB.editorFor("big.log").partialPreview, false);
  });

  it("prompts to reload when an open file changed on disk (A6)", async () => {
    const h = makePaneHarness({ diskFiles: { "watched.txt": { content: "version 1", hash: "hash-one" } } });
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("watched.txt");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No external change: probe runs but never prompts.
    h.confirmCalls.length = 0;
    await h.FB.checkOpenFilesForExternalChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.confirmCalls.length, 0, "no prompt when disk matches");
    assert.ok(h.requests.some((r) => r.url.includes("hash_only=true")), "probe uses the cheap hash endpoint");

    // External change: prompt, then a full reload after confirm.
    h.setDiskContent("watched.txt", "version 2 from another tool", "hash-two");
    h.confirmCalls.length = 0;
    await h.FB.checkOpenFilesForExternalChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.confirmCalls.length, 1, "prompted once about the external change");
    assert.match(h.confirmCalls[0], /watched\.txt[\s\S]*changed on disk/);
    assert.equal(h.FB.editorFor("watched.txt").content, "version 2 from another tool", "confirmed reload picked up the new content");

    // Declining the prompt keeps the stale tab untouched.
    h.setDiskContent("watched.txt", "version 3 nobody wants", "hash-three");
    h.setConfirm(false);
    h.confirmCalls.length = 0;
    await h.FB.checkOpenFilesForExternalChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.confirmCalls.length, 1, "prompted for the second change");
    assert.equal(h.FB.editorFor("watched.txt").content, "version 2 from another tool", "declined reload keeps old content");
  });

  it("saves the active editor tab with Cmd+S and keeps editing after save", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/a.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.editorCalls.at(-1).onChange("content of src/a.py\nplus edits");
    assert.match(h.stripHtml(), /pane-tab-dirty/);

    // Cmd+S saves the active tab: preventDefault + one POST with the
    // expected_hash guard.
    let prevented = false;
    await h.keydownListeners.at(-1)({
      target: null, key: "s", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault() { prevented = true; }, stopPropagation() {}, defaultPrevented: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(prevented, "Cmd+S prevented the browser save dialog");
    const posts = h.requests.filter((r) => r.options.method === "POST");
    assert.equal(posts.length, 1, "Cmd+S made one save POST");
    assert.equal(posts[0].url, "/api/file-browser/file");
    assert.match(posts[0].options.body, /"path":"src\/a\.py"/);
    assert.match(posts[0].options.body, /"expected_hash":"hash-load"/);
    assert.match(posts[0].options.body, /"content":"content of src\/a\.py\\nplus edits"/);

    // Save clears the dirty state and the strip dot; editing continues.
    const file = h.FB.editorFor("src/a.py");
    assert.equal(file.dirty, false);
    assert.equal(file.content, "content of src/a.py\nplus edits");
    assert.doesNotMatch(h.stripHtml(), /pane-tab-dirty/);
    assert.equal(file.editing, true, "still editable after save");

    // Cmd+S on a clean editable file still saves: the POST is idempotent
    // server-side, and the strip stays dot-free.
    await h.keydownListeners.at(-1)({
      target: null, key: "s", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault() { prevented = true; }, stopPropagation() {}, defaultPrevented: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 2, "Cmd+S on a clean file posts again");
    assert.doesNotMatch(h.stripHtml(), /pane-tab-dirty/);
  });

  it("toggles find in the active editor tab from the strip shortcut", async () => {
    const h = makePaneHarness();
    await h.FB.open({ workspace_id: "ws", cwd: "/repo" });
    await h.Panes.openEditorTab("src/demo.py");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // openFocusedFind targets the active editor tab's mounted api.
    assert.equal(h.FB.openFocusedFind(), true);
    assert.equal(h.editorCalls.at(-1).toggledFind, true);
    assert.equal(h.editorCalls.at(-1).path, "src/demo.py");

    // toggleFind targets a specific mounted editor.
    await h.Panes.openEditorTab("src/other.py");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = h.editorCalls.length;
    h.FB.toggleFind(encodeURIComponent("src/demo.py"));
    const demoCall = h.editorCalls.find((c) => c.path === "src/demo.py");
    assert.equal(demoCall.toggledFind, true);
  });
});

