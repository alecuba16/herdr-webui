import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// One compiled script per product file so coverage attributes each file's
// lines to its real disk path; scripts are built once and memoized.
function productScript(relPath) {
  productScript.cache = productScript.cache || new Map();
  if (!productScript.cache.has(relPath)) {
    const realPath = fileURLToPath(new URL(relPath, import.meta.url));
    productScript.cache.set(
      relPath,
      new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath }),
    );
  }
  return productScript.cache.get(relPath);
}

// Behavioral tests for the two-commit compare UX: pair arming with
// shift-click, plain-click compare, per-file collapse with the threshold
// setting, and the jump controls/keys. The vm boots the same source set the
// server concatenates for the git-ui bundle.

function element() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    value: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    removeChild() {},
    remove() {},
    replaceWith() {},
    insertBefore() {},
    after() {},
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

function context(fetchImpl) {
  const localStorage = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    inputAttrs: null,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    TextEncoder,
    URL,
    TextDecoder,
    encodeURIComponent,
    decodeURIComponent,
    fetch: fetchImpl,
    alert() {},
    prompt: () => null,
    confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      title: "",
      body: element(),
      documentElement: element(),
      hidden: false,
      visibilityState: "visible",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: (selector) => (
        selector === ".location-bar-branch-popover" || selector === ".location-bar-worktree-popover" || selector === ".location-bar-discovery-popover"
          ? null
          : element()
      ),
      querySelectorAll: () => [],
      __panelHtml: "",
      getElementById(id) {
        const el = element();
        if (id === "gitUiPanel") {
          Object.defineProperty(el, "innerHTML", {
            get() { return ctx.document.__panelHtml; },
            set(value) { ctx.document.__panelHtml = String(value); },
          });
        }
        return el;
      },
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    window: null,
    globalThis: null,
    WebSocket: class {},
    __keydownListeners: [],
    addEventListener(type, handler) {
      if (type === "keydown") ctx.__keydownListeners.push(handler);
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const GIT_UI_SOURCE = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
const ASSETS_RS = readFileSync(new URL("../../src/assets.rs", import.meta.url), "utf8");
const CONCAT_START = ASSETS_RS.indexOf("const DESKTOP_GIT_UI_JS: &str = concat!(");
assert.ok(CONCAT_START !== -1, "assets.rs still defines the DESKTOP_GIT_UI_JS concat");
const CONCAT_BODY = ASSETS_RS.slice(CONCAT_START, ASSETS_RS.indexOf(");", CONCAT_START));
const GIT_UI_BUNDLE_FILES = [...CONCAT_BODY.matchAll(/include_str!\("([^"]+)"\)/g)]
  .map((m) => "./" + m[1].replace("assets/desktop/", "desktop/"))
  .filter((path) => path !== "./desktop/git_ui.js");
const CORE_SOURCE = readFileSync(new URL("./shared/core.js", import.meta.url), "utf8");
const SHARED_SOURCE_FILES = [
  "./shared/actions.js",
  "./shared/backend_state.js",
  "./shared/http.js",
  "./shared/file_icons.js",
  "./shared/file_tree.js",
  "./shared/line_context.js",
  "./shared/file_content_search.js",
  "./shared/workspace_search.js",
  ...GIT_UI_BUNDLE_FILES,
];
let sharedScripts = null;
function getSharedScripts() {
  if (!sharedScripts) {
    sharedScripts = SHARED_SOURCE_FILES.map((path) => productScript(path));
  }
  return sharedScripts;
}
const APP_STUBS = `
function appRefreshIconButton() { return ""; }
`;

async function bootGitUi(responses) {
  const calls = [];
  const railStatusHandler = () => (params, init) => {
    const body = JSON.parse((init && init.body) || "{}");
    const items = ((body.workspaces || []).map((w) => ({
      workspace_id: w.workspace_id || null,
      cwd: w.cwd,
      state: "clean",
    })));
    return { items };
  };
  const fetchImpl = async (url, init) => {
    const raw = String(url);
    const path = raw.split("?")[0];
    const params = new URLSearchParams(raw.split("?")[1] || "");
    calls.push({ path, params, raw, init });
    let handler = responses[path];
    if (!handler && path === "/api/git-ui/rail-status") handler = railStatusHandler();
    if (handler) {
      const body = typeof handler === "function" ? handler(params, init) : handler;
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const ctx = context(fetchImpl);
  productScript("./shared/core.js").runInContext(ctx);
  vm.runInContext("inputAttrs = globalThis.HerdrAppHelpers.inputAttrs", ctx);
  for (const script of getSharedScripts()) script.runInContext(ctx);
  vm.runInContext(APP_STUBS, ctx);
  productScript("./desktop/git_ui.js").runInContext(ctx);
  const ui = ctx.window.HerdrGitUi;
  return { ui, ctx, calls };
}

function dispatchKeydown(ctx, key, extra = {}) {
  const event = Object.assign({
    key,
    target: { closest: () => null, id: "" },
    stopPropagation() {},
    stopImmediatePropagation() {},
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  }, extra);
  for (const handler of ctx.__keydownListeners) handler(event);
  return event;
}

const NEW = "cccccccccccccccccccccccccccccccccccccccc";
const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function emptyStatus() {
  return { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] };
}

// A compare payload with one small file and one huge file: lines are plain
// chunk lines so diffFileLineCount counts them, and rows come back empty so
// rowsFromChunk derives pairs from chunk.lines for both layouts.
function compareFiles(options = {}) {
  const bigLines = [];
  for (let i = 0; i < (options.bigLineCount ?? 600); i++) {
    bigLines.push({ line_type: i % 3 === 0 ? "add" : "normal", content: `line ${i}`, old_line_number: i + 1, new_line_number: i + 1 });
  }
  const smallLines = [
    { line_type: "normal", content: "keep", old_line_number: 1, new_line_number: 1 },
    { line_type: "delete", content: "old", old_line_number: 2 },
    { line_type: "add", content: "new", new_line_number: 2 },
  ];
  return {
    files: [
      { path: "src/big.rs", status: "modified", additions: 200, deletions: 0, chunks: [{ header: "@@ -1,600 +1,600 @@", old_start: 1, old_lines: 600, new_start: 1, new_lines: 600, lines: bigLines, rows: [] }] },
      { path: "src/small.js", status: "modified", additions: 1, deletions: 1, chunks: [{ header: "@@ -1,3 +1,3 @@", old_start: 1, old_lines: 3, new_start: 1, new_lines: 3, lines: smallLines, rows: [] }] },
    ],
  };
}

function logResponse() {
  return {
    commits: [{ hash: NEW }, { hash: OLD }],
    lines: [],
    rows: [
      { hash: NEW, graph: "*", title: "newest", labels: [], date: "2026-01-02", author: "A" },
      { hash: OLD, graph: "*", title: "oldest", labels: [], date: "2026-01-01", author: "B" },
    ],
    has_more: false,
    limit: 80,
  };
}

async function bootCompare(options = {}) {
  const booted = await bootGitUi({
    "/api/git-ui/status": emptyStatus(),
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": options.compare ?? compareFiles(),
    "/api/git-ui/log": logResponse(),
  });
  if (options.options) {
    // The harness loads no shared/options.js; primitives read
    // window.HerdrOptions lazily, so the stub lands in time for the
    // collapse seeding at compare fetch.
    booted.ctx.window.HerdrOptions = { read: () => options.options };
  }
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  return booted;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function lastCompareCall(calls) {
  const compare = calls.filter((call) => call.path === "/api/git-ui/compare");
  return compare[compare.length - 1] || null;
}

function ctxHtml(booted) {
  return (booted.ctx.document.__panelHtml || "");
}

test("plain click on an armed pair row compares the two commits", async () => {
  const booted = await bootCompare();
  const { ui, calls } = booted;
  ui.tab("log");
  await settle();
  // Arm the pair: shift-click both commits.
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  const before = calls.length;
  // Plain left click on either armed row opens the comparison.
  ui.selectLogCommit({ shiftKey: false }, NEW);
  await settle();
  const call = lastCompareCall(calls.slice(before));
  assert.ok(call, "clicking an armed row fired the compare fetch");
  assert.equal(call.params.get("base"), OLD, "oldest commit is the base");
  assert.equal(call.params.get("target"), NEW, "newest commit is the target");
});

test("pair compare button arms after two shift-clicks and compares ordered", async () => {
  const booted = await bootCompare();
  const { ui, calls } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, NEW);
  ui.selectLogCommit({ shiftKey: true }, OLD);
  await ui.compareSelectedLog();
  await settle();
  const call = lastCompareCall(calls);
  assert.ok(call, "compare fetch fired");
  assert.equal(call.params.get("base"), OLD, "log position orders the pair: oldest is base");
  assert.equal(call.params.get("target"), NEW, "newest is target");
});

test("compare view renders jump controls and per-file sections", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const html = ctxHtml(booted);
  assert.match(html, /git-ui-compare-jump/, "jump control group renders");
  assert.match(html, /aria-label="Next change"/, "next change jump button");
  assert.match(html, /aria-label="Next file"/, "next file jump button");
  assert.match(html, /Comparing /, "compare state label shows the refs");
  assert.match(html, /data-git-path="src\/big\.rs"/, "big file section renders");
  assert.match(html, /data-git-path="src\/small\.js"/, "small file section renders");
});

test("jump buttons disable at boundaries and with nothing to jump to", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  // Position 0 of 2 files: prev file disabled, next file enabled.
  let html = ctxHtml(booted);
  assert.match(html, /aria-label="Previous file"[^>]* disabled/, "prev file disabled at first file");
  assert.ok(!/aria-label="Next file"[^>]* disabled/.test(html), "next file enabled at first file");
  // No change selected yet: prev change disabled, next change enabled.
  assert.match(html, /aria-label="Previous change"[^>]* disabled/, "prev change disabled before first jump");
  assert.ok(!/aria-label="Next change"[^>]* disabled/.test(html), "next change enabled before first jump");
  // Screen-reader text names the counters instead of bare numbers.
  assert.match(html, /<span class="sr-only">File <\/span>/, "file counter is labeled for screen readers");
  assert.match(html, /<span class="sr-only">Change <\/span>/, "change counter is labeled for screen readers");
  // Walk to the last file and last change: the next buttons flip to
  // disabled, proving the boundary state tracks the cursor.
  ui.compareNextChange();
  for (let i = 0; i < 200; i++) ui.compareNextChange();
  ui.compareNextFile();
  await settle();
  html = ctxHtml(booted);
  assert.match(html, /aria-label="Next change"[^>]* disabled/, "next change disabled at last change");
  assert.match(html, /aria-label="Next file"[^>]* disabled/, "next file disabled at last file");
  assert.ok(!/aria-label="Previous file"[^>]* disabled/.test(html), "prev file enabled at last file");
});

test("files over the collapse threshold start collapsed, small files expand", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const view = booted.ctx.window.HerdrGitUi ? null : null;
  // The collapsed state is visible in the header: the collapsed big file
  // shows its line count, the small file does not.
  const html = ctxHtml(booted);
  assert.match(html, /src\/big\.rs.*· 600 diff lines/s, "collapsed big file keeps its line count in the header");
  assert.ok(!/src\/small\.js.*· 3 lines/s.test(html), "small file renders expanded without a collapsed hint");
});

test("collapse threshold 0 disables auto-collapse", async () => {
  const booted = await bootCompare({ options: { gitUiCompareCollapseLimit: 0 } });
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const html = ctxHtml(booted);
  assert.ok(!/src\/big\.rs.*· 600 diff lines/s.test(html), "threshold 0 keeps the big file expanded");
});

test("custom threshold from settings collapses the big file", async () => {
  const booted = await bootCompare({ options: { gitUiCompareCollapseLimit: 100 } });
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const html = ctxHtml(booted);
  assert.match(html, /src\/big\.rs.*· 600 diff lines/s, "threshold 100 collapses the 600-line file");
});

test("jump keys and buttons walk change groups and files", async () => {
  const booted = await bootCompare();
  const { ui, ctx } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  // The compare has 201 change groups: 200 isolated add rows in the big
  // file (one group each) plus the delete+add group in the small file.
  const first = ui.compareNextChange();
  assert.ok(first, "jump returns a position");
  assert.equal(first.index, 0, "first jump selects change 1");
  assert.equal(first.total, 201, "200 add groups in big.rs + 1 group in small.js");
  const second = ui.compareNextChange();
  assert.equal(second.index, 1, "second jump advances");
  const back = ui.comparePrevChange();
  assert.equal(back.index, 0, "previous jump returns");
  // File jumps walk the two files of the compare.
  const fileJump = ui.compareNextFile();
  assert.ok(fileJump, "file jump returns a position");
  assert.equal(fileJump.index, 1, "second file selected");
  assert.equal(fileJump.total, 2, "two files in the compare");
  const fileBack = ui.comparePrevFile();
  assert.equal(fileBack.index, 0, "previous file returns to the first");
});

test("jump expands a collapsed target file", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  assert.match(ctxHtml(booted), /src\/big\.rs.*· 600 diff lines/s, "big file starts collapsed");
  // The first change group lives inside big.rs, so a change jump must
  // expand the collapsed file and scroll to it.
  ui.compareNextChange();
  await settle();
  assert.ok(!/src\/big\.rs.*· 600 diff lines/s.test(ctxHtml(booted)), "file jump expanded the collapsed file");
});

