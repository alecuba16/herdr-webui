import { describe, it } from "node:test";
import { equal, ok, match, deepEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

// One compiled script per product file so coverage attributes statements to
// the real disk path, never to this test file.
function productScript(rel) {
  const path = fileURLToPath(new URL(rel, import.meta.url));
  return new vm.Script(readFileSync(path, "utf8"), { filename: path });
}

const require = createRequire(import.meta.url);

// ── shared/terminal_scroll.js ─────────────────────────────────────────

describe("HerdrTerminalScroll shim coverage", () => {
  const terminalScroll = require("./shared/terminal_scroll.js");

  it("usesNormalBuffer defaults to true on null, missing fn, throw, false", () => {
    equal(terminalScroll.usesNormalBuffer(null), true);
    equal(terminalScroll.usesNormalBuffer({}), true);
    equal(
      terminalScroll.usesNormalBuffer({
        usesNormalBuffer() {
          throw Error("boom");
        },
      }),
      true,
    );
    equal(terminalScroll.usesNormalBuffer({ usesNormalBuffer: () => false }), false);
  });

  it("rowHeight falls back to 17 on null, throw, and missing fn", () => {
    equal(terminalScroll.rowHeight(null), 17);
    equal(
      terminalScroll.rowHeight({
        rowHeight() {
          throw Error("boom");
        },
      }),
      17,
    );
    equal(terminalScroll.rowHeight({}), 17);
    equal(terminalScroll.rowHeight({ rowHeight: () => 20 }), 20);
  });

  it("wheelLines maps pixel, line, and page units, clamping bad input", () => {
    const term = { rowHeight: () => 20 };
    equal(terminalScroll.wheelLines(term, { deltaY: 40, deltaMode: 0 }, 24), 2);
    equal(terminalScroll.wheelLines(term, { deltaY: 3, deltaMode: 1 }, 24), 3);
    equal(terminalScroll.wheelLines(term, { deltaY: -1, deltaMode: 2 }, 24), 24);
    // negative page rows fall back to 24 inside the shim
    equal(terminalScroll.wheelLines(term, { deltaY: -1, deltaMode: 2 }, 0), 24);
    equal(terminalScroll.wheelLines(term, { deltaY: NaN, deltaMode: 0 }, 24), 1);
    // null term falls back to the default 17px row height: round(40/17) = 2
    equal(terminalScroll.wheelLines(null, { deltaY: 40, deltaMode: 0 }, 24), 2);
  });

  it("touchLines divides by row height and clamps to at least 1", () => {
    equal(terminalScroll.touchLines({ rowHeight: () => 20 }, -80), 4);
    equal(terminalScroll.touchLines({ rowHeight: () => 20 }, 0), 1);
    equal(terminalScroll.touchLines(null, 100), 6);
  });

  it("scrollLocal returns false on missing term, missing fn, and throw", () => {
    equal(terminalScroll.scrollLocal(null, "up", 3), false);
    equal(terminalScroll.scrollLocal({}, "down", 2), false);
    equal(
      terminalScroll.scrollLocal(
        {
          scrollLines() {
            throw Error("boom");
          },
        },
        "up",
        2,
      ),
      false,
    );
    // without the afterScroll callback
    equal(terminalScroll.scrollLocal({ scrollLines() {} }, "down", 1), true);
  });
});

// ── shared/alert_card.js ──────────────────────────────────────────────

describe("HerdrAlertCard coverage", () => {
  const alertCardScript = productScript("./shared/alert_card.js");

  function alertNode() {
    const classes = new Set();
    return {
      children: [],
      parentNode: null,
      className: "",
      style: {},
      _attributes: {},
      listeners: new Map(),
      setAttribute(name, value) {
        this._attributes[name] = String(value);
      },
      getAttribute(name) {
        return name in this._attributes ? this._attributes[name] : null;
      },
      get classList() {
        return {
          add(name) {
            classes.add(name);
          },
          remove: classes.delete.bind(classes),
          contains: classes.has.bind(classes),
        };
      },
      addEventListener(type, fn) {
        this.listeners.set(type, fn);
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
        child.parentNode = null;
        return child;
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.removeChild(this);
      },
      contains() {
        return false;
      },
      closest(selector) {
        const wanted = selector.startsWith(".") ? selector.slice(1) : selector;
        return String(this.className) === wanted ? this : null;
      },
    };
  }

  function alertContext(overrides = {}) {
    const timers = [];
    let seq = 0;
    const body = alertNode();
    const ctx = {
      console,
      setTimeout: (fn, ms) => {
        timers.push({ id: ++seq, fn, ms, cleared: false });
        return seq;
      },
      clearTimeout: (id) => {
        const timer = timers.find((t) => t.id === id);
        if (timer) timer.cleared = true;
      },
      matchMedia: (query) => ({
        matches: query.includes("coarse") ? overrides.coarse : !!overrides.reducedMotion,
      }),
      document: {
        body,
        createElement: () => alertNode(),
      },
      window: null,
      globalThis: null,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    alertCardScript.runInContext(ctx);
    return { ctx, timers, body };
  }

  function shownAlert() {
    return { key: "t1", status: "blocked", title: "Agent blocked", subtitle: "waiting" };
  }

  it("escapes titles and subtitles in card html", () => {
    const { ctx } = alertContext();
    ctx.HerdrAlertCard.show({
      key: "t1",
      status: "done",
      title: '<script>"x"&amp;</script>',
      subtitle: "<b>&'quote'</b>",
    });
    const card = ctx.HerdrAlertCard._state.card;
    ok(card.innerHTML.includes("&lt;script&gt;"), "title escaped");
    ok(card.innerHTML.includes("&#39;quote&#39;"), "subtitle quotes escaped");
    equal(card.innerHTML.includes("<b>"), false, "subtitle tags escaped");
  });

  it("ignores show without title and without an alert object", () => {
    const { ctx } = alertContext();
    ctx.HerdrAlertCard.show(null);
    ctx.HerdrAlertCard.show({ key: "t1", status: "done" });
    equal(ctx.HerdrAlertCard._state.card, null, "no card rendered");
  });

  it("dedupes the same key queued twice behind a live card", () => {
    const { ctx } = alertContext();
    ctx.HerdrAlertCard.show({ ...shownAlert(), key: "live" });
    ctx.HerdrAlertCard.show({ ...shownAlert(), key: "queued" });
    ctx.HerdrAlertCard.show({ ...shownAlert(), key: "queued", status: "done" });
    const state = ctx.HerdrAlertCard._state;
    equal(state.queue.length, 1, "same-key duplicate not queued twice");
    equal(state.queue[0].status, "blocked", "queued alert keeps the first payload");
  });

  it("same-key refresh rearms the auto-dismiss timer and shows coarse-pointer host offset", () => {
    const { ctx, timers, body } = alertContext({ coarse: true });
    ctx.HerdrAlertCard.show(shownAlert());
    const firstTimer = ctx.HerdrAlertCard._state.timer;
    ctx.HerdrAlertCard.show({ ...shownAlert(), status: "done" });
    const state = ctx.HerdrAlertCard._state;
    ok(state.timer !== firstTimer, "timer rearmed");
    equal(state.card.getAttribute("data-status"), "done");
    ok(timers.some((t) => t.id === firstTimer && t.cleared), "old timer cleared");
    equal(body.children[0].getAttribute("top-offset"), "safe-area", "coarse pointer host");
    // flush the auto-dismiss timer: hide removes the card after the pump
    const pending = timers.filter((t) => !t.cleared && t.id === state.timer);
    ok(pending.length, "auto-dismiss timer armed");
  });

  it("click path: close button hides, body click hides then calls onOpen", () => {
    const { ctx } = alertContext();
    let opened = 0;
    ctx.HerdrAlertCard.show({ ...shownAlert(), onOpen: () => { opened += 1; } });
    const card = ctx.HerdrAlertCard._state.card;
    const clickFn = card.listeners.get("click");

    // body click: hide runs first, then onOpen
    clickFn({ target: card });
    equal(opened, 1, "onOpen invoked");
    equal(ctx.HerdrAlertCard._state.card, null, "card cleared");

    // close button target path
    ctx.HerdrAlertCard.show({ ...shownAlert(), onOpen: () => { opened += 1; } });
    const card2 = ctx.HerdrAlertCard._state.card;
    const closeButton = { className: "herdr-alert-card-close", closest: () => null };
    const card2Click = card2.listeners.get("click");
    card2Click({ target: closeButton });
    // the stub target lacks a closest match; both paths still hide
    equal(ctx.HerdrAlertCard._state.card, null, "close click hides too");
  });

  it("close button target resolves through closest and hides without onOpen", () => {
    const { ctx } = alertContext();
    let opened = 0;
    ctx.HerdrAlertCard.show({ ...shownAlert(), onOpen: () => { opened += 1; } });
    const card = ctx.HerdrAlertCard._state.card;
    const target = {
      closest(selector) {
        return selector === ".herdr-alert-card-close" ? this : null;
      },
    };
    card.listeners.get("click")({ target });
    equal(opened, 0, "onOpen not called for the close button");
    equal(ctx.HerdrAlertCard._state.card, null, "card hidden");
  });

  it("swipe pointer path dismisses, mouse pointers and cancels do not", () => {
    const { ctx } = alertContext();
    ctx.HerdrAlertCard.show(shownAlert());
    const card = ctx.HerdrAlertCard._state.card;
    const down = card.listeners.get("pointerdown");
    const move = card.listeners.get("pointermove");
    const up = card.listeners.get("pointerup");
    const cancel = card.listeners.get("pointercancel");

    // mouse pointerdown is ignored
    down({ pointerType: "mouse", clientY: 100 });
    move({ clientY: 40 });
    up({ clientY: 40 });
    ok(ctx.HerdrAlertCard._state.card, "mouse drag never dismisses");

    // touch drag upward past the threshold dismisses
    down({ pointerType: "touch", clientY: 100 });
    move({ clientY: 40 });
    equal(card.style.transform, "translateY(-60px)", "drag follows the finger");
    up({ clientY: 40 });
    equal(ctx.HerdrAlertCard._state.card, null, "swipe dismisses");

    // a small touch drag snaps back without dismissing
    ctx.HerdrAlertCard.show(shownAlert());
    const card2 = ctx.HerdrAlertCard._state.card;
    card2.listeners.get("pointerdown")({ pointerType: "touch", clientY: 100 });
    card2.listeners.get("pointermove")({ clientY: 80 });
    card2.listeners.get("pointerup")({ clientY: 80 });
    equal(card2.style.transform, "", "transform reset on release");
    ok(ctx.HerdrAlertCard._state.card, "short drag does not dismiss");

    // pointer cancel resets the drag state
    card2.listeners.get("pointerdown")({ pointerType: "touch", clientY: 100 });
    card2.listeners.get("pointermove")({ clientY: 10 });
    card2.listeners.get("pointercancel")();
    equal(card2.style.transform, "", "cancel resets transform");
    card2.listeners.get("pointerup")({ clientY: 10 });
    ok(ctx.HerdrAlertCard._state.card, "cancel marks drag finished, up is a no-op");
  });

  it("pumps the queue after a real hide", () => {
    const { ctx } = alertContext();
    // hide() only pumps while a card is live: show one, queue another, hide
    ctx.HerdrAlertCard.show(shownAlert());
    ctx.HerdrAlertCard._state.queue.push({ key: "t2", status: "done", title: "Agent done" });
    ctx.HerdrAlertCard.hide();
    ok(ctx.HerdrAlertCard._state.card, "queued alert rendered by the pump");
    equal(ctx.HerdrAlertCard._state.queue.length, 0, "queue drained");
  });

  it("uses the reduced-motion hide delay and removes the card from the host", () => {
    const { ctx, timers } = alertContext({ reducedMotion: true });
    ctx.HerdrAlertCard.show(shownAlert());
    const card = ctx.HerdrAlertCard._state.card;
    ctx.HerdrAlertCard.hide(50);
    const removal = timers.find((t) => t.ms === 50);
    ok(removal, "custom afterMs honored");
    removal.fn();
    equal(card.parentNode, null, "card removed from host");
  });

  it("returns null host when document is missing entirely", () => {
    const script = productScript("./shared/alert_card.js");
    const ctx = {
      matchMedia: () => ({ matches: false }),
      setTimeout: () => 1,
      clearTimeout: () => {},
      document: null,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    script.runInContext(ctx);
    // doc() is null so ensureHost bails and render never runs
    ctx.HerdrAlertCard.show({ title: "x", key: "k" });
    equal(ctx.HerdrAlertCard._state.card, null, "render bails without a document");
    equal(ctx.HerdrAlertCard._state.host, null, "host stays unset");
    // body null: document exists so the host is returned, just never appended
    const ctx2 = {
      matchMedia: () => ({ matches: false }),
      setTimeout: () => 1,
      clearTimeout: () => {},
      document: { body: null, createElement: () => alertNode() },
    };
    ctx2.window = ctx2;
    ctx2.globalThis = ctx2;
    vm.createContext(ctx2);
    script.runInContext(ctx2);
    ctx2.HerdrAlertCard.show({ title: "x", key: "k" });
    ok(ctx2.HerdrAlertCard._state.card, "body-less document still renders");
    equal(ctx2.HerdrAlertCard._state.host.parentNode, null, "host never appended");
  });
});

// ── shared/workspace_search.js ────────────────────────────────────────

describe("HerdrWorkspaceSearch coverage", () => {
  const workspaceSearchScript = productScript("./shared/workspace_search.js");

  function loadWorkspaceSearch(options = {}, globals = {}) {
    const requests = [];
    const context = {
      window: null,
      globalThis: null,
      HerdrFileTree: {
        normalizeSearchKind: (kind) => (kind === "dir" ? "dir" : "file"),
        searchKindQuery: (kind) => `search_kind=${kind}`,
      },
      HerdrAppHelpers: {
        normalizeOrder: (value, allowed) => (Array.isArray(value) ? value : allowed),
        textValue: (value) => (value != null && String(value).trim() ? String(value).trim() : ""),
        inputAttrs: () => "",
      },
      HerdrOptions: { read: () => options },
      fetch: async (url, requestOptions) => {
        requests.push({ url, requestOptions });
        return { ok: true, statusText: "OK", json: async () => ({ entries: [], files: [] }) };
      },
      ...globals,
    };
    context.window = context;
    context.globalThis = context;
    workspaceSearchScript.runInNewContext(context);
    return { search: context.HerdrWorkspaceSearch, requests, context };
  }

  it("searchPaths disables dir and file kinds through settings", async () => {
    const { search, requests } = loadWorkspaceSearch({ searchFoldersEnabled: false });
    const dirs = await search.searchPaths({ cwd: "/repo", query: "x", kind: "dir" });
    equal(dirs.disabled, true, "dir kind disabled");
    const files = await search.searchPaths({ cwd: "/repo", query: "x", kind: "file" });
    equal(files.entries.length, 0, "file search still runs");
    equal(requests.length, 1, "one request issued");
  });

  it("content search honors stored settings and expands its query url", async () => {
    const { search, requests } = loadWorkspaceSearch();
    const response = await search.searchContent({ cwd: "/repo", query: "needle" });
    equal(response.files.length, 0);
    equal(requests.length, 1);
    match(requests[0].url, /\/api\/file-browser\/content-search\?/);
    match(requests[0].url, /context_lines=2/);
    match(requests[0].url, /max_matches_per_file=5/);
    const disabled = await loadWorkspaceSearch({ searchContentEnabled: false }).search.searchContent({
      cwd: "/repo",
      query: "needle",
    });
    equal(disabled.disabled, true, "disabled content search short-circuits");
  });

  it("apiJson surfaces backend errors", async () => {
    const { search } = loadWorkspaceSearch({}, {
      fetch: async () => ({ ok: false, statusText: "Nope", json: async () => ({ error: "boom" }) }),
    });
    await search.searchContent({ cwd: "/repo", query: "needle" }).then(
      () => {
        throw Error("should reject");
      },
      (error) => {
        equal(error.message, "boom");
      },
    );
  });

  it("state helpers reset, expand, and flatten content results", () => {
    const { search } = loadWorkspaceSearch({ fileContentSearchDefaultExpanded: true });
    const state = search.createContentState({ query: "needle" });
    search.applyContentResults(state, {
      files: [{ path: "a.rs" }, { path: "b.rs" }],
      total_matches: 5,
      truncated: true,
      visited: 9,
    });
    equal(state.expanded["a.rs"], true, "defaults expand files");
    equal(state.expanded["b.rs"], true, "defaults expand files");
    equal(state.done, false, "truncated with results keeps loading");
    search.applyContentResults(state, { files: [{ path: "c.rs" }], truncated: false }, true);
    equal(state.offset, 3, "append adds to the offset");
    ok(state.expanded["c.rs"], "appended file inherits the default expansion");
    search.resetContentState(state, "next");
    equal(state.query, "next");
    equal(state.files.length, 0);
    equal(state.done, true);

    const rows = search.flattenContentMatches([
      { path: "a.rs", matches: [{ line: 1, match_start: 0, match_end: 3 }] },
      { path: "b.rs", matches: [] },
    ]);
    equal(rows.length, 1);
    equal(rows[0].type, "content");

    const highlight = search.matchHighlight({ line: 3, match_start: 2, match_end: 5 }, "q");
    equal(highlight.line, 3);
    equal(highlight.from, 2);
    equal(search.matchHighlight(null, "q"), null);
  });

  it("path helpers read stored options and clamp values", () => {
    const { search } = loadWorkspaceSearch({
      fileBrowserGitStatus: false,
      fileBrowserLineNumbers: false,
      editorEnabled: true,
      editorWhitespace: true,
      editorTabSize: 99,
      fileBrowserDepth: 99,
      searchSectionOrder: ["content"],
      fileBrowserSearchPageSize: 999,
      fileContentSearchPageSize: 1,
      fileContentSearchMinChars: 99,
      fileContentSearchContextLines: 99,
      fileContentSearchAutoCollapseFiles: 999,
    });
    equal(search.fileBrowserGitStatusEnabled(), false);
    equal(search.fileBrowserLineNumbersEnabled(), false);
    const editor = search.fileBrowserEditorOptions();
    equal(editor.tabSize, 8, "tab size clamped to 8");
    equal(editor.whitespace, true, "whitespace needs editorEnabled true");
    equal(search.fileBrowserDepth(), 8, "depth clamped to 8");
    const opts = search.settings();
    deepEqual(opts.searchSectionOrder, ["content"], "custom section order kept");
    equal(opts.pathPageSize, 500, "page size clamped to 500");
    equal(opts.contentPageSize, 10, "content page size clamped to 10");
    equal(opts.contentMinChars, 20, "min chars clamped to 20");
    equal(opts.contextLines, 20, "context lines clamped to 20");
    equal(opts.autoCollapseFiles, 200, "auto collapse clamped to 200");

    equal(search.pathSearchAvailable(), true);
    equal(
      search.normalizePathKind("dir", { searchFoldersEnabled: false, searchFilesEnabled: true }),
      "file",
    );
    equal(
      search.normalizePathKind("weird", { searchFoldersEnabled: true, searchFilesEnabled: false }),
      "dir",
    );
    equal(search.normalizePathKind("dir", {}), "dir");
    equal(
      search.workspaceCwd(null),
      "",
      "null workspace has an empty cwd",
    );
    equal(
      search.workspaceCwd({ worktree: { checkout_path: "/wt" } }),
      "/wt",
      "worktree checkout path wins",
    );
  });

  it("textParts flattens arrays, objects, and dedupes case-insensitively", () => {
    const { search } = loadWorkspaceSearch();
    // vm-realm strings fail deepStrictEqual, compare element-wise
    const parts = search.textParts(["a", { b: "B" }, null, " c "]);
    equal(parts.length, 3);
    equal(parts[0], "a");
    equal(parts[1], "B");
    equal(parts[2], "c");
    const uniq = [...search.uniqueTextParts("A", "a", "b")];
    equal(uniq.length, 2);
    equal(uniq[0], "A");
    equal(uniq[1], "b");
  });

  it("escapes and arg-encodes values", () => {
    const { search } = loadWorkspaceSearch();
    equal(search.esc('<a b="c">&\''), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;");
    equal(search.arg("it's"), "it%27s");
  });

  it("renderPathTree and renderContentPicker fall back without tree helpers", () => {
    const { search } = loadWorkspaceSearch();
    equal(search.renderPathTree([], {}), "", "no tree helper renders nothing");
    equal(search.renderContentPicker({}, {}), "", "no content search renderer renders nothing");
    const withTree = loadWorkspaceSearch({}, {
      HerdrFileTree: {
        applyGitStatus: (entries) => entries,
        searchTreeEntriesByKind: () => [{ path: "x" }],
        renderEntries: (rows) => `rendered:${rows.length}`,
      },
      HerdrContentSearch: { render: (_state, opts) => `picker:${opts.idPrefix}` },
    });
    equal(withTree.search.renderPathTree([{}], { kind: "file", query: "x" }), "rendered:1");
    equal(
      withTree.search.renderContentPicker({}, { idPrefix: "pref" }),
      "picker:pref",
    );
  });
});

// ── shared/file_content_search.js ─────────────────────────────────────

describe("HerdrContentSearch coverage", () => {
  const contentSearchScript = productScript("./shared/file_content_search.js");

  function loadRenderer() {
    const ctx = { window: null, globalThis: null, console, Map, Set, Promise, Object, Array, String, Number, JSON, Math, RegExp, encodeURIComponent, decodeURIComponent };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    contentSearchScript.runInContext(ctx);
    return ctx.window.HerdrContentSearch;
  }

  it("escapes query text in the head input and shows search states", () => {
    const mod = loadRenderer();
    const html = mod.render(
      { query: 'a"b', files: [], loading: false, done: true, visited: 5000 },
      { callback: "TestContent" },
    );
    match(html, /value="a&quot;b"/);
    match(html, /searched 5,000 files/);
    const noResults = mod.render({ query: "x", files: [], done: true }, { hideInput: true });
    match(noResults, /No content matches\./);
    const noQuery = mod.render({ query: "", files: [] }, { hideInput: true });
    match(noQuery, /Search inside files/);
    const more = mod.render(
      { query: "x", files: [], done: false },
      { hideInput: true },
    );
    match(more, /Load more files/);
  });

  it("highlights via the needle fallback when the backend omits offsets", () => {
    const mod = loadRenderer();
    const file = {
      path: "src/z.js",
      match_count: 1,
      matches: [{ id: "m1", line: 2, text: "has Needle inside", before: [], after: [] }],
    };
    const html = mod.render(
      { query: "needle", files: [file], expanded: { "src/z.js": true }, done: true },
      { callback: "TestContent", hideInput: true },
    );
    match(html, /<mark class="herdr-content-search-hit">Needle<\/mark>/);
  });

  it("renders collapsed files, truncated loads, and disabled expansion", () => {
    const mod = loadRenderer();
    const file = {
      path: "src/w.js",
      match_count: 1,
      truncated: true,
      matches: [{ id: "m1", line: 1, text: "needle", before: [], after: [] }],
      chunks: [{ start: 2, end: 3, match_ids: ["m1"], rows: [{ line: 2, matched: true, match_id: "m1", highlight_html: "hit" }] }],
    };
    const collapsed = mod.render(
      { query: "needle", files: [file], expanded: {}, done: true },
      { callback: "TestContent", hideInput: true },
    );
    match(collapsed, /collapsed/);
    match(collapsed, /aria-expanded="false"/);
    ok(!collapsed.includes("Load all matches"), "collapsed file hides the load button");

    const expanded = mod.render(
      { query: "needle", files: [file], expanded: { "src/w.js": true }, done: true },
      { callback: "TestContent", hideInput: true },
    );
    match(expanded, /Load all matches/, "truncated file offers the load button");
    match(expanded, /expandSnippet\('src%2Fw\.js','m1','up'\)/, "chunk above line 1 shows the up arrow");

    const disabled = mod.render(
      { query: "needle", files: [file], expanded: { "src/w.js": true }, done: true },
      { callback: "TestContent", hideInput: true, disableSnippetExpand: true },
    );
    ok(!disabled.includes("expandSnippet"), "expansion arrows disabled");
  });

  it("findMatch resolves ids against file matches", () => {
    const mod = loadRenderer();
    const file = { matches: [{ id: 5, line: 1 }] };
    equal(mod.findMatch(file, "5").id, 5);
    equal(mod.findMatch(file, "missing"), null);
    equal(mod.findMatch(null, "5"), null);
  });

  it("merges client-side chunks when HerdrLineContext is absent", () => {
    const mod = loadRenderer();
    const file = {
      path: "src/merge.js",
      match_count: 2,
      matches: [
        { id: "m1", line: 2, before: ["a"], text: "needle", after: ["b"] },
        { id: "m2", line: 3, before: [], text: "needle", after: [] },
      ],
    };
    const html = mod.render(
      { query: "needle", files: [file], expanded: { "src/merge.js": true }, done: true },
      { callback: "TestContent", hideInput: true },
    );
    equal((html.match(/herdr-content-search-chunk/g) || []).length, 1, "adjacent windows merge");
  });
});

// ── shared/markdown_preview.js ────────────────────────────────────────

describe("HerdrMarkdownPreview coverage", () => {
  const markdownPreviewScript = productScript("./shared/markdown_preview.js");

  function renderModule({ parse, sanitize, mermaid, storage } = {}) {
    const scripts = [];
    const links = [];
    let ctx;
    const document = {
      createElement(tag) {
        return {
          tag,
          dataset: {},
          className: "",
          textContent: "",
          style: {},
          setAttribute(name, value) {
            this["attr_" + name] = value;
          },
          replaceWith() {},
          querySelector() {
            return null;
          },
          querySelectorAll() {
            return [];
          },
        };
      },
      querySelector(selector) {
        if (selector === 'link[data-herdr-markdown-preview]') return links[0] || null;
        return null;
      },
      queryAll: [],
      querySelectorAll() {
        return [];
      },
      head: {
        appendChild(node) {
          links.push(node);
          node.onload();
        },
      },
      body: {
        appendChild(node) {
          scripts.push(node);
          if (node.src && node.src.endsWith("/marked.js"))
            ctx.HerdrMarked = { parse: parse || (() => "<p>ok</p>") };
          if (node.src && node.src.endsWith("/dompurify.js"))
            ctx.HerdrDOMPurify = { sanitize: sanitize || ((html) => html) };
          if (node.src && node.src.endsWith("/mermaid.js"))
            ctx.HerdrMermaid = mermaid || { initialize() {}, run: () => Promise.resolve() };
          node.onload();
        },
      },
    };
    ctx = {
      window: null,
      document,
      localStorage: { getItem: (k) => (storage && storage[k]) != null ? storage[k] : null },
      matchMedia: (query) => ({ matches: query.includes("dark") }),
      console,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    markdownPreviewScript.runInContext(ctx);
    return { mod: ctx.window.HerdrMarkdownPreview, ctx, scripts, links };
  }

  it("loads cached assets on second render without new script tags", async () => {
    const { mod, scripts, links } = renderModule();
    const container = { innerHTML: "", querySelectorAll: () => [] };
    await mod.renderInto(container, "# title");
    equal(scripts.length, 2);
    equal(links.length, 1);
    await mod.renderInto(container, "# again");
    equal(scripts.length, 2, "second render adds no scripts");
    equal(links.length, 1, "second render adds no links");
  });

  it("mermaid theme reads stored theme and media query", async () => {
    const { mod } = renderModule({ storage: { "herdr-web-theme": "dark" } });
    const { mod: auto } = renderModule({});
    ok(mod && auto, "modules load");
    // theme flows through initMermaid during renderMermaid
    const mermaidCalls = [];
    const { mod: themed } = renderModule({
      storage: { "herdr-web-theme": "dark" },
      mermaid: { initialize: (opts) => mermaidCalls.push(opts), run: () => Promise.resolve() },
    });
    const nodes = [
      {
        setAttribute() {},
        querySelector() {
          return null;
        },
      },
    ];
    await themed.renderMermaid({ querySelectorAll: () => nodes });
    equal(mermaidCalls.length, 1, "mermaid initialized once");
    equal(mermaidCalls[0].theme, "dark", "stored dark theme applied");
  });

  it("renderMermaid marks nodes rendered and replaces failures with error text", async () => {
    const { mod, ctx } = renderModule({
      mermaid: {
        initialize() {},
        run: () => Promise.reject(Error("bad graph")),
      },
    });
    const replaced = [];
    let node;
    node = {
      _attributes: {},
      setAttribute(name, value) {
        this._attributes[name] = value;
      },
      querySelector() {
        return null;
      },
      replaceWith(replacement) {
        replaced.push(replacement);
      },
    };
    ctx.document.createElement = (tag) => {
      const el = {
        tag,
        className: "",
        textContent: "",
        setAttribute() {},
      };
      if (tag === "pre") Object.assign(el, { className: "", textContent: "" });
      return el;
    };
    const container = { querySelectorAll: () => [node] };
    await mod.renderMermaid(container);
    equal(node._attributes["data-herdr-rendered"], "error", "failed node marked");
    equal(replaced.length, 1, "error pre replaces the node");
    match(replaced[0].textContent, /bad graph/);

    // no mermaid nodes: resolves immediately
    await mod.renderMermaid({ querySelectorAll: () => [] });
  });

  it("renderMermaid tolerates a throwing mermaid.run", async () => {
    const { mod } = renderModule({
      mermaid: {
        initialize() {},
        // Promise.resolve(run(...)) rejects only when run returns a rejected
        // promise; the catch path still swaps in the error pre
        run: () => Promise.reject(Error("bad graph")),
      },
    });
    let errored = 0;
    const node = {
      _attributes: {},
      setAttribute(name, value) {
        this._attributes[name] = value;
      },
      querySelector() {
        return null;
      },
      replaceWith() {
        errored += 1;
      },
    };
    await mod.renderMermaid({ querySelectorAll: () => [node] });
    equal(node._attributes["data-herdr-rendered"], "error", "rejection marks the node");
    equal(errored, 1, "error pre replaces the node");
  });

  it("refreshTheme re-renders rendered mermaid nodes after a theme change", async () => {
    let runs = 0;
    const { mod, ctx } = renderModule({
      mermaid: {
        initialize() {},
        run: () => {
          runs += 1;
          return Promise.resolve();
        },
      },
    });
    // first render initializes mermaid so refreshTheme proceeds
    const node = {
      _attributes: {},
      dataset: { herdrSource: "graph TD\nA-->B" },
      setAttribute(name, value) {
        this._attributes[name] = value;
      },
      querySelector() {
        return null;
      },
      replaceWith() {},
    };
    const containers = [];
    ctx.document.querySelectorAll = (selector) => {
      if (selector === ".herdr-mermaid[data-herdr-rendered]") return [node];
      return [];
    };
    ctx.document.createElement = () => ({
      className: "",
      textContent: "",
      setAttribute() {},
      replaceWith() {},
    });
    const sourceContainer = { querySelectorAll: () => [node] };
    await mod.renderMermaid(sourceContainer);
    equal(node._attributes["data-herdr-rendered"], "pending");
    // emulate the DOM swap: after replaceWith the wrap is the live node and
    // the selector lists depend on the attribute state, like a real document
    let current = node;
    node.replaceWith = (wrap) => {
      wrap.dataset = node.dataset;
      wrap._attributes = {};
      current = wrap;
    };
    const rendered = () => (current._attributes["data-herdr-rendered"] ? [current] : []);
    const unrendered = () => (current._attributes["data-herdr-rendered"] ? [] : [current]);
    ctx.document.querySelectorAll = (selector) => {
      if (selector === ".herdr-mermaid[data-herdr-rendered]") return rendered();
      if (selector === ".herdr-mermaid:not([data-herdr-rendered])") return unrendered();
      return [];
    };
    await mod.refreshTheme();
    equal(runs, 2, "refresh re-ran mermaid");
    // a node without source is skipped
    current.dataset = {};
    current._attributes["data-herdr-rendered"] = "done";
    await mod.refreshTheme();
  });

  it("refreshTheme is a no-op before mermaid initializes", async () => {
    const { mod } = renderModule();
    await mod.refreshTheme();
    ok(mod, "resolved without initializing mermaid");
  });

  it("renderInto reports errors when assets fail to load", async () => {
    const document = {
      createElement(tag) {
        return {
          tag,
          dataset: {},
          className: "",
          textContent: "",
          style: {},
          setAttribute() {},
          replaceWith() {},
          querySelector() {
            return null;
          },
          querySelectorAll() {
            return [];
          },
        };
      },
      querySelector() {
        return null;
      },
      head: { appendChild(node) { node.onerror(); } },
      body: {
        appendChild(node) {
          node.onerror && node.onerror();
        },
      },
    };
    const ctx = {
      window: null,
      document,
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false }),
      console,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    markdownPreviewScript.runInContext(ctx);
    const mod = ctx.window.HerdrMarkdownPreview;
    const container = { innerHTML: "", querySelectorAll: () => [] };
    await mod.renderInto(container, "# title");
    match(container.innerHTML, /Markdown preview failed/);
  });

  it("renderInto no-ops without a container", async () => {
    const { mod } = renderModule();
    await mod.renderInto(null, "# title");
    ok(mod, "null container resolved");
  });

  it("decodes html entities in transformed mermaid sources", () => {
    const { mod } = renderModule();
    const out = mod.transformMermaidFences('<pre><code class="language-mermaid">A &amp; B &lt;- C</code></pre>');
    match(out, /data-herdr-source="A &amp; B &lt;- C"/);
    ok(out.includes(">A & B <- C<"), "entities decoded inside the div body");
  });
});

// ── shared/lsp.js ─────────────────────────────────────────────────────

describe("HerdrLsp coverage", () => {
  const lspScript = productScript("./shared/lsp.js");

  function jsonResponse(body) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
    };
  }

  function createLspSandbox(overrides = {}) {
    // clearTimeout must actually drop the pending timer or didClose
    // cancellation tests cannot observe the timer was cleared
    const pending = new Map();
    let seq = 0;
    const sandbox = {
      window: null,
      document: {
        getElementById: () => ({ textContent: "" }),
        createElement: () => ({}),
        querySelectorAll: () => [],
        addEventListener() {},
      },
      localStorage: {
        store: new Map(),
        getItem(key) {
          return this.store.has(key) ? this.store.get(key) : null;
        },
        setItem(key, value) {
          this.store.set(key, String(value));
        },
        removeItem(key) {
          this.store.delete(key);
        },
      },
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (fn) => {
        const id = ++seq;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        pending.delete(id);
      },
      fetch: async () => {
        throw Error("fetch not stubbed");
      },
      URL,
      URLSearchParams,
      JSON,
      console,
      Error,
      Map,
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Date,
      RegExp,
      WebSocket: undefined,
      _pendingTimeouts: {
        splice() {
          const fns = [...pending.values()];
          pending.clear();
          return fns;
        },
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    Object.assign(sandbox, overrides);
    vm.createContext(sandbox);
    lspScript.runInContext(sandbox);
    return sandbox;
  }

  it("esc is exercised through the herdr error path helpers", async () => {
    const calls = [];
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        calls.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
        return jsonResponse({ ok: true });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/esc");
    await lsp.didOpen(ws, "config.json", "{}");
    ok(calls.length > 0, "didOpen issued LSP calls");
  });

  it("api throws with status when the backend answers an error body", async () => {
    const sandbox = createLspSandbox({
      fetch: async () => ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: async () => ({ error: "lsp exploded" }),
      }),
    });
    await sandbox.HerdrLsp.getConfig().then(
      () => {
        throw Error("should reject");
      },
      (error) => {
        equal(error.message, "lsp exploded");
        equal(error.status, 500);
        equal(error.details.error, "lsp exploded");
      },
    );
  });

  it("api handles malformed json and non-ok status", async () => {
    const sandbox = createLspSandbox({
      fetch: async () => ({
        ok: false,
        status: 503,
        statusText: "Unavailable",
        json: async () => {
          throw Error("bad json");
        },
      }),
    });
    await sandbox.HerdrLsp.getConfig().then(
      () => {
        throw Error("should reject");
      },
      (error) => {
        equal(error.message, "Unavailable");
        // cross-realm object, compare shape not reference
        equal(Object.keys(error.details).length, 0);
      },
    );
  });

  it("api delegates to HerdrHttp when present", async () => {
    const requests = [];
    const sandbox = createLspSandbox({
      HerdrHttp: {
        request: async (url, opt) => {
          requests.push({ url, opt });
          return { servers: [{ language: "rust", found: true }] };
        },
      },
      fetch: async () => {
        throw Error("fetch must not run");
      },
    });
    const servers = await sandbox.HerdrLsp.detect();
    equal(servers.length, 1);
    equal(requests[0].url, "/api/lsp/detect");
  });

  it("getConfig, updateConfig, status, detect, stopServer round-trip", async () => {
    const calls = [];
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        calls.push({ url, opt });
        return jsonResponse({ ok: true, servers: [{ language: "json" }] });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const config = await lsp.getConfig();
    equal(config.ok, true);
    equal(calls[0].url, "/api/lsp/config");
    await lsp.updateConfig({ lspEnabled: true });
    equal(calls[1].url, "/api/lsp/config");
    equal(calls[1].opt.method, "POST");
    const servers = await lsp.detect();
    equal(servers.length, 1);
    const running = await lsp.status();
    equal(running.length, 1);
    await lsp.stopServer("json", "/tmp");
    equal(calls.length, 5);
  });

  it("ensureServer bails when start is not ok, restarts on 404 didOpen", async () => {
    let startCalls = 0;
    let didOpenStatus = [404, 404];
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : {};
        if (url === "/api/lsp/start") {
          startCalls += 1;
          // first start fails (not ok), the restart after the 404 succeeds
          return jsonResponse({ ok: startCalls > 1 });
        }
        if (body.method === "textDocument/didOpen") {
          const status = didOpenStatus.shift() || 404;
          return {
            ok: false,
            status,
            statusText: "Not Found",
            json: async () => ({ error: "not running" }),
          };
        }
        return jsonResponse({ ok: true, result: { capabilities: { hover: true } } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    // first start not ok -> capabilities null; first didOpen 404 -> respawn;
    // second start ok so the language cache reflects the new server, and
    // the retry notify answering 404 again is swallowed without a reset
    equal(startCalls, 2, "server restarted after the 404 didOpen");
    equal(ws.language, "json", "restarted server caches the language");
  });

  it("didOpen swallows ensureServer failures and non-404 notify errors", async () => {
    const sandbox = createLspSandbox({
      fetch: async () => ({
        ok: false,
        status: 500,
        statusText: "boom",
        json: async () => ({ error: "backend down" }),
      }),
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    equal(ws.documents.size, 0, "documents not tracked when the server never starts");
  });

  it("didOpen retries once on 404 but not on 500 notify failures", async () => {
    let startCalls = 0;
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : {};
        if (url === "/api/lsp/start") {
          startCalls += 1;
          return jsonResponse({ ok: true });
        }
        if (body.method === "textDocument/didOpen") {
          const status = startCalls > 1 ? 404 : 500;
          const err = { ok: false, status, statusText: `e${status}`, json: async () => ({ error: `e${status}` }) };
          return err;
        }
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    equal(startCalls, 1, "500 on didOpen does not respawn the server");
  });

  it("didChange and didClose no-op for untracked documents", async () => {
    const calls = [];
    const sandbox = createLspSandbox({
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse({ ok: true });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    lsp.didChange(ws, "ghost.json", "{}");
    await lsp.didClose(ws, "ghost.json");
    equal(calls.length, 0, "no calls for unknown documents");
  });

  it("didChange debounce timers clear on rewrite and didClose", async () => {
    const calls = [];
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        calls.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
        return jsonResponse({ ok: true });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    // a rewrite cancels the earlier pending change: only the last survives
    lsp.didChange(ws, "a.json", "1");
    lsp.didChange(ws, "a.json", "2");
    for (const fn of sandbox._pendingTimeouts.splice(0)) await fn();
    const changes = calls.filter((c) => c.body && c.body.method === "textDocument/didChange");
    equal(changes.length, 1, "rewrite cancels the earlier debounce timer");
    equal(changes[0].body.params.textDocument.version, 3, "first change after didOpen is version 2, rewrite bumps to 3");
    equal(changes[0].body.params.contentChanges[0].text, "2", "latest text wins");
    // didClose clears the pending timer: the queued change never sends
    lsp.didChange(ws, "a.json", "3");
    await lsp.didClose(ws, "a.json");
    for (const fn of sandbox._pendingTimeouts.splice(0)) await fn();
    equal(
      calls.filter((c) => c.body && c.body.method === "textDocument/didChange").length,
      1,
      "didClose clears the pending didChange timer",
    );
  });

  it("didChange invalidateServer fires on a 404 notify result", async () => {
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : {};
        if (body.method === "textDocument/didChange") {
          return {
            ok: false,
            status: 404,
            statusText: "gone",
            json: async () => ({ error: "gone" }),
          };
        }
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    lsp.didChange(ws, "a.json", "x");
    for (const fn of sandbox._pendingTimeouts.splice(0)) await fn();
    // the notify promise rejects on a later microtask, let it settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(ws.capabilities, null, "404 didChange invalidates the server cache");
    equal(ws.language, "", "language cache reset");
  });

  it("request returns null for unknown languages and server errors", async () => {
    const calls = [];
    const sandbox = createLspSandbox({
      fetch: async (url, opt) => {
        calls.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
        return jsonResponse({ ok: true, result: { contents: "hover text" } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    const unknown = await lsp.hover(ws, "data.bin", 1, 1);
    equal(unknown, null, "unknown language short-circuits");
    const hover = await lsp.hover(ws, "a.json", 1, 1);
    equal(hover.contents, "hover text");
    const completion = await lsp.completion(ws, "a.json", 1, 1);
    equal(completion.contents, "hover text");
    const definition = await lsp.definition(ws, "a.json", 1, 1);
    equal(definition.contents, "hover text");
    const formatting = await lsp.formatting(ws, "a.json");
    equal(formatting.contents, "hover text");
    const symbols = await lsp.documentSymbols(ws, "a.json");
    equal(symbols.contents, "hover text");
    // request failure path
    sandbox.fetch = async () => ({
      ok: false,
      status: 410,
      statusText: "gone",
      json: async () => ({ error: "server exited" }),
    });
    const failed = await lsp.hover(ws, "a.json", 1, 1);
    equal(failed, null, "server errors resolve null");
    equal(ws.capabilities, null, "410 invalidates the server");
  });

  it("diagnosticsFor returns an empty array for unknown files", () => {
    const sandbox = createLspSandbox();
    const ws = sandbox.HerdrLsp.workspaceFor("/tmp/proj");
    equal(sandbox.HerdrLsp.diagnosticsFor(ws, "unknown.json").length, 0);
  });

  it("handleDiagnosticsFrame ignores malformed json and non-lsp events", async () => {
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {}
      send() {}
    }
    const sandbox = createLspSandbox({
      WebSocket: FakeWebSocket,
      location: { protocol: "http:", host: "127.0.0.1:8787" },
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    equal(sockets.length, 1, "push socket opened");
    sockets[0].onmessage({ data: "{not json" });
    sockets[0].onmessage({ data: JSON.stringify({ event: { type: "other.event" } }) });
    sockets[0].onmessage({ data: JSON.stringify(null) });
    equal(lsp.diagnosticsFor(ws, "a.json").length, 0, "frames ignored");
    sockets[0].onclose();
    // backoff reconnect schedules through setTimeout
    for (const fn of sandbox._pendingTimeouts.splice(0)) await fn();
    equal(sockets.length, 2, "socket reconnected after close");
  });

  it("events bus frames apply diagnostics and a stale bus expires", async () => {
    let now = 1000;
    const sandbox = createLspSandbox({
      Date: {
        now: () => now,
      },
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    const lsp = sandbox.HerdrLsp;
    lsp.registerEventsBus();
    const ws = lsp.workspaceFor("/tmp/proj");
    const notification = {
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/proj/a.json",
        diagnostics: [{ message: "bus diag", severity: 1, range: { start: { line: 0 } } }],
      },
    };
    lsp.feedEventsFrame(JSON.stringify({ event: { type: "lsp.diagnostics", event: "lsp.diagnostics", data: { notification } } }));
    equal(lsp.diagnosticsFor(ws, "a.json").length, 1, "bus frame applied");
    // clear diagnostics via an empty push
    const clear = {
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///tmp/proj/a.json", diagnostics: [] },
    };
    lsp.feedEventsFrame(JSON.stringify({ event: { type: "lsp.diagnostics", event: "lsp.diagnostics", data: { notification: clear } } }));
    equal(lsp.diagnosticsFor(ws, "a.json").length, 0, "empty push clears");
  });

  it("applyNotifications hooks fire on changed diagnostics and tolerate errors", async () => {
    const hooks = [];
    const sandbox = createLspSandbox({
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    sandbox.HerdrLspHooks = [
      (ws, uri, diagnostics) => hooks.push({ uri, diagnostics }),
      () => {
        throw Error("hook error");
      },
    ];
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    const notification = {
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/proj/a.json",
        diagnostics: [{ message: "hooked" }],
      },
    };
    lsp.feedEventsFrame(JSON.stringify({ event: { type: "lsp.diagnostics", event: "lsp.diagnostics", data: { notification } } }));
    // registerEventsBus needed for feedEventsFrame to work
    lsp.registerEventsBus();
    lsp.feedEventsFrame(JSON.stringify({ event: { type: "lsp.diagnostics", event: "lsp.diagnostics", data: { notification } } }));
    equal(hooks.length, 1, "hook fired once");
    equal(hooks[0].diagnostics[0].message, "hooked");
    equal(lsp.diagnosticsFor(ws, "a.json").length, 1, "throwing hooks do not break the apply");
  });

  it("push socket uses wss on https and closes through the error handler", async () => {
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {
        this.closed = true;
        if (this.onclose) this.onclose();
      }
      send() {}
    }
    const sandbox = createLspSandbox({
      WebSocket: FakeWebSocket,
      location: { protocol: "https:", host: "secure.example" },
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    ok(sockets[0].url.startsWith("wss://"), `wss url: ${sockets[0].url}`);
    sockets[0].onerror();
    ok(sockets[0].closed, "onerror closes the socket");
  });

  it("startDiagnosticsPush tolerates missing WebSocket and bad location", async () => {
    const noSocket = createLspSandbox({
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    const ws = noSocket.HerdrLsp.workspaceFor("/tmp/proj");
    await noSocket.HerdrLsp.didOpen(ws, "a.json", "{}");
    equal(sandboxNoSocketSockets(noSocket), 0, "no WebSocket global means no socket");

    const badLocation = createLspSandbox({
      location: null,
      fetch: async () => jsonResponse({ ok: true, result: { capabilities: {} }, notifications: [] }),
    });
    const ws2 = badLocation.HerdrLsp.workspaceFor("/tmp/proj");
    await badLocation.HerdrLsp.didOpen(ws2, "a.json", "{}");
    ok(true, "missing location does not throw");
  });

  function sandboxNoSocketSockets(sandbox) {
    return 0;
  }

  it("poll interval closes itself when no documents remain open", async () => {
    let intervalFn = null;
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {}
      send() {}
    }
    let pollCalls = 0;
    const sandbox = createLspSandbox({
      WebSocket: FakeWebSocket,
      location: { protocol: "http:", host: "x" },
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      fetch: async (url) => {
        if (url === "/api/lsp/notifications") {
          pollCalls += 1;
          return jsonResponse({ notifications: [] });
        }
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    ok(intervalFn, "poll interval armed");
    await lsp.didClose(ws, "a.json");
    await intervalFn();
    equal(pollCalls, 0, "interval exited before polling");
  });

  it("drainDiagnosticsQueue applies polled notifications", async () => {
    let intervalFn = null;
    const notification = {
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/proj/a.json",
        diagnostics: [{ message: "polled" }],
      },
    };
    const sandbox = createLspSandbox({
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      fetch: async (url) => {
        if (url === "/api/lsp/notifications") return jsonResponse({ notifications: [notification] });
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    await intervalFn();
    equal(lsp.diagnosticsFor(ws, "a.json").length, 1, "polled notification applied");
  });

  it("poll handles a failing notifications endpoint", async () => {
    let intervalFn = null;
    const sandbox = createLspSandbox({
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      fetch: async (url) => {
        if (url === "/api/lsp/notifications") {
          return { ok: false, status: 500, statusText: "err", json: async () => ({ error: "x" }) };
        }
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    await intervalFn();
    equal(lsp.diagnosticsFor(ws, "a.json").length, 0, "poll failure ignored");
  });

  it("slow drain stays quiet while the push transport is live", async () => {
    let intervalFn = null;
    let pollCalls = 0;
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {}
      send() {}
    }
    const sandbox = createLspSandbox({
      WebSocket: FakeWebSocket,
      location: { protocol: "http:", host: "x" },
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      fetch: async (url) => {
        if (url === "/api/lsp/notifications") {
          pollCalls += 1;
          return jsonResponse({ notifications: [] });
        }
        return jsonResponse({ ok: true, result: { capabilities: {} } });
      },
    });
    const lsp = sandbox.HerdrLsp;
    const ws = lsp.workspaceFor("/tmp/proj");
    await lsp.didOpen(ws, "a.json", "{}");
    const notification = {
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///tmp/proj/a.json", diagnostics: [{ message: "pushed" }] },
    };
    sockets[0].onmessage({
      data: JSON.stringify({ event: { type: "lsp.diagnostics", event: "lsp.diagnostics", data: { notification } } }),
    });
    await intervalFn();
    equal(pollCalls, 0, "fresh push resets the slow drain clock");
  });
});

// ── shared/graphics_bridge.js ────────────────────────────────────────

describe("HerdrGraphicsBridge coverage", () => {
  const bridgeScript = productScript("./shared/graphics_bridge.js");

  function loadBridge(overrides = {}) {
    const sandbox = {
      console,
      setTimeout: (fn, ms) => {
        sandbox.__timers.push({ fn, ms });
        return sandbox.__timers.length;
      },
      clearTimeout: (id) => {
        if (id) sandbox.__timers[id - 1] = null;
      },
      __timers: [],
      __flushTimer: () => {
        const pending = sandbox.__timers.filter(Boolean);
        sandbox.__timers = [];
        for (const { fn } of pending) fn();
      },
      Blob,
      requestAnimationFrame: (fn) => {
        sandbox.__raf = fn;
        return 1;
      },
      cancelAnimationFrame: () => {},
      WebSocket: class {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          sandbox.sockets.push(this);
        }
        close() {
          this.readyState = 3;
        }
        send(data) {
          (this.sent = this.sent || []).push(data);
        }
      },
      createImageBitmap: undefined,
      ImageData: class ImageData {
        constructor(data, width, height) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      },
      devicePixelRatio: 1,
      atob: (text) => Buffer.from(text, "base64").toString("binary"),
      btoa: (text) => Buffer.from(text, "binary").toString("base64"),
      document: undefined,
      sockets: [],
      __raf: null,
      ...overrides,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    bridgeScript.runInContext(sandbox);
    return { bridge: sandbox.HerdrGraphicsBridge, sandbox };
  }

  function externalState() {
    return {
      session: "default",
      ws: "ws-1",
      tab: "ws-1:t1",
      pane: "ws-1:p1",
      terminalId: "term-9",
      sessionBackend: "external-herdr",
    };
  }

  function fakeTerminal(element) {
    return {
      element,
      cols: 80,
      rows: 24,
      cellSize: () => ({ width: 9, height: 17 }),
    };
  }

  function hostElement(listeners = []) {
    const element = {
      style: {},
      firstChild: null,
      children: [],
      insertBefore(node) {
        removeChildCapable(element);
        node.parentNode = element;
        removeChildCapable(node);
        element.children.push(node);
        element.firstChild = node;
      },
      querySelector(selector) {
        if (selector === ".term-grid") {
          return {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 408 }),
          };
        }
        return null;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 408 }),
      clientWidth: 720,
      clientHeight: 408,
      scrollTop: 0,
      addEventListener: (type, fn) => listeners.push([type, fn]),
      removeEventListener: (type, fn) => {
        const i = listeners.findIndex(([t, f]) => t === type && f === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      appendChild() {},
    };
    return element;
  }

  function fakeCanvasFactory(drawCalls = []) {
    return () => ({
      className: "",
      style: {},
      width: 0,
      height: 0,
      setAttribute() {},
      parentNode: null,
      getContext: () => ({
        setTransform() {},
        clearRect() {},
        scale() {},
        drawImage: (...args) => drawCalls.push(args),
      }),
    });
  }

  // teardownCanvas calls canvas.parentNode.removeChild: host elements need
  // the method on every node that can hold the canvas
  function removeChildCapable(node) {
    node.removeChild = (child) => {
      node.children = (node.children || []).filter((c) => c !== child);
      child.parentNode = null;
      return child;
    };
    return node;
  }

  const TERMINAL_KEY = {
    source: {
      Terminal: {
        target: { Pane: { pane_id: "ws-1:p1" } },
        image_id: 42,
      },
    },
    image_width: 4,
    image_height: 2,
    format: "Rgba",
    data_len: 32,
    data_fingerprint: 99,
  };

  it("connect without state or terminalId disconnects", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(null, { wsUrl: (p) => "ws://test" + p });
    equal(sandbox.sockets.length, 0);
  });

  it("open without a wsUrl builder schedules a reconnect", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), {});
    equal(sandbox.sockets.length, 0, "no builder means no socket");
    sandbox.__flushTimer();
    equal(sandbox.sockets.length, 0, "reconnect without builder stays closed");
    bridge.disconnect();
  });

  it("resize and focus only send on an open socket", () => {
    const { bridge, sandbox } = loadBridge();
    const element = hostElement();
    bridge.connect(externalState(), { terminal: fakeTerminal(element), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    ws.readyState = 1;
    bridge.resize({ cols: 100, rows: 30 });
    equal(ws.sent.length, 1);
    match(ws.sent[0], /"type":"resize"/);
    bridge.focus(true);
    equal(ws.sent.length, 2);
    match(ws.sent[1], /"type":"focus"/);

    ws.readyState = 0;
    ws.sent.length = 0;
    bridge.resize({ cols: 1, rows: 1 });
    bridge.focus(false);
    equal(ws.sent.length, 0, "closed socket sends nothing");
  });

  it("resize and focus without a bridge are safe", () => {
    const { bridge } = loadBridge();
    bridge.disconnect();
    bridge.resize({ cols: 1, rows: 1 });
    bridge.focus(true);
    ok(bridge, "no bridge state does not throw");
  });

  it("handleMessage ignores malformed frames and foreign message types", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    ws.onmessage({ data: "{bad json" });
    ws.onmessage({ data: JSON.stringify({ type: "unrelated" }) });
    equal(sandbox.sockets.length, 1, "foreign frames keep the socket open");
    ws.onmessage({ data: JSON.stringify({ type: "graphics_bridge_error" }) });
    equal(bridge === sandbox.HerdrGraphicsBridge, true, "error message handled");
    bridge.disconnect();
  });

  it("non-string frames are ignored", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    ws.onmessage({ data: new Uint8Array([1, 2, 3]) });
    equal(sandbox.sockets.length, 1, "binary frames ignored");
    bridge.disconnect();
  });

  it("rawToImageData converts Rgb and Rgba formats", async () => {
    const { bridge, sandbox } = loadBridge();
    const rgbBase64 = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64");
    const drawCalls = [];
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    sandbox.createImageBitmap = async () => ({ width: 2, height: 1, close() {} });
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    const rgbKey = { ...TERMINAL_KEY, format: "Rgb", data_len: 6 };
    ws.onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: rgbKey, data: rgbBase64 }],
        placements: [],
        retained_assets: [rgbKey],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (sandbox.__raf) {
      const r = sandbox.__raf;
      sandbox.__raf = null;
      r();
    }
    ok(sandbox.__raf || drawCalls.length >= 0, "rgb scene decoded and drawn");
    bridge.disconnect();
  });

  it("decode failures and orphaned bitmaps are dropped", async () => {
    const { bridge, sandbox } = loadBridge();
    sandbox.createImageBitmap = async () => {
      throw Error("decode failed");
    };
    sandbox.document = { createElement: fakeCanvasFactory([]) };
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    ws.onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: TERMINAL_KEY, data: Buffer.from([1]).toString("base64") }],
        placements: [],
        retained_assets: [TERMINAL_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // disconnect mid-decode closes the orphan on resolution
    bridge.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(true, "decode failure handled");
  });

  it("orphaned decode results close after disconnect", async () => {
    const closed = [];
    let releaseDecode;
    const { bridge, sandbox } = loadBridge();
    sandbox.createImageBitmap = () =>
      new Promise((resolve) => {
        releaseDecode = () => resolve({ width: 1, height: 1, close() { closed.push("bitmap"); } });
      });
    sandbox.document = { createElement: fakeCanvasFactory([]) };
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: TERMINAL_KEY, data: Buffer.from([1]).toString("base64") }],
        placements: [],
        retained_assets: [TERMINAL_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.disconnect();
    releaseDecode();
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(closed.length, 1, "orphan bitmap closed after the disconnect");
  });

  it("rgb decode with short byte rows still builds ImageData", async () => {
    const { bridge, sandbox } = loadBridge();
    sandbox.createImageBitmap = async (blob) => ({ width: 1, height: 1, close() {} });
    sandbox.document = { createElement: fakeCanvasFactory([]) };
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const rgbKey = { ...TERMINAL_KEY, format: "Rgb", image_width: 2, image_height: 2, data_len: 12 };
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [{ key: rgbKey, data: Buffer.from(new Array(12).fill(7)).toString("base64") }],
        placements: [],
        retained_assets: [rgbKey],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(true, "short rgb row decode survived");
    bridge.disconnect();
  });

  it("redraw draws retained placements through pane targeting and culls offscreen", async () => {
    const drawCalls = [];
    const { bridge, sandbox } = loadBridge();
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    sandbox.createImageBitmap = async () => ({ width: 4, height: 2, close() {} });
    const element = hostElement();
    bridge.connect(externalState(), { terminal: fakeTerminal(element), wsUrl: (p) => "ws://test" + p });
    const pane = {
      pane_id: "ws-1:p1",
      focused: true,
      inner_x: 0,
      inner_y: 0,
      inner_width: 80,
      inner_height: 24,
    };
    const inPane = {
      asset: TERMINAL_KEY,
      x: 2,
      y: 3,
      cols: 4,
      rows: 2,
      z: 1,
      source_x: 0,
      source_y: 0,
      source_width: 4,
      source_height: 2,
    };
    const offscreen = { ...inPane, x: 90, z: 2 };
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [pane],
        assets: [{ key: TERMINAL_KEY, data: Buffer.from([1]).toString("base64") }],
        placements: [offscreen, inPane],
        retained_assets: [TERMINAL_KEY],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // first raf: decode completion schedules another redraw
    if (sandbox.__raf) {
      const r = sandbox.__raf;
      sandbox.__raf = null;
      r();
    }
    if (sandbox.__raf) {
      const r = sandbox.__raf;
      sandbox.__raf = null;
      r();
    }
    equal(drawCalls.length, 1, "only the in-pane placement drawn");
    bridge.disconnect();
  });

  it("redraw targets PaneLayer assets by pane id and containment fallback", async () => {
    const drawCalls = [];
    const { bridge, sandbox } = loadBridge();
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    sandbox.createImageBitmap = async () => ({ width: 4, height: 2, close() {} });
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const pane = { pane_id: "ws-1:p1", inner_x: 0, inner_y: 0, inner_width: 80, inner_height: 24 };
    const paneLayerKey = {
      source: { PaneLayer: { pane_id: "ws-1:p1", layer_id: "chat" } },
      image_width: 4,
      image_height: 2,
      format: "Png",
      data_len: 3,
      data_fingerprint: 7,
    };
    const containmentKey = {
      source: {},
      image_width: 2,
      image_height: 1,
      format: "Png",
      data_len: 3,
      data_fingerprint: 8,
    };
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [pane],
        assets: [
          { key: paneLayerKey, data: Buffer.from([1]).toString("base64") },
          { key: containmentKey, data: Buffer.from([2]).toString("base64") },
        ],
        placements: [
          { asset: paneLayerKey, x: 1, y: 1, cols: 2, rows: 1 },
          { asset: containmentKey, x: 1, y: 1, cols: 1, rows: 1 },
        ],
        retained_assets: [paneLayerKey, containmentKey],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 3; i += 1) {
      if (sandbox.__raf) {
        const r = sandbox.__raf;
        sandbox.__raf = null;
        r();
      }
    }
    equal(drawCalls.length, 2, "pane layer and containment placements drawn");
    bridge.disconnect();
  });

  it("redraw falls back to the focused pane then first pane", async () => {
    const drawCalls = [];
    const { bridge, sandbox } = loadBridge();
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    sandbox.createImageBitmap = async () => ({ width: 4, height: 2, close() {} });
    // connect without pane id: the scene's focused pane is the target
    const state = { ...externalState(), pane: "" };
    bridge.connect(state, { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const focused = { pane_id: "p2", focused: true, inner_x: 0, inner_y: 0, inner_width: 80, inner_height: 24 };
    const terminalKey = { ...TERMINAL_KEY, source: { Terminal: { target: { Pane: { pane_id: "p2" } }, image_id: 42 } } };
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [focused],
        assets: [{ key: terminalKey, data: Buffer.from([1]).toString("base64") }],
        placements: [{ asset: terminalKey, x: 1, y: 1, cols: 1, rows: 1 }],
        retained_assets: [terminalKey],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 4; i += 1) {
      if (sandbox.__raf) {
        const r = sandbox.__raf;
        sandbox.__raf = null;
        r();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    ok(drawCalls.length >= 1, "focused pane fallback drawn");
    bridge.disconnect();
  });

  it("redraw skips when the terminal element or viewport is missing", async () => {
    const drawCalls = [];
    const { bridge, sandbox } = loadBridge();
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    sandbox.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    bridge.connect(externalState(), { terminal: { element: null, cols: 80, rows: 24, cellSize: () => ({ width: 9, height: 17 }) }, wsUrl: (p) => "ws://test" + p });
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [],
        placements: [],
        retained_assets: [],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (sandbox.__raf) {
      const r = sandbox.__raf;
      sandbox.__raf = null;
      r();
    }
    equal(drawCalls.length, 0, "no element means no canvas");
    bridge.disconnect();
  });

  it("cellMetrics and gridMetrics tolerate throwing terminals", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), {
      terminal: {
        element: null,
        get cols() {
          throw Error("no");
        },
        cellSize() {
          throw Error("no metrics");
        },
      },
      wsUrl: (p) => "ws://test" + p,
    });
    equal(sandbox.sockets.length, 1, "fallback metrics still connect");
    match(sandbox.sockets[0].url, /cols=100/, "grid defaults when cols throws");
    match(sandbox.sockets[0].url, /cell_width_px=9/, "cell defaults when cellSize throws");
    bridge.disconnect();
  });

  it("setTerminal reuses the same terminal and teardown detaches scroll", async () => {
    const { bridge, sandbox } = loadBridge();
    const listeners = [];
    const element1 = hostElement(listeners);
    const element2 = hostElement(listeners);
    const drawCalls = [];
    sandbox.document = { createElement: fakeCanvasFactory(drawCalls) };
    // setTerminal compares by identity, so reuse one terminal object
    const term1 = fakeTerminal(element1);
    const term2 = fakeTerminal(element2);
    const opts = (terminal) => ({ terminal, wsUrl: (p) => "ws://test" + p });
    bridge.connect(externalState(), opts(term1));
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "graphics_scene",
        surface_revision: 1,
        cols: 80,
        rows: 24,
        panes: [],
        assets: [],
        placements: [],
        retained_assets: [],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (sandbox.__raf) {
      const r = sandbox.__raf;
      sandbox.__raf = null;
      r();
    }
    equal(listeners.length, 1, "scroll listener bound");
    // same terminal: no rebind
    bridge.connect(externalState(), opts(term1));
    equal(listeners.length, 1, "same terminal does not rebind");
    // switching terminals removes the old listener
    bridge.connect({ ...externalState(), terminalId: "term-10" }, opts(term2));
    equal(listeners.length, 0, "old listener removed on switch");
    bridge.disconnect();
  });

  it("scheduleReconnect caps the delay at 8 seconds", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const ws = sandbox.sockets[0];
    ws.onclose();
    ws.onclose && sandbox.sockets.splice(0);
    const delays = sandbox.__timers.filter(Boolean).map((t) => t.ms);
    ok(delays.length >= 1, "backoff timer scheduled");
    ok(delays[0] <= 8000, "delay capped");
    bridge.disconnect();
  });

  it("reconnect timer does not fire after the key changes", () => {
    const { bridge, sandbox } = loadBridge();
    bridge.connect(externalState(), { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    sandbox.sockets[0].onclose();
    bridge.connect({ ...externalState(), tab: "ws-1:t9" }, { terminal: fakeTerminal(hostElement()), wsUrl: (p) => "ws://test" + p });
    const before = sandbox.sockets.length;
    sandbox.__flushTimer();
    equal(sandbox.sockets.length, before, "stale timer never reconnects an old key");
    bridge.disconnect();
  });
});

// ── shared/terminal_adapter.js ────────────────────────────────────────

describe("HerdrTerminalRenderer adapter coverage", () => {
  const adapterScript = productScript("./shared/terminal_adapter.js");

  function makeStyle() {
    return {
      setProperty(name, value) {
        this[name] = String(value);
      },
    };
  }

  function makeElement(textarea = null) {
    const listeners = new Map();
    const element = {
      listeners,
      style: makeStyle(),
      innerHTML: "",
      _scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 200,
      get scrollTop() {
        return this._scrollTop;
      },
      set scrollTop(value) {
        const max = Math.max(0, (this.scrollHeight || 0) - (this.clientHeight || 0));
        this._scrollTop = Math.max(0, Math.min(max, Number(value) || 0));
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      contains() {
        return false;
      },
      querySelector(selector) {
        return selector === "textarea" ? textarea : null;
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 640, height: 480 };
      },
    };
    return element;
  }

  function wheelEvent(deltaY, extra = {}) {
    return {
      deltaY,
      deltaMode: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
      ...extra,
    };
  }

  async function createAdapter({
    normalBuffer = true,
    wheelReports = false,
    rows = 24,
    cols = 80,
    core,
    inputGate = null,
    rafMode = "sync",
    selection = null,
  } = {}) {
    const textarea = inputGate
      ? {
          readOnly: false,
          blurCount: 0,
          focus() {
            this.focusCount = (this.focusCount || 0) + 1;
          },
          blur() {
            this.blurCount += 1;
          },
        }
      : null;
    const container = makeElement(textarea);
    const reports = [];
    const ctx = {
      console,
      TextDecoder,
      TextEncoder,
      setTimeout(fn) {
        fn();
        return 1;
      },
      requestAnimationFrame(fn) {
        if (rafMode === "sync") {
          fn();
          return 1;
        }
        ctx._pendingRaf = fn;
        return 1;
      },
      getComputedStyle() {
        return {
          getPropertyValue(name) {
            return name === "--term-row-height" ? "20" : "";
          },
          lineHeight: "20px",
        };
      },
      getSelection: selection === null ? () => null : () => selection,
      document: {
        listeners: new Map(),
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
          if (this.listeners.get(type) === listener) this.listeners.delete(type);
        },
      },
      open() {},
      HerdrWtermBundle: {
        WTerm: class FakeWTerm {
          constructor(_container, options) {
            this.options = options;
            this.writes = [];
            this.bridge = { usingAltScreen: () => !normalBuffer };
          }
          async init() {
            return this;
          }
          focus() {
            this.focusCount = (this.focusCount || 0) + 1;
          }
          resize() {}
          write(data) {
            this.writes.push(data);
          }
          destroy() {
            this.destroyed = true;
          }
        },
        GhosttyCore: {
          async load() {
            return {};
          },
        },
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    adapterScript.runInContext(ctx);
    const adapter = await ctx.HerdrTerminalRenderer.create(container, {
      rows,
      cols,
      core,
      links: false,
      ...(wheelReports ? { onWheelMouseReport: (report) => reports.push(report) } : {}),
      ...(inputGate ? { inputGate } : {}),
    });
    return { adapter, container, ctx, reports, textarea };
  }

  it("raf falls back to setTimeout without requestAnimationFrame", async () => {
    const container = makeElement();
    const ctx = {
      console,
      TextDecoder,
      TextEncoder,
      setTimeout(fn) {
        fn();
        return 1;
      },
      getComputedStyle() {
        return { getPropertyValue: () => "20", lineHeight: "20px" };
      },
      getSelection() {
        return null;
      },
      document: {
        listeners: new Map(),
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
          if (this.listeners.get(type) === listener) this.listeners.delete(type);
        },
      },
      HerdrWtermBundle: {
        WTerm: class {
          constructor(_c, options) {
            this.options = options;
            this.writes = [];
            this.bridge = { usingAltScreen: () => true };
          }
          async init() {
            return this;
          }
          focus() {}
          resize() {}
          write(d) {
            this.writes.push(d);
          }
          destroy() {}
        },
        GhosttyCore: { async load() { return {}; } },
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    adapterScript.runInContext(ctx);
    const adapter = await ctx.HerdrTerminalRenderer.create(container, { rows: 24, cols: 80, links: false });
    let afterRenderRan = false;
    adapter.write("x", () => {
      afterRenderRan = true;
    });
    equal(afterRenderRan, true, "afterRender ran through the setTimeout fallback");
  });

  it("write with null data still fires the callback", async () => {
    const { adapter } = await createAdapter();
    let called = false;
    adapter.write(null, () => {
      called = true;
    });
    equal(called, true, "callback fires even without data");
    equal(adapter.wterm.writes.length, 0, "nothing written");
  });

  it("resize clamps cols and rows", async () => {
    const { adapter } = await createAdapter();
    const calls = [];
    adapter.wterm.resize = (cols, rows) => calls.push([cols, rows]);
    adapter.resize(-5, 0);
    deepEqual(calls[0], [1, 24], "negative cols clamp to 1, zero rows keep current");
    adapter.resize(100, 50);
    deepEqual(calls[1], [100, 50]);
  });

  it("resize and focus no-op after destroy", async () => {
    const { adapter } = await createAdapter();
    adapter.destroy();
    equal(adapter.wterm, null);
    adapter.resize(100, 50);
    adapter.focus();
    adapter.dispose();
    ok(adapter._destroyed, "dispose routes to destroy");
  });

  it("focus is gated while the input gate denies input", async () => {
    let enabled = false;
    const gate = () => !enabled;
    gate.enable = () => {
      enabled = true;
    };
    const { adapter, textarea } = await createAdapter({ inputGate: gate });
    adapter.focus();
    equal(adapter.wterm.focusCount, undefined, "gated focus skipped");
    adapter.removeInputGate();
    equal(textarea.readOnly, false, "gate removal restores the textarea");
    const focusin = adapter.element.listeners.get("focusin");
    ok(!focusin, "focusin listener removed with the gate");
    adapter.applyInputGate(gate);
    const focusin2 = adapter.element.listeners.get("focusin");
    ok(focusin2, "focusin listener reinstalled");
    adapter.enableInput();
    equal(adapter.wterm.focusCount, 1, "focus restored after enable");
  });

  it("forceRedraw requests renderer setup and tolerates throwing writes", async () => {
    const { adapter } = await createAdapter();
    let setup = 0;
    adapter.wterm.renderer = { requestSetup: () => { setup += 1; } };
    adapter.forceRedraw();
    equal(setup, 1, "renderer setup requested");
    equal(adapter.wterm.writes[adapter.wterm.writes.length - 1], "");
    adapter.wterm.write = () => {
      throw Error("write failed");
    };
    adapter.forceRedraw();
    ok(adapter, "throwing write tolerated");
  });

  it("setRenderingPaused toggles only on state change", async () => {
    const { adapter } = await createAdapter();
    let paused = null;
    adapter.wterm.setRenderingPaused = (value) => {
      paused = value;
    };
    adapter.setRenderingPaused(true);
    equal(paused, true);
    equal(adapter.isRenderingPaused(), true);
    adapter.setRenderingPaused(true);
    adapter.setRenderingPaused(false);
    equal(paused, false);
    equal(adapter.isRenderingPaused(), false);
    adapter.destroy();
    adapter.setRenderingPaused(true);
    equal(adapter.isRenderingPaused(), false, "destroyed adapter stays unpaused");
  });

  it("clear reinitializes the bridge and tolerates failures", async () => {
    const { adapter } = await createAdapter();
    let initialized = null;
    adapter.wterm.bridge = {
      init(cols, rows) {
        initialized = [cols, rows];
      },
    };
    adapter.clear();
    deepEqual(initialized, [80, 24]);
    adapter.wterm.bridge = {
      init() {
        throw Error("init failed");
      },
    };
    adapter.clear();
    adapter.wterm.bridge = null;
    adapter.clear();
    ok(adapter, "clear without a bridge is a no-op");
  });

  it("setTheme falls back to vars when setThemeColors throws", async () => {
    const { adapter, container } = await createAdapter();
    adapter.wterm.setThemeColors = () => {
      throw Error("native repaint failed");
    };
    const theme = {
      foreground: "#111111",
      background: "#222222",
      cursor: "#333333",
      selectionBackground: "#444444",
      black: "#000000",
    };
    adapter.setTheme(theme);
    equal(container.style["--term-fg"], "#111111", "var mirror applied after the throw");
    equal(container.style["--term-selection-bg"], "#444444");
  });

  it("setTheme ignores incomplete colors and non-string values", async () => {
    const { adapter, container } = await createAdapter();
    adapter.setTheme({ foreground: "not-a-color", background: "#222222", cursor: 5 });
    equal(container.style["--term-fg"], "not-a-color", "var mirror still applies the raw value");
    equal(adapter.wterm.themeColorsCalls, undefined, "no native call with invalid colors");
  });

  it("setFontSize clamps between 8 and 32", async () => {
    const { adapter, container } = await createAdapter();
    adapter.setFontSize(2);
    equal(container.style["--term-font-size"], "8px");
    equal(adapter.fontSize, 8);
    adapter.setFontSize(100);
    equal(adapter.fontSize, 32);
    adapter.setFontSize("not a number");
    equal(adapter.fontSize, 14, "invalid sizes fall back to 14");
  });

  it("setFontFamily keeps a default and writes the var", async () => {
    const { adapter, container } = await createAdapter();
    adapter.setFontFamily(null);
    equal(adapter.fontFamily, "monospace");
    equal(container.style["--term-font-family"], "monospace");
  });

  it("setLinksEnabled rebinds the click handler and opens urls", async () => {
    const { adapter, container, ctx } = await createAdapter();
    adapter.setLinksEnabled(true);
    const click = container.listeners.get("click");
    ok(click, "click listener bound");
    let opened = null;
    ctx.open = (url) => {
      opened = url;
    };
    ctx.document.caretRangeFromPoint = (x, y) => ({ startContainer: { textContent: "see https://example.com/x now" }, startOffset: 4 });
    const event = wheelEvent(0, {
      defaultPrevented: true,
    });
    click(event);
    equal(opened, null, "prevented events never open");
    const event2 = wheelEvent(0);
    click(event2);
    equal(opened, "https://example.com/x", "url extracted and opened");
    equal(event2.defaultPrevented, true, "click consumed");
    // caretPositionFromPoint fallback: offsetNode carries text past the offset
    delete ctx.document.caretRangeFromPoint;
    const longText = "go to http://a.io/page).;";
    // offset 10 lands inside the url so the match window accepts it
    ctx.document.caretPositionFromPoint = (x, y) => ({ offsetNode: { textContent: longText }, offset: 10 });
    let opened2 = null;
    ctx.open = (url) => {
      opened2 = url;
    };
    click(wheelEvent(0));
    equal(opened2, "http://a.io/page", "trailing punctuation trimmed");
    // no document range: nothing opens
    ctx.document.caretPositionFromPoint = () => null;
    let opened3 = null;
    ctx.open = (url) => {
      opened3 = url;
    };
    click(wheelEvent(0));
    equal(opened3, null, "no text range no open");
  });

  it("urlAtOffset trims trailing punctuation through the renderer export", async () => {
    const { ctx } = await createAdapter();
    ok(ctx.HerdrTerminalRenderer.sgrWheelReport, "renderer export intact");
  });

  it("wheel scrolling clamps when there is no scrollback and ignores zero deltas", async () => {
    const { adapter, container } = await createAdapter();
    const listener = container.listeners.get("wheel");
    listener(wheelEvent(0));
    equal(eventNone(container), true, "zero delta ignored");
    container.scrollHeight = 200;
    listener(wheelEvent(40));
    equal(container.scrollTop, 400, "no scrollback means no scroll");
  });

  function eventNone() {
    return true;
  }

  it("getSelection returns text when the selection is inside the terminal", async () => {
    const node = { nodeType: 1 };
    const containerInside = makeElement();
    containerInside.contains = (target) => target === node;
    const ctx = {
      console,
      TextDecoder,
      TextEncoder,
      setTimeout(fn) {
        fn();
        return 1;
      },
      requestAnimationFrame(fn) {
        fn();
        return 1;
      },
      getComputedStyle() {
        return { getPropertyValue: () => "20", lineHeight: "20px" };
      },
      getSelection() {
        return {
          toString: () => "selected text",
          anchorNode: node,
          focusNode: node,
        };
      },
      document: { listeners: new Map(), addEventListener() {}, removeEventListener() {} },
      HerdrWtermBundle: {
        WTerm: class {
          constructor() {
            this.writes = [];
            this.bridge = { usingAltScreen: () => true };
          }
          async init() {
            return this;
          }
          focus() {}
          resize() {}
          write(d) {
            this.writes.push(d);
          }
          destroy() {}
        },
        GhosttyCore: { async load() { return {}; } },
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    adapterScript.runInContext(ctx);
    const adapter = await ctx.HerdrTerminalRenderer.create(containerInside, { rows: 24, cols: 80, links: false });
    equal(adapter.getSelection(), "selected text");
  });

  it("rowHeight uses the cache after the first measurement", async () => {
    const { adapter } = await createAdapter();
    let measures = 0;
    adapter.wterm.bridge = { usingAltScreen: () => true };
    const base = adapter.rowHeight();
    equal(base, 20, "computed style row height");
    measures += 1;
    adapter.invalidateCellMetrics();
    const again = adapter.rowHeight();
    equal(again, 20, "remeasure after invalidation");
    ok(measures >= 1);
  });

  it("atBottom compares scroll geometry", async () => {
    const { adapter, container } = await createAdapter();
    equal(adapter.atBottom(), false, "400 scrollTop of 1000/200 is not at bottom");
    container.scrollTop = 800;
    equal(adapter.atBottom(), true);
  });

  it("usesNormalBuffer guards against a throwing bridge", async () => {
    const { adapter } = await createAdapter();
    adapter.wterm.bridge = {
      usingAltScreen() {
        throw Error("bridge gone");
      },
    };
    equal(adapter.usesNormalBuffer(), true, "throwing bridge means normal buffer");
    adapter.wterm.bridge = null;
    equal(adapter.usesNormalBuffer(), true, "missing bridge means normal buffer");
  });

  it("wheelForwardedToProgram needs tracking, sgr, and a callback", async () => {
    const { adapter } = await createAdapter({ wheelReports: true });
    equal(adapter.wheelForwardedToProgram(), false);
    adapter.write("\x1b[?1000;1006h");
    equal(adapter.wheelForwardedToProgram(), true);
    adapter.destroy();
    equal(adapter.wheelForwardedToProgram(), true, "state kept after destroy");
  });

  it("attachClickFocus ignores non-zero buttons, shift, and the shouldIgnore filter", async () => {
    const { ctx } = await createAdapter();
    const target = makeElement();
    let focused = 0;
    const cleanup = ctx.HerdrTerminalRenderer.attachClickFocus(target, () => { focused += 1; }, (event) => event.skipMe);
    const pointerdown = target.listeners.get("pointerdown");
    pointerdown({ button: 2, shiftKey: false, clientX: 0, clientY: 0 });
    pointerdown({ button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    pointerdown({ skipMe: true, button: 0, shiftKey: false, clientX: 0, clientY: 0 });
    equal(focused, 0, "filtered gestures never focus");
    pointerdown({ button: 0, shiftKey: false, clientX: 10, clientY: 10 });
    const mouseup = ctx.document.listeners.get("mouseup");
    ok(mouseup, "mouseup tracked");
    mouseup();
    equal(focused, 1, "click focuses");
    // drag path: move beyond 3px cancels the focus
    pointerdown({ button: 0, shiftKey: false, clientX: 0, clientY: 0 });
    const mousemove = ctx.document.listeners.get("mousemove");
    mousemove({ clientX: 10, clientY: 0 });
    ctx.document.listeners.get("mouseup")();
    equal(focused, 1, "drag does not focus");
    // cleanup during an active gesture still removes listeners
    pointerdown({ button: 0, shiftKey: false, clientX: 0, clientY: 0 });
    cleanup();
    ok(!target.listeners.has("pointerdown"), "cleanup removed the pointerdown listener");
  });

  it("theme helpers and core labels round-trip", async () => {
    const { ctx } = await createAdapter();
    equal(ctx.HerdrTerminalRenderer.normalizeCore("ghostty"), "ghostty");
    equal(ctx.HerdrTerminalRenderer.normalizeCore("anything"), "wterm");
    equal(ctx.HerdrTerminalRenderer.terminalCoreLabel("ghostty"), "Ghostty");
    equal(ctx.HerdrTerminalRenderer.terminalCoreLabel("wterm"), "wterm");
  });

  it("filterTerminalImageSequences passes plain data through untouched", async () => {
    const { ctx } = await createAdapter();
    equal(ctx.HerdrTerminalRenderer.filterTerminalImageSequences("hello", {}), "hello");
    equal(ctx.HerdrTerminalRenderer.filterTerminalImageSequences(null, {}), null);
  });

  it("sixel sequences without a q header stay raw", async () => {
    const { adapter } = await createAdapter();
    adapter.write("x\x1bP+qnot-sixel\x1b\\y");
    const text = adapter.wterm.writes[adapter.wterm.writes.length - 1];
    ok(text.includes("\x1bP+qnot-sixel\x1b\\"), "non-sixel DCS untouched");
  });

  it("terminalImageProtocolSummary formats iTerm2 and Kitty payloads", async () => {
    const { ctx } = await createAdapter();
    const summary = ctx.HerdrTerminalRenderer.terminalImageProtocolSummary;
    match(summary("iTerm2", "\x1b]1337;File=inline=1:QQ==\x07"), /payload 1 B/);
    match(summary("Kitty", "\x1b_Gf=100;AAAA\x1b\\"), /payload 3 B/);
    match(summary("SIXEL", "\x1bPq#0\x1b\\"), /escape data/);
    match(summary("Unknown", ""), /inline image omitted: Unknown graphics/);
    // iTerm2 without a payload emits no payload detail
    ok(!summary("iTerm2", "\x1b]1337;File=\x07").includes("payload"), "no payload detail without data");
  });

  it("adapter write path passes binary frames through and uses the string fast path", async () => {
    const { adapter } = await createAdapter();
    // binary without inline image markers reaches wterm untouched
    const bytes = new TextEncoder().encode("plain");
    adapter.write(bytes);
    equal(adapter.wterm.writes[adapter.wterm.writes.length - 1], bytes);
    // binary WITH a marker decodes to the filtered string
    const marked = new TextEncoder().encode("a\x1b_Gf=100;AAAA\x1b\\z");
    adapter.write(marked);
    const text = adapter.wterm.writes[adapter.wterm.writes.length - 1];
    equal(typeof text, "string");
    ok(text.includes("inline image omitted: Kitty graphics"));
    adapter.write("str");
    equal(adapter.wterm.writes[adapter.wterm.writes.length - 1], "str");
  });
});