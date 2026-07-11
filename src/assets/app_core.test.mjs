import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

    assert.match(html, /herdr-tree-icon-folder-src/);
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
  });

  it("can hide line numbers in fallback previews after CodeMirror load failure", async () => {
    const html = await createFallbackEditor({ lineNumbers: false });
    assert.doesNotMatch(html, /herdr-editor-numbered-code/);
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
      addEventListener() {},
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

  it("keeps search and editing draft per workspace, then forgets closed workspace state", async () => {
    const document = createFakeDocument();
    const editorCalls = [];
    const requests = [];
    const context = {
      window: {
        addEventListener() {},
        HerdrEditor: {
          create(opts) {
            editorCalls.push({ path: opts.path, content: opts.content, readonly: opts.readonly, lineNumbers: opts.lineNumbers, onChange: opts.onChange });
            opts.parent.innerHTML = `<div class="cm-content cm-lineWrapping" contenteditable="${opts.readonly === false ? "true" : "false"}"></div>`;
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
              return { path, content: cwd === "/repo-a" ? "print('a')" : "print('b')", binary: false, truncated: false };
            }
            if (text.includes("q=")) {
              return { path: "", entries: [{ kind: "file", name: "demo.py", path: "src/demo.py", level: 1 }], git_status: null, truncated: false };
            }
            return { path: "", entries: [{ kind: "dir", name: "src", path: "src" }], git_status: null };
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

    const workspaceA = { workspace_id: "ws-a", cwd: "/repo-a" };
    const workspaceB = { workspace_id: "ws-b", cwd: "/repo-b" };

    await context.window.HerdrFileBrowser.open(workspaceA);
    context.window.HerdrFileBrowser.filter("demo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.window.HerdrFileBrowser.select(encodeURIComponent("src/demo.py"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.window.HerdrFileBrowser.edit(encodeURIComponent("src/demo.py"));
    editorCalls.at(-1).onChange("print('draft-a')");

    await context.window.HerdrFileBrowser.open(workspaceB);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /value="demo"/);

    await context.window.HerdrFileBrowser.open(workspaceA);
    const restoredPanel = document.getElementById("fileBrowserPanel").innerHTML;
    assert.match(restoredPanel, /value="demo"/);
    assert.equal(editorCalls.at(-1).path, "src/demo.py");
    assert.equal(editorCalls.at(-1).readonly, false);
    assert.equal(editorCalls.at(-1).content, "print('draft-a')");
    assert.ok(requests.some((url) => url.includes("q=demo")));

    context.window.HerdrFileBrowser.forgetWorkspace(workspaceA);
    await context.window.HerdrFileBrowser.open(workspaceA);
    assert.doesNotMatch(document.getElementById("fileBrowserPanel").innerHTML, /value="demo"/);
  });
});