test("manual expand survives a refetch of the same compare pair", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  // Manually expand the auto-collapsed big file.
  ui.toggleFile(encodeURIComponent("src/big.rs"));
  assert.ok(!/src\/big\.rs.*· 600 diff lines/s.test(ctxHtml(booted)), "manual expand opens the file");
  // A layout flip refetches the same pair; the manual toggle must survive.
  ui.setDiffLayout("unified");
  await settle();
  assert.ok(!/src\/big\.rs.*· 600 diff lines/s.test(ctxHtml(booted)), "manual expand survives the refetch");
});

test("layout flip refetch resets the change cursor but keeps the file cursor", async () => {
  const booted = await bootCompare();
  const { ui, ctx } = booted;
  // The layout primitive persists through HerdrOptions; give the harness
  // a mutable store so setDiffLayout actually flips the layout and the
  // refetch signature changes.
  const options = { gitUiDiffLayout: "side-by-side" };
  ctx.window.HerdrOptions = { read: () => options, update: (fn) => fn(options) };
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const jumped = ui.compareNextChange();
  assert.equal(jumped.index, 0, "change cursor moved off the start");
  ui.compareNextFile();
  // Layout flip changes the diff signature: the change cursor resets so a
  // stale index cannot point at a differently decorated row, the file
  // cursor stays because file order is stable.
  ui.setDiffLayout("unified");
  await settle();
  assert.equal(options.gitUiDiffLayout, "unified", "layout option persisted");
  const first = ui.compareNextChange();
  assert.equal(first.index, 0, "change cursor restarted after the signature change");
  const fileJump = ui.compareNextFile();
  assert.equal(fileJump.index, 1, "file cursor kept across the signature change");
});

