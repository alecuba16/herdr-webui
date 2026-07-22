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
  tabActivityLabel,
  terminalPasteInput,
  stripTerminalMouseReports,
  stripTerminalQueryReplies,
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

  it("removes bare repeated color reply fragments like xterm can echo", () => {
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
    assert.ok(html.includes(`HerdrGitUi.copyCommitId('${hash}')`));
    assert.match(html, /Copy id/);
    assert.match(html, new RegExp(`aria-label="Copy full commit id ${hash}"`));
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
    assert.match(html, /herdr-editor-find/);
    assert.match(html, /herdr-editor-replace-query[^>]*disabled/);
  });

  it("can hide line numbers in fallback previews after CodeMirror load failure", async () => {
    const html = await createFallbackEditor({ lineNumbers: false });
    assert.doesNotMatch(html, /herdr-editor-numbered-code/);
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
    let parentKeydown = null;
    let queryKeydown = null;
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
      addEventListener(type, handler) { if (type === "keydown") parentKeydown = handler; },
      removeEventListener() {},
    };
    const context = {
      window: {
        HerdrCodeMirror: {
          create() { return { getValue() { return "abc"; }, setValue() {}, destroy() {} }; },
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
  });

  it("enables replace controls only for editable fallback editors", async () => {
    const html = await createFallbackEditor({ readonly: false });
    assert.match(html, /<textarea/);
    assert.match(html, /herdr-editor-find/);
    assert.doesNotMatch(html, /herdr-editor-replace-query[^>]*disabled/);
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

describe("desktop file browser editor integration", () => {
  class FakeElement {
    constructor(document, tag = "div") {
      this.ownerDocument = document;
      this.tag = tag;
      this.children = [];
      this.parentNode = null;
      this.className = "";
      this.style = {};
      this.scrollTop = 0;
      this.value = "";
      this._id = "";
      this._innerHTML = "";
    }
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
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) this.ownerDocument.nodes.set(child.id, child);
      return child;
    }
    remove() {
      if (this.id) this.ownerDocument.nodes.delete(this.id);
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
      querySelector() { return null; },
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

  it("mounts previews as read-only, edit as editable, and cancel as read-only", async () => {
    const document = createFakeDocument();
    const editorCalls = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: {
          create(opts) {
            editorCalls.push({ path: opts.path, content: opts.content, readonly: opts.readonly, lineNumbers: opts.lineNumbers });
            opts.parent.innerHTML = `<div class="cm-content cm-lineWrapping" contenteditable="${opts.readonly === false ? "true" : "false"}" data-language="python"></div>`;
            return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
          },
        },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserLineNumbers: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url) => ({
        ok: true,
        async json() {
          if (String(url).startsWith("/api/file-browser/file")) return { path: "src/demo.py", content: "print('x')", binary: false, truncated: false };
          return { path: "", entries: [], git_status: null };
        },
      }),
      confirm: () => true,
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout,
      clearTimeout,
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    await context.window.HerdrFileBrowser.open({ cwd: "/repo" });
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/demo.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(editorCalls.at(-1).path, "src/demo.py");
    assert.equal(editorCalls.at(-1).readonly, true);
    assert.equal(editorCalls.at(-1).lineNumbers, true);
    assert.match(document.getElementById(editorCalls.at(-1).path ? "fileBrowserPanel" : "").innerHTML, /Edit/);

    context.window.HerdrFileBrowser.edit(encodeURIComponent("src/demo.py"));
    assert.equal(editorCalls.at(-1).readonly, false);
    assert.equal(editorCalls.at(-1).content, "print('x')");
    assert.match(document.getElementById("fileBrowserPanel").innerHTML, /Save/);

    context.window.HerdrFileBrowser.cancelEdit(encodeURIComponent("src/demo.py"));
    assert.equal(editorCalls.at(-1).readonly, true);
    assert.equal(editorCalls.at(-1).content, "print('x')");
    assert.match(document.getElementById("fileBrowserPanel").innerHTML, /Edit/);
  });

  it("keeps editing draft per workspace, then forgets closed workspace state", async () => {
    const document = createFakeDocument();
    const editorCalls = [];
    const requests = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: {
          create(opts) {
            editorCalls.push({ path: opts.path, content: opts.content, readonly: opts.readonly, lineNumbers: opts.lineNumbers, onChange: opts.onChange, toggledFind: false });
            opts.parent.innerHTML = `<div class="cm-content cm-lineWrapping" contenteditable="${opts.readonly === false ? "true" : "false"}"></div>`;
            opts.parent._herdrEditorApi = { toggleFind() { editorCalls.at(-1).toggledFind = true; } };
            return { getValue() { return opts.content; }, setValue() {}, destroy() {} };
          },
        },
        HerdrGitUi: { hide() {} },
        HerdrWorkspacePath(workspace) { return workspace.cwd; },
      },
      document,
      localStorage: { getItem() { return JSON.stringify({ fileBrowserLineNumbers: true, fileBrowserGitStatus: false }); } },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async (url) => {
        const text = String(url);
        requests.push(text);
        return {
          ok: true,
          async json() {
            if (text.startsWith("/api/file-browser/file")) {
              const cwd = decodeURIComponent((text.match(/cwd=([^&]+)/) || [null, ""])[1]);
              const path = decodeURIComponent((text.match(/path=([^&]+)/) || [null, ""])[1]);
              return { path, content: cwd === "/Users/me/repo-a" ? "print('a')" : "print('b')", binary: false, truncated: false };
            }
            if (text.includes("q=")) {
              return { root: decodeURIComponent((text.match(/cwd=([^&]+)/) || [null, ""])[1]), home: "/Users/me", path: "", entries: [{ kind: "file", name: "demo.py", path: "src/demo.py", level: 1 }], git_status: null, truncated: false };
            }
            const cwd = decodeURIComponent((text.match(/cwd=([^&]+)/) || [null, ""])[1]);
            return { root: cwd, home: "/Users/me", path: "", entries: [{ kind: "dir", name: "src", path: "src" }], git_status: null };
          },
        };
      },
      confirm: () => true,
      appRefreshIconButton: () => "<button>Refresh</button>",
      encodeURIComponent,
      decodeURIComponent,
      Error,
      JSON,
      Math,
      String,
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.runInNewContext(readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8"), context);
    vm.runInNewContext(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), context);

    const workspaceA = { workspace_id: "ws-a", cwd: "/Users/me/repo-a" };
    const workspaceB = { workspace_id: "ws-b", cwd: "/opt/repo-b" };

    await context.window.HerdrFileBrowser.open(workspaceA);
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/demo.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.window.HerdrFileBrowser.edit(encodeURIComponent("src/demo.py"));
    editorCalls.at(-1).onChange("print('draft-a')");
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/other.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.window.HerdrFileBrowser.focusFile(encodeURIComponent("src/demo.py"));

    await context.window.HerdrFileBrowser.open(workspaceB);
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/demo.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/other.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(document.getElementById("fileBrowserPanel").innerHTML, /title="\/opt\/repo-b\/src\/demo\.py"/);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /print\('draft-a'\)/);

    await context.window.HerdrFileBrowser.open(workspaceA);
    const restoredPanel = document.getElementById("fileBrowserPanel").innerHTML;
    assert.doesNotMatch(restoredPanel, /file-browser-pane-head/);
    assert.doesNotMatch(restoredPanel, /file-browser-pane-search/);
    assert.match(restoredPanel, /title="~\/repo-a\/src\/demo\.py"/);
    assert.match(restoredPanel, /<span class="file-browser-toolbar-actions">[\s\S]*HerdrFileBrowser\.toggleFind\('src%2Fdemo\.py'\)/);
    assert.doesNotMatch(restoredPanel, /HerdrSearchPalette\.open/);
    context.window.HerdrFileBrowser.toggleFind(encodeURIComponent("src/demo.py"));
    assert.equal(editorCalls.at(-1).toggledFind, true);
    assert.equal(editorCalls.at(-1).path, "src/demo.py");
    assert.equal(editorCalls.at(-1).readonly, false);
    assert.equal(editorCalls.at(-1).content, "print('draft-a')");

    context.window.HerdrFileBrowser.forgetWorkspace(workspaceA);
    await context.window.HerdrFileBrowser.open(workspaceA);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /print\('draft-a'\)/);
  });
});