test("keyboard shortcuts dispatch compare jumps in readonly-compare mode", async () => {
  const booted = await bootCompare();
  const { ui, ctx } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  // ] jumps to the next change group, } to the next file. Both go through
  // the window keydown handler the shortcuts module registered at boot.
  const keydown = dispatchKeydown(ctx, "]");
  assert.equal(keydown.defaultPrevented, true, "the jump key was handled");
  // The key ran the same public method the toolbar button uses; the
  // second position proves the cursor moved.
  const directSecond = ui.compareNextChange();
  assert.ok(directSecond, "direct jump works");
  assert.equal(directSecond.index, 1, "the key jump advanced the cursor");
  const fileKey = dispatchKeydown(ctx, "}");
  assert.equal(fileKey.defaultPrevented, true, "file jump key dispatched");
  // In changes mode the same keys must not jump: the handler gates on mode.
  await ui.showChangesList({ forceReset: true });
  await settle();
  const neutral = dispatchKeydown(ctx, "]");
  assert.equal(neutral.defaultPrevented, false, "changes mode leaves ] alone");
});

test("side-by-side pairs keep the oldest line on the left", async () => {
  const booted = await bootCompare();
  const { ui } = booted;
  ui.tab("log");
  await settle();
  ui.selectLogCommit({ shiftKey: true }, OLD);
  ui.selectLogCommit({ shiftKey: true }, NEW);
  await ui.compareSelectedLog();
  await settle();
  const html = ctxHtml(booted);
  // The side render lists compare files, and the file header names the
  // base first: "old → new" order is the convention under test.
  assert.match(html, new RegExp(`${OLD} → ${NEW}`), "file header shows base (oldest) before target (newest)");
});