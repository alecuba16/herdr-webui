import { describe, it } from "node:test";
import { deepEqual, equal, ok, match, rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// one vm script per product file so coverage maps to the real disk path
function productScript(relPath) {
  productScript.cache = productScript.cache || new Map();
  const real = fileURLToPath(new URL(relPath, import.meta.url));
  if (!productScript.cache.has(real)) {
    productScript.cache.set(real, new vm.Script(readFileSync(real, "utf8"), { filename: real }));
  }
  return productScript.cache.get(real);
}

const CONFLICTS = () => productScript("./desktop/git_ui/conflicts.js");
const PRIMITIVES = () => productScript("./desktop/git_ui/primitives.js");
const TOASTS = () => productScript("./desktop/git_ui/toasts.js");
const WORKSPACE_NAV = () => productScript("./desktop/git_ui/workspace_nav.js");
const SIDE_TREE = () => productScript("./desktop/git_ui/side_tree.js");
const LOG_RENDER = () => productScript("./desktop/git_ui/log_render.js");

// vm results live in another realm, deepStrictEqual rejects their
// prototypes, so structural checks compare json instead
function sameJson(actual, expected, message) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

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
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 40 }),
  };
}

function context(overrides) {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    inputAttrs: () => "",
    requestAnimationFrame: (fn) => fn(),
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
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
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => element(),
      addEventListener() {},
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    window: null,
    globalThis: null,
    WebSocket: class {},
    addEventListener() {},
    ...overrides,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function load(ctx, script) {
  script().runInContext(ctx);
  return ctx;
}

const escFn = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const argFn = (v) => encodeURIComponent(String(v == null ? "" : v)).replace(/'/g, "%27");

// conflicts.js calls inputAttrs inside its hunk templates at render time
function makeConflicts(opts = {}) {
  const ctx = context({ inputAttrs: () => "" });
  load(ctx, CONFLICTS);
  const view = { status: { conflicted: ["a.txt", "b/c.txt"] } };
  let layout = opts.layout || "side-by-side";
  const mod = ctx.HerdrGitUiConflictsModule.create({
    active: () => view,
    esc: escFn,
    arg: argFn,
    currentMode: () => opts.mode || "changes",
    diffLayoutMode: () => layout,
  });
  mod.__ctx = ctx;
  mod.__view = view;
  mod.__setLayout = (value) => { layout = value; };
  return mod;
}

describe("conflicts coverage", () => {
  it("renders side editor states and editable hunks", () => {
    const mod = makeConflicts();
    const editor = {
      hunks: [
        { index: 0, header: "@@ -1 +1 @@", oldText: "old", text: "new", newStart: 1, newEnd: 3 },
        { index: 1, header: "@@ -2 +2 @@", oldText: "", text: "", newStart: 0, newEnd: 0 },
        {
          index: 2, header: "@@ -3 +3 @@",
          text: "common\n<<<<<<< ours\nx\n||||||| base\ny\n=======\nz\n>>>>>>> theirs\ncommon",
          newStart: 5, newEnd: 9,
        },
        {
          index: 3, header: "@@ -4 +4 @@",
          text: "plain\n<<<<<<< H\no\n=======\nt\n>>>>>>> R\n",
          newStart: 2, newEnd: 4,
        },
      ],
    };
    const html = mod.renderSideEditor({ sideEditor: editor });
    match(html, /git-ui-hunk-editor-list/);
    match(html, /current lines 1-3/);
    match(html, /no current lines/);
    match(html, /Conflict block 1/);
    match(html, /git-ui-editor-conflicts/);
    match(html, /data-readonly="true"/);
    // parentless conflict block disables the base button
    ok(html.includes("Parent/base side is unavailable"), "base side missing on plain marker blocks");
    match(html, /disabled>Use parent<\/button>/);
    ok(mod.renderSideEditor({ sideEditor: { loading: true } }).includes("Loading file editor"));
    const errHtml = mod.renderSideEditor({ sideEditor: { error: "boom", hunks: [] } });
    match(errHtml, /git-ui-side-edit-note error/);
    match(errHtml, /No editable hunks for this file\./);
    mod.__setLayout("unified");
    const unified = mod.renderSideEditor({ sideEditor: editor });
    match(unified, /git-ui-hunk-editor-unified/);
    match(unified, /git-ui-hunk-editor-grid-unified/);
    match(mod.editNoteForLayout("unified"), /Edit the hunk text below/);
    match(mod.editNoteForLayout("side-by-side"), /Edit current hunk text on the right/);
    ok(mod.renderEditableHunk({ index: 7, text: "clean", newStart: 2, newEnd: 4 }).includes('data-hunk-index="7"'));
    ok(mod.renderEditableHunkUnified({ index: 8, text: "clean", newStart: 0, newEnd: 0 }).includes('data-hunk-index="8"'));
    ok(mod.renderEditableHunkConflictControls({ index: 9, text: "no markers" }) === "");
    const btns = mod.renderConflictResolutionButtons("x.txt");
    match(btns, /HerdrGitUi\.resolve\(.*,'ours'\)/);
    match(btns, /HerdrGitUi\.resolve\(.*,'base'\)/);
    match(btns, /HerdrGitUi\.resolve\(.*,'mark'\)/);
    match(btns, /Mark resolved \(stage\)/);
  });

  it("parses conflict blocks and resolves text", () => {
    const mod = makeConflicts();
    const withBase = ["start", "<<<<<<< HEAD", "ours1", "ours2", "||||||| merged", "base1", "=======", "theirs1", ">>>>>>> branch", "end"].join("\n");
    const blocks = mod.conflictBlocksInText(withBase);
    equal(blocks.length, 1);
    sameJson(blocks[0].ours, ["ours1", "ours2"]);
    sameJson(blocks[0].base, ["base1"]);
    sameJson(blocks[0].theirs, ["theirs1"]);
    const plain = ["a", "<<<<<<<", "o", "=======", "t", ">>>>>>>", "b"].join("\n");
    const plainBlocks = mod.conflictBlocksInText(plain);
    equal(plainBlocks.length, 1);
    equal(plainBlocks[0].base, null);
    // stray separators before a start are ignored
    const messy = "=======\n>>>>>>> ignored\n=======\n<<<<<<< H\none\n=======\ntwo\n>>>>>>> R\n";
    equal(mod.conflictBlocksInText(messy).length, 1);
    sameJson(mod.conflictBlocksInText(messy)[0].ours, ["one"]);
    // multiple blocks reset parser state between them
    const two = "<<<<<<< H\nx\n=======\ny\n>>>>>>> R\nmid\n<<<<<<< H\np\n=======\nq\n>>>>>>> R\n";
    equal(mod.conflictBlocksInText(two).length, 2);
    sameJson(mod.conflictBlocksInText(two)[1].theirs, ["q"]);
    equal(mod.resolveConflictBlockText(withBase, 0, "ours"), "start\nours1\nours2\nend");
    equal(mod.resolveConflictBlockText(withBase, 0, "theirs"), "start\ntheirs1\nend");
    equal(mod.resolveConflictBlockText(withBase, 0, "base"), "start\nbase1\nend");
    equal(mod.resolveConflictBlockText(plain, 0, "base"), plain);
    equal(mod.resolveConflictBlockText(plain, 5, "ours"), plain);
    equal(mod.resolveConflictBlockText("", 0, "ours"), "");
  });

  it("builds editable hunks and line class ranges", () => {
    const mod = makeConflicts();
    const hunks = mod.buildEditableHunks({
      chunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          lines: [
            { content: "keep", line_type: "context", new_line_number: 1 },
            { content: "gone", line_type: "delete" },
            { content: "in", line_type: "add", new_line_number: 2 },
            { content: "in2", line_type: "add", new_line_number: 3 },
          ],
        },
      ],
    });
    equal(hunks.length, 1);
    equal(hunks[0].oldText, "keep\ngone");
    equal(hunks[0].text, "keep\nin\nin2");
    equal(hunks[0].newStart, 1);
    equal(hunks[0].newEnd, 3);
    sameJson(hunks[0].oldLineTypes, ["context", "del"]);
    sameJson(hunks[0].newLineTypes, ["context", "add", "add"]);
    equal(mod.buildEditableHunks(null).length, 0);
    sameJson(mod.sideEditorOriginalLineClasses(hunks[0], "old"), [{ fromLine: 2, toLine: 2, className: "git-ui-side-line-del" }]);
    sameJson(mod.sideEditorOriginalLineClasses(hunks[0], "current"), [{ fromLine: 2, toLine: 3, className: "git-ui-side-line-add" }]);
    sameJson(mod.sideEditorOriginalLineClasses({ oldLineTypes: ["context"] }, "old"), []);
    sameJson(mod.sideEditorOriginalLineClasses({}, "old"), []);
    sameJson(mod.changedLineClasses("a\nb\nc", "a\nX\nc"), [{ fromLine: 2, toLine: 2, className: "git-ui-side-line-edit" }]);
    sameJson(mod.changedLineClasses("same", "same"), []);
    sameJson(mod.changedLineClasses("", null), []);
  });

  it("detects changed lines via bounds for large inputs", () => {
    const mod = makeConflicts();
    const base = [];
    for (let i = 0; i < 300; i++) base.push(`line ${i}`);
    const current = base.slice();
    current[150] = "changed";
    const classes = mod.changedLineClasses(base.join("\n"), current.join("\n"));
    equal(classes.length, 1);
    equal(classes[0].fromLine, 151);
    equal(classes[0].toLine, 151);
    sameJson(mod.changedLineClasses(base.join("\n"), base.join("\n")), []);
    // dp matched everything although the texts differ: bounds fallback
    sameJson(mod.changedCurrentLineIndexes(["a", "a"], ["a"]), [0]);
    // bounds helper: identical prefix/suffix, middle change
    sameJson(mod.changedCurrentLineIndexesByBounds(["p", "x", "s"], ["p", "y", "s"]), [1]);
    // bounds helper: current side fully consumed by the common prefix
    sameJson(mod.changedCurrentLineIndexesByBounds(["a", "b"], ["a"]), [0]);
    sameJson(mod.lineIndexesToRanges([0, 1, 2, 5, 7, 8], "cls"), [
      { fromLine: 1, toLine: 3, className: "cls" },
      { fromLine: 6, toLine: 6, className: "cls" },
      { fromLine: 8, toLine: 9, className: "cls" },
    ]);
    ok(mod.isConflictPath("a.txt"));
    ok(!mod.isConflictPath("zzz"));
    ok(mod.renderDiffConflictResolutionButtons({ path: "a.txt" }).length > 0);
    equal(mod.renderDiffConflictResolutionButtons({ path: "zzz" }), "");
  });
});

function makePrimitives(options = {}) {
  const ctx = context();
  ctx.HerdrOptions = {
    read: () => options,
    update(fn) { fn(options); },
  };
  load(ctx, PRIMITIVES);
  return ctx.HerdrGitUiPrimitivesModule.create();
}

describe("primitives coverage", () => {
  it("reads option gates and defaults", () => {
    const p = makePrimitives();
    equal(p.explorationDefaultDirectory(), "");
    equal(p.largeDiffLineLimit(), 2000);
    equal(p.largeChangeFileLimit(), 25);
    equal(p.largeSectionFileLimit(), 250);
    equal(p.fileListMode(), "tree");
    equal(p.diffLayoutMode(), "side-by-side");
    equal(p.gitLogDefaultBranch(), "master");
    equal(p.gitRemoteBranchPreload(), 10);
    sameJson(p.gitUiOptions(), {});
    equal(p.loadedLargeDiffPreviewLimit(), 1200);
    const configured = makePrimitives({
      explorationDefaultDirectory: " /tmp/x ",
      gitUiLargeDiffLineLimit: 5,
      gitUiLargeChangeFileLimit: 0,
      gitUiLargeSectionFileLimit: -3,
      gitUiFileListMode: "flat",
      gitUiDiffLayout: "unified",
      gitUiDefaultBranch: " trunk ",
      gitUiRemoteBranchPreload: 500,
    });
    equal(configured.explorationDefaultDirectory(), "/tmp/x");
    equal(configured.largeDiffLineLimit(), 5);
    equal(configured.largeChangeFileLimit(), 0);
    equal(configured.largeSectionFileLimit(), 0);
    equal(configured.fileListMode(), "flat");
    equal(configured.diffLayoutMode(), "unified");
    equal(configured.gitLogDefaultBranch(), "trunk");
    equal(configured.gitRemoteBranchPreload(), 100);
    equal(makePrimitives({ gitUiRemoteBranchPreload: 0 }).gitRemoteBranchPreload(), 1);
    equal(p.normalizeLogScope("base-current"), "base-current");
    equal(p.normalizeLogScope("base"), "base");
    equal(p.normalizeLogScope("weird"), "all");
  });

  it("guards options access and updates them", () => {
    // no HerdrOptions binding: read and update stay no-ops
    const bare = context();
    load(bare, PRIMITIVES);
    const p = bare.HerdrGitUiPrimitivesModule.create();
    sameJson(p.gitUiOptions(), {});
    p.setGitUiOption("gitUiFileListMode", "flat");
    equal(p.fileListMode(), "tree");
    // throwing read falls back to {}
    const throwing = context();
    throwing.HerdrOptions = { read: () => { throw new Error("nope"); }, update: () => { throw new Error("nope"); } };
    load(throwing, PRIMITIVES);
    const tp = throwing.HerdrGitUiPrimitivesModule.create();
    sameJson(tp.gitUiOptions(), {});
    tp.setGitUiOption("a", 1);
  });

  it("counts diff lines and previews large diffs", () => {
    const p = makePrimitives();
    const file = {
      path: "a.txt",
      chunks: [
        { lines: [{ content: "x", line_type: "context" }, { content: "y", line_type: "add" }] },
        { lines: [{ content: "z", line_type: "delete" }] },
      ],
    };
    equal(p.diffLineCount([file]), 3);
    equal(p.diffLineCount(null), 0);
    equal(p.diffFileLineCount(file), 3);
    equal(p.diffFileLineCount(null), 0);
    const preview = p.previewDiffFile(file, 2);
    equal(preview.preview_large_diff, true);
    equal(preview.chunks.length, 1);
    equal(preview.chunks[0].lines.length, 2);
    ok(!("rows" in preview.chunks[0]));
    sameJson(p.previewDiffFile(file, 0).chunks, []);
    const lines = [
      { content: "d1", line_type: "delete" },
      { content: "d2", line_type: "delete" },
      { content: "a1", line_type: "add" },
      { content: "c1", line_type: "context" },
    ];
    sameJson(p.previewChunkLines(lines, 2), []);
    sameJson(p.previewChunkLines(lines, 3), [lines[0], lines[1], lines[2]]);
    sameJson(p.previewChunkLines(lines, 10), lines);
    equal(p.diffFileKey("p", "W"), "W:p");
    equal(p.diffFileKey({ path: "q", diff_kind: "C" }), "C:q");
    equal(p.diffFileKey({}), ":");
    equal(p.changeSetFileCount({ conflicted: ["a"], staged: ["a"], unstaged: ["b"], untracked: [null, "c"] }), 3);
  });

  it("hashes, escapes, and encodes", () => {
    const p = makePrimitives();
    ok(p.hashText("hello").length > 0);
    equal(p.hashText(null), p.hashText(""));
    equal(p.esc("<a&b>\"c"), "&lt;a&amp;b&gt;&quot;c");
    equal(p.esc(null), "");
    equal(p.arg("it's"), "it%27s");
    equal(p.arg(null), "");
  });
});

function makeToasts(opts = {}) {
  const calls = { renders: 0, api: [], clipboard: [], removes: 0, inserts: [], timeouts: [] };
  // the module schedules expiry through the context global setTimeout,
  // so capture there instead of running real 10s timers
  const ctx = context({ setTimeout: (fn) => { calls.timeouts.push(fn); } });
  load(ctx, TOASTS);
  const state = { gitToast: null, scopeCopyToast: null, visible: true };
  const view = { cwd: "/repo", status: { branch: "main", branch_web_url: "https://vcs/branch", pr_create_url: "https://vcs/pr" } };
  let panel = element();
  const mod = ctx.HerdrGitUiToastsModule.create({
    state,
    active: () => (opts.noView ? null : view),
    api: async (url) => { calls.api.push(url); return opts.permalink || { url: "https://vcs/pl" }; },
    esc: escFn,
    arg: argFn,
    render: () => { calls.renders += 1; },
    ensurePanel: () => panel,
    navigator: { clipboard: { writeText: async (text) => { calls.clipboard.push(text); } } },
    setTimeoutFn: (fn) => { calls.timeouts.push(fn); },
  });
  mod.__state = state;
  mod.__calls = calls;
  mod.__makePanel = () => {
    const children = [];
    calls.children = children;
    panel = {
      querySelector: (sel) => (sel === ".git-ui-scope-copy-toast" ? (children[0] || null) : null),
      insertAdjacentHTML: (pos, html) => {
        calls.inserts.push({ pos, html });
        children.unshift({ html, remove() { calls.removes += 1; const at = children.indexOf(this); if (at >= 0) children.splice(at, 1); } });
      },
    };
    return panel;
  };
  return mod;
}

describe("toasts coverage", () => {
  it("derives branch and PR urls", () => {
    const mod = makeToasts();
    equal(mod.gitBranchUrl({ branch: "main", branch_web_url: "u" }), "u");
    equal(mod.gitBranchUrl({ branch: "(detached)", branch_web_url: "u" }), "");
    equal(mod.gitBranchUrl(null), "");
    equal(mod.gitPullRequestUrl({ pr_create_url: "pr" }, { pushed: true }), "pr");
    equal(mod.gitPullRequestUrl({ pr_create_url: "pr" }), "");
    equal(mod.gitPullRequestUrl(null, { pushed: true }), "");
  });

  it("shows commit toasts with links and expiry", () => {
    const mod = makeToasts();
    equal(mod.renderGitToast(), "");
    mod.showCommitToast("Pushed");
    const toast = mod.__state.gitToast;
    equal(toast.message, "Pushed");
    equal(toast.branch, "main");
    equal(toast.branchUrl, "https://vcs/branch");
    equal(toast.prUrl, "");
    const html = mod.renderGitToast();
    match(html, /Open branch/);
    ok(!html.includes("Open PR"));
    match(html, /Dismiss/);
    mod.showCommitToast("Up", { pushed: true });
    match(mod.renderGitToast(), /Open PR/);
    // detached branch hides the branch pill and button
    mod.__state.gitToast.branchUrl = "";
    mod.__state.gitToast.branch = "";
    const bare = mod.renderGitToast();
    ok(!bare.includes("git-ui-toast-branch"));
    ok(!bare.includes("Open branch"));
    // expiry timers clear the latest toast
    mod.__calls.timeouts.forEach((fn) => fn());
    equal(mod.__state.gitToast, null);
  });

  it("copies permalinks and commit ids", async () => {
    const mod = makeToasts();
    await mod.copyGitPermalink("src/a.txt");
    equal(mod.__calls.api[0], "/api/git-ui/permalink?cwd=%2Frepo&path=src%2Fa.txt");
    equal(mod.__calls.clipboard[0], "https://vcs/pl");
    equal(mod.__state.gitToast.message, "Permalink copied");
    mod.__calls.timeouts.forEach((fn) => fn());
    equal(mod.__state.gitToast, null);
    // empty permalink url rejects
    const bad = makeToasts({ permalink: {} });
    await rejects(bad.copyGitPermalink("x"), /permalink URL was empty/);
    // empty hash skips clipboard
    const idMod = makeToasts();
    await idMod.copyCommitId("  ");
    equal(idMod.__calls.clipboard.length, 0);
    await idMod.copyCommitId("abc123 ");
    // the value is trimmed before hitting the clipboard
    equal(idMod.__calls.clipboard[0], "abc123");
    equal(idMod.__state.gitToast.message, "Commit id copied");
    idMod.__calls.timeouts.forEach((fn) => fn());
    equal(idMod.__state.gitToast, null);
    // no active view returns early
    const noView = makeToasts({ noView: true });
    await noView.copyGitPermalink("x");
    equal(noView.__calls.api.length, 0);
  });

  it("renders scope copy toasts at click coordinates", async () => {
    const mod = makeToasts();
    mod.__makePanel();
    equal(mod.renderScopeCopyToast(), "");
    await mod.copyScopeValue({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 2 }, "tag%20v1", "tag%20v1");
    equal(mod.__calls.clipboard[0], "tag v1");
    equal(mod.__calls.inserts.length, 1);
    // raw coords are clamped only at render time, not in state
    equal(mod.__state.scopeCopyToast.x, 5);
    equal(mod.__state.scopeCopyToast.y, 2);
    match(mod.renderScopeCopyToast(), /tag v1 copied/);
    match(mod.renderScopeCopyToast(), /left:8px;top:8px/);
    // no event falls back to default coords
    await mod.copyScopeValue(null, "v2", "branch");
    equal(mod.__state.scopeCopyToast.x, 16);
    equal(mod.__state.scopeCopyToast.y, 16);
    match(mod.renderScopeCopyToast(), /branch copied/);
    // empty value returns early, panel untouched
    await mod.copyScopeValue(null, "", "branch");
    equal(mod.__calls.inserts.length, 2);
    // a fresh copy removes the stale toast first
    await mod.copyScopeValue({ preventDefault() {}, stopPropagation() {}, clientX: 40, clientY: 30 }, "v3", "tag%20v3");
    equal(mod.__calls.removes, 2);
    equal(mod.__state.scopeCopyToast.x, 40);
    // inserts are chronological, the freshest copy is last
    const lastInsert = mod.__calls.inserts[mod.__calls.inserts.length - 1];
    match(lastInsert.html, /tag v3 copied/);
    match(lastInsert.html, /left:40px;top:30px/);
    // expiry clears state and removes the toast element
    mod.__calls.timeouts.forEach((fn) => fn());
    equal(mod.__state.scopeCopyToast, null);
    equal(mod.__calls.children.length, 0);
  });
});

function makeWorkspaceNav(opts = {}) {
  const ctx = context();
  load(ctx, WORKSPACE_NAV);
  const state = { visible: false, activeKey: "main", sideScrollTop: 0, cache: {} };
  const calls = { loads: 0, previews: [], renders: 0, syncs: 0 };
  const view = {
    cwd: "/repo", workspaceCwd: "/repo", tab: "changes", mode: "changes", file: "",
    navigationStack: [], status: { state: "clean" }, logAll: false, logScope: "",
    compareFilePaths: [], selectedLogCommits: [], selectedCommitPreview: null,
    logFilePath: "", logFilters: { description: "", date: "", author: "" }, fileFilter: "",
    committedFile: null, logLimit: 80, railStatus: null,
  };
  if (opts.view) Object.assign(view, opts.view);
  const mod = ctx.HerdrGitUiWorkspaceNavModule.create({
    state,
    currentMode: () => view.mode,
    normalizeLogScope: (scope) => ["all", "base-current", "base"].includes(scope) ? scope : "all",
    preserveContentScroll: () => false,
    loadDiff: async () => { calls.loads += 1; },
    loadSelectedCommitPreview: (v, hash) => { calls.previews.push({ v, hash }); },
    render: () => { calls.renders += 1; },
    syncPaneTabFromView: () => { calls.syncs += 1; },
    esc: (v) => String(v == null ? "" : v),
    GIT_LOG_PAGE_SIZE: 80,
  });
  mod.__state = state;
  mod.__view = view;
  mod.__calls = calls;
  mod.__ctx = ctx;
  return mod;
}

describe("workspace_nav coverage", () => {
  it("derives workspace cwd, title, key", () => {
    const mod = makeWorkspaceNav();
    const wt = { branch: "feat", checkout_path: "/wt" };
    // no HerdrWorkspacePath helper: worktree path wins, then cwd, then path
    equal(mod.workspaceCwd(null), "");
    equal(mod.workspaceCwd({}), "");
    equal(mod.workspaceCwd({ worktree: wt }), "/wt");
    equal(mod.workspaceCwd({ worktree: {} }), "");
    equal(mod.workspaceCwd({ cwd: "/a" }), "/a");
    equal(mod.workspaceCwd({ path: "/b" }), "/b");
    equal(mod.workspaceKey(null), "default");
    equal(mod.workspaceKey({ workspace_id: "w1" }), "w1");
    equal(mod.workspaceKey({ cwd: "/a" }), "/a");
    // helper installed wins over all of them
    mod.__ctx.HerdrWorkspacePath = (w) => (w.worktree ? w.worktree.checkout_path : w.cwd) + "!";
    equal(mod.workspaceCwd({ cwd: "/a" }), "/a!");
    equal(mod.workspaceCwd({ worktree: wt }), "/wt!");
    equal(mod.workspaceTitle(null), "Git");
    equal(mod.workspaceTitle({ worktree: wt }), "feat");
    equal(mod.workspaceTitle({ worktree: { checkout_path: "/wt" } }), "/wt");
    equal(mod.workspaceTitle({ worktree: {} }), "worktree");
    equal(mod.workspaceTitle({ worktree: wt, label: "labeled" }), "feat");
    equal(mod.workspaceTitle({}), "main/master");
    equal(mod.workspaceTitle({ label: "My repo" }), "My repo");
  });

  it("normalizes paths and matches git cwd to workspace", () => {
    const mod = makeWorkspaceNav();
    equal(mod.normalizePathForCompare(""), "");
    equal(mod.normalizePathForCompare("/"), "/");
    equal(mod.normalizePathForCompare("/a///"), "/a");
    equal(mod.normalizePathForCompare(" /b/ "), "/b");
    ok(mod.samePath("/a/", "/a"));
    ok(!mod.samePath("/a", "/b"));
    ok(mod.gitCwdMatchesWorkspace(null));
    ok(mod.gitCwdMatchesWorkspace({ cwd: "/x", workspaceCwd: "/x/" }));
    ok(!mod.gitCwdMatchesWorkspace({ cwd: "/x", workspaceCwd: "/y" }));
    ok(mod.gitCwdMatchesWorkspace({ cwd: "/x" }));
  });

  it("resets view state for a new cwd", () => {
    const mod = makeWorkspaceNav({ view: {
      file: "a.txt", status: { state: "dirty" }, railStatus: { state: "x" }, diff: { files: [] },
      compareBase: "b", compareTarget: "t", compareFilePaths: ["p"], selectedLogCommits: ["h"],
      selectedCommitPreview: { hash: "h" }, logFilePath: "f", selectedStash: "s", selectedStashDiff: {},
      stashFile: "sfile", stashData: {}, committedFile: { hash: "c" }, navigationStack: [{}],
      mode: "compare", tab: "log",
    } });
    const view = mod.__view;
    mod.resetGitViewForCwd(view, "/new");
    equal(view.cwd, "/new");
    equal(view.file, "");
    equal(view.status, null);
    equal(view.railStatus, null);
    equal(view.diff, null);
    equal(view.compareBase, "");
    equal(view.compareTarget, "");
    sameJson(view.compareFilePaths, []);
    sameJson(view.selectedLogCommits, []);
    equal(view.selectedCommitPreview, null);
    equal(view.logFilePath, "");
    equal(view.selectedStash, "");
    equal(view.selectedStashDiff, null);
    equal(view.stashFile, "");
    equal(view.stashData, null);
    equal(view.committedFile, null);
    sameJson(view.navigationStack, []);
    equal(view.mode, "changes");
    equal(view.tab, "changes");
    equal(mod.__calls.syncs, 1);
  });

  it("clones plain values and builds breadcrumbs", () => {
    const mod = makeWorkspaceNav();
    sameJson(mod.clonePlain({ a: 1 }), { a: 1 });
    sameJson(mod.clonePlain(null, []), []);
    // circular value falls back
    const circular = {}; circular.self = circular;
    equal(mod.clonePlain(circular, "fb"), "fb");
    sameJson(mod.viewCrumbs(null), ["Git"]);
    sameJson(mod.viewCrumbs({ tab: "history", file: "f.txt" }), ["Changes", "f.txt", "History"]);
    sameJson(mod.viewCrumbs({ tab: "history", file: "" }), ["History"]);
    sameJson(mod.viewCrumbs({ tab: "log", logFilePath: "a.txt" }), ["Log", "a.txt"]);
    sameJson(mod.viewCrumbs({ tab: "log" }), ["Log"]);
    sameJson(mod.viewCrumbs({ tab: "stash", selectedStash: "s0" }), ["Stash", "s0"]);
    sameJson(mod.viewCrumbs({ tab: "stash" }), ["Stash"]);
    sameJson(mod.viewCrumbs({ tab: "cleanup" }), ["Cleanup"]);
    sameJson(mod.viewCrumbs({ tab: "conflicts" }), ["Changes", "Conflicts"]);
    sameJson(mod.viewCrumbs({ committedFile: { from: "history", hash: "abcdef123456789" }, file: "f.txt" }), ["History", "f.txt", "Committed abcdef123456"]);
    sameJson(mod.viewCrumbs({ committedFile: { hash: "" }, file: "f.txt" }), ["Log", "f.txt", "Committed file"]);
    sameJson(mod.viewCrumbs({ file: "f.txt" }), ["Changes", "f.txt"]);
    // compare crumbs come from the module's currentMode dep, not the literal
    const compareNav = makeWorkspaceNav({ view: { mode: "compare", file: "f.txt" } });
    sameJson(compareNav.viewCrumbs(compareNav.__view), ["Compare", "f.txt"]);
    sameJson(mod.viewCrumbs({}), ["Changes"]);
    const compareOnly = makeWorkspaceNav({ view: { mode: "compare" } });
    sameJson(compareOnly.viewCrumbs(compareOnly.__view), ["Compare"]);
  });

  it("captures, pushes, and restores navigation snapshots", async () => {
    const mod = makeWorkspaceNav();
    equal(mod.captureNavigationSnapshot(null), null);
    const view = mod.__view;
    const snap = mod.captureNavigationSnapshot(view, "Label");
    equal(snap.label, "Label");
    equal(snap.tab, "changes");
    equal(snap.logLimit, 80);
    sameJson(snap.selectedLogCommits, []);
    // label defaults to crumbs
    view.file = "x.txt";
    equal(mod.captureNavigationSnapshot(view).label, "Changes › x.txt");
    // identical consecutive signatures dedupe; labels are not part of it
    mod.pushNavigationSnapshot(null, "x");
    mod.pushNavigationSnapshot(view, "one");
    equal(view.navigationStack.length, 1);
    mod.pushNavigationSnapshot(view, "two");
    equal(view.navigationStack.length, 1);
    mod.pushNavigationSnapshot(view, "two");
    equal(view.navigationStack.length, 1);
    // stack is capped at 12
    for (let i = 0; i < 20; i++) view.navigationStack.push({ tab: "log", mode: "changes", file: `f${i}`, selectedLogCommits: [], logFilePath: "" });
    mod.pushNavigationSnapshot(view, "more");
    equal(view.navigationStack.length, 12);
    // restore from a log snapshot
    const restoreNav = makeWorkspaceNav();
    const rv = restoreNav.__view;
    rv.tab = "log";
    const restored = {
      tab: "log", mode: "compare", file: "f", diffKind: "U", diffScope: "staged",
      compareBase: "b", compareTarget: "t", compareFilePaths: ["p"],
      selectedLogCommits: ["h1"], selectedCommitPreview: null,
      logFilePath: "f", logLimit: 50, logScope: "base", logAll: false,
      logFilters: { description: "d", date: "", author: "" }, fileFilter: "q",
      committedFile: { hash: "c" }, contentScrollTop: 9, sideScrollTop: 4,
    };
    await restoreNav.restoreNavigationSnapshot(rv, restored);
    equal(rv.mode, "compare");
    equal(rv.diffScope, "staged");
    sameJson(rv.compareFilePaths, ["p"]);
    sameJson(rv.selectedLogCommits, ["h1"]);
    equal(rv.selectedCommitPreview, null);
    equal(rv.fileFilter, "q");
    sameJson(rv.logFilters, { description: "d", date: "", author: "" });
    equal(rv.committedFile.hash, "c");
    equal(rv.contentScrollTop, 9);
    equal(restoreNav.__state.sideScrollTop, 4);
    equal(rv.logScope, "base");
    equal(rv.logAll, false);
    equal(restoreNav.__calls.previews.length, 1);
    equal(restoreNav.__calls.previews[0].hash, "h1");
    equal(restoreNav.__calls.renders, 1);
    // restore into changes reloads diff and returns early
    const changesNav = makeWorkspaceNav();
    await changesNav.restoreNavigationSnapshot(changesNav.__view, { tab: "changes" });
    equal(changesNav.__calls.loads, 1);
    // null args no-op
    await restoreNav.restoreNavigationSnapshot(null, {});
    await restoreNav.restoreNavigationSnapshot(rv, null);
    // log restore with matching preview skips the preview reload
    const skipNav = makeWorkspaceNav();
    skipNav.__view.tab = "log";
    await skipNav.restoreNavigationSnapshot(skipNav.__view, { tab: "log", selectedLogCommits: ["h2"], selectedCommitPreview: { hash: "h2" } });
    equal(skipNav.__calls.previews.length, 0);
    equal(skipNav.__calls.renders, 1);
  });

  it("maps workspace status tints and compacts paths", () => {
    const mod = makeWorkspaceNav();
    const state = mod.__state;
    const view = mod.__view;
    equal(mod.workspaceStatus("k", null), "nogit");
    equal(mod.workspaceStatus(null, {}), "nogit");
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "unknown");
    state.cache.k = view;
    view.status = { state: "dirty" };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "dirty");
    view.status = { state: "conflicts" };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "conflicts");
    view.status = { state: "clean" };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "clean");
    view.status = { state: "other" };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "closed");
    // open drawer wins over closed
    state.visible = true;
    state.activeKey = "k";
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "open");
    state.visible = false;
    // parked not_git_repository without rail ownership
    view.status = { not_git_repository: true };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "nogit");
    // error view without rail status
    view.error = new Error("x");
    view.status = {};
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "nogit");
    // rail owned error stays as its parked tint
    view.railStatus = { state: "conflicts" };
    view.workspaceCwd = "/other";
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "conflicts");
    view.railStatus = { not_git_repository: true };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "nogit");
    // rail-owned clean with matching cwd reads status
    view.workspaceCwd = "/repo";
    view.error = null;
    view.railStatus = { state: "clean" };
    view.status = { state: "dirty" };
    equal(mod.workspaceStatus("k", { cwd: "/repo" }), "dirty");
    equal(mod.compactPath(null), "No repo path");
    equal(mod.compactPath("/a/b"), "/a/b");
    equal(mod.compactPath("/a/b/c/d"), ".../b/c/d");
  });
});

function makeSideTree(opts = {}) {
  const ctx = context();
  load(ctx, SIDE_TREE);
  const view = {
    tab: "changes", mode: "changes", file: "a.txt", diffKind: "M", fileFilter: "",
    collapsedSections: {}, expandedLargeSections: {}, collapsedDirs: {}, expandedCompactDirs: {},
    status: {
      staged: ["src/s.txt"], unstaged: ["src/u.txt", "lib/x.txt"], untracked: ["src/new/"],
      conflicted: ["src/c.txt"],
    },
    stashData: null, selectedStash: "", selectedStashDiff: null,
    compareFilePaths: [], diff: { files: [{ path: "d.txt" }] },
    selectedCommitPreview: null, selectedLogCommits: [], stashFile: "", committedFile: null,
  };
  if (opts.view) Object.assign(view, opts.view);
  const mod = ctx.HerdrGitUiSideTreeModule.create({
    active: () => view,
    esc: escFn,
    arg: argFn,
    currentMode: () => view.mode,
    diffFile: (path) => (opts.diffFiles || []).find((f) => f.path === path) || null,
    fileListMode: () => opts.fileListMode || "tree",
    largeSectionFileLimit: () => (opts.sectionLimit === undefined ? 250 : opts.sectionLimit),
    titleWithGitShortcut: (title) => `${title} (s)`,
    FileTree: opts.FileTree === null ? null : (opts.FileTree || { renderPathTree: (files, options) => `<tree rows="${files.length}" select="${options.selectMethod}"/>` }),
  });
  mod.__view = view;
  mod.__ctx = ctx;
  return mod;
}

describe("side_tree coverage", () => {
  it("renders sections with bulk actions, limits, and collapse", () => {
    const mod = makeSideTree();
    match(mod.section("Staged", ["src/s.txt"], "S"), /git-ui-section/);
    match(mod.section("Staged", ["src/s.txt"], "S"), /bulkSectionAction\('unstage','Staged'\)/);
    match(mod.section("Unstaged", ["src/u.txt"], "M"), /bulkSectionAction\('stage','Unstaged'\)/);
    match(mod.section("Untracked", ["src/new/"], "?"), /bulkSectionAction\('stage','Untracked'\)/);
    ok(!mod.section("Committed", ["x"], "C").includes("bulkSectionAction"));
    equal(mod.sectionBulkAction("Empty", "S", []), "");
    // collapsed section hides the list
    mod.__view.collapsedSections.Staged = true;
    const collapsedHtml = mod.section("Staged", ["src/s.txt"], "S");
    match(collapsedHtml, /git-ui-section-head/);
    ok(!collapsedHtml.includes("git-ui-list"));
    delete mod.__view.collapsedSections.Staged;
    // large section note and expansion
    const many = [];
    for (let i = 0; i < 260; i++) many.push(`f${i}.txt`);
    const limited = mod.section("Unstaged", many, "M");
    match(limited, /Showing first 250 of 260 files/);
    match(limited, /expandLargeSection\('Unstaged'\)/);
    mod.__view.expandedLargeSections.Unstaged = true;
    ok(!mod.section("Unstaged", many, "M").includes("Showing first"));
    // treeStyle flag and empty list
    match(mod.section("Empty", [], "M", true), /No empty files/);
    match(mod.section("Unstaged", ["src/u.txt"], "M", true), /git-ui-tree-list/);
  });

  it("renders trees flat and nested, with status metadata", () => {
    const mod = makeSideTree();
    equal(mod.treeIcon("nope"), '<span class="git-tree-icon git-tree-icon-file" aria-hidden="true"></span>');
    match(mod.treeIcon("folder"), /git-tree-icon-folder/);
    match(mod.treeIcon("chevron-right"), /git-tree-icon-chevron-right/);
    match(mod.treeIcon("chevron-down"), /git-tree-icon-chevron-down/);
    match(mod.treeIcon("file"), /git-tree-icon-file/);
    // FileTree present delegates to it
    match(mod.renderFileTree(["a", "b"], "M", mod.__view), /<tree rows="2" select="selectFile"\/>/);
    // no FileTree, flat mode
    const flat = makeSideTree({ FileTree: null, fileListMode: "flat" });
    const flatHtml = flat.renderFileTree(["z.txt", "a.txt"], "M", flat.__view);
    match(flatHtml, /data-git-path="a\.txt"/);
    ok(flatHtml.indexOf("a.txt") < flatHtml.indexOf("z.txt"), "flat list sorts by basename");
    // no FileTree, tree mode with nested dirs and a collapsed dir
    const tree = makeSideTree({ FileTree: null });
    tree.__view.collapsedDirs.pkg = true;
    const nestedHtml = tree.renderFileTree(["pkg/deep/file.js", "root.txt"], "M", tree.__view);
    match(nestedHtml, /git-ui-dir/);
    match(nestedHtml, /aria-expanded="false"/);
    ok(!nestedHtml.includes("file.js"), "collapsed dir hides children");
    delete tree.__view.collapsedDirs.pkg;
    const openHtml = tree.renderFileTree(["pkg/deep/file.js"], "M", tree.__view);
    match(openHtml, /file\.js/);
    match(openHtml, /aria-expanded="true"/);
    // flat helper and basename
    equal(mod.pathBasename("/a/b/c.txt"), "c.txt");
    equal(mod.pathBasename(null), "");
    equal(mod.pathBasename("/"), "/");
    ok(mod.renderFlatFileList(["m.txt"], "M", mod.__view).includes("m.txt"));
    // renderSideFile highlight fallback and present-highlight branch
    const noHl = makeSideTree({ FileTree: null });
    match(noHl.renderSideFile("x.txt", "x.txt", "M", noHl.__view, 0, "selectFile", "x.txt", null), /data-git-path="x\.txt"/);
    const hlTree = makeSideTree({ FileTree: { highlight: (name) => `*${name}*` } });
    match(hlTree.renderSideFile("x.txt", "x.txt", "M", hlTree.__view, 0, "selectFile", "x.txt", null), /\*x\.txt\*/);
    // renderFileTree options override defaults
    const optMod = makeSideTree();
    match(optMod.renderFileTree(["a"], "M", optMod.__view, { selectMethod: "pick", selectedPath: "a", metaForPath: () => "meta", statusForPath: () => "added" }), /select="pick"/);
  });

  it("builds dir menus, view tabs, and stash panels", () => {
    const mod = makeSideTree();
    sameJson(mod.dirMenuTargetPaths({ file: "" }), []);
    sameJson(mod.dirMenuTargetPaths({ file: "src" }), ["src/s.txt", "src/u.txt", "src/new/", "src/c.txt"]);
    sameJson(mod.dirMenuTargetPaths({ file: "src/" }), ["src/s.txt", "src/u.txt", "src/new/", "src/c.txt"]);
    sameJson(mod.dirMenuTargetPaths({ file: "none" }), []);
    sameJson(mod.dirMenuTargetPaths({ file: "lib" }), ["lib/x.txt"]);
    // folder mutations only render in changes mode
    mod.__view.mode = "compare";
    const readonlyMenu = mod.renderDirContextMenu({ file: "src", x: -5, y: -3 });
    match(readonlyMenu, /Show in file explorer/);
    match(readonlyMenu, /Show history/);
    match(readonlyMenu, /left:0px;top:0px/);
    ok(!readonlyMenu.includes("Stage folder"), "compare mode keeps dir menus read-only");
    mod.__view.mode = "changes";
    const mutableMenu = mod.renderDirContextMenu({ file: "src", x: 10, y: 10 });
    match(mutableMenu, /Stage folder \(4 files\)/);
    match(mutableMenu, /Unstage folder \(4 files\)/);
    match(mutableMenu, /Discard folder \(4 files\)/);
    match(mutableMenu, /left:10px;top:10px/);
    match(mod.renderDirContextMenu({ file: "src/s.txt", x: 1, y: 1 }), /Stage folder \(1 file\)/);
    // view tabs
    const tabs = mod.renderGitViewTabs([
      { id: "changes", label: "Changes" },
      { id: "cleanup", label: "Cleanup", disabled: true, disabledReason: "no repo" },
    ], "changes");
    match(tabs, /aria-selected="true"/);
    match(tabs, /aria-selected="false"/);
    match(tabs, /title="no repo"/);
    match(tabs, /disabled/);
    ok(!tabs.includes("HerdrGitUi.tab('cleanup')"));
    match(tabs, /git-ui-cleanup-tab/);
    // stash helpers
    ok(mod.hasStagedChanges({ status: { staged: ["a"] } }));
    ok(!mod.hasStagedChanges({}));
    equal(mod.stashCount({ status: { stashes: 2 } }), 2);
    equal(mod.stashCount(null), 0);
    equal(mod.stashCount({ status: { stashes: -1 } }), 0);
    ok(mod.canOpenStashView({ status: { stashes: 1 } }));
    ok(!mod.canOpenStashView(null));
    // stash list html
    const stashView = { stashData: { stashes: [{ name: "stash@{0}", date: "d", message: "m" }, { name: "s2", date: "", message: "" }] }, selectedStash: "stash@{0}" };
    const stashHtml = mod.stashListHtml(stashView);
    match(stashHtml, /data-stash-name="stash@\{0\}"/);
    match(stashHtml, /active/);
    match(stashHtml, /d · m/);
    match(stashHtml, /<em>2<\/em>/);
    match(mod.stashListHtml({ stashData: null, selectedStash: "" }), /No stashes/);
    // stash file section states
    equal(mod.stashFileSection({ selectedStash: "" }), "");
    const loading = mod.stashFileSection({ selectedStash: "stash@{1}", selectedStashDiff: { loading: true } });
    match(loading, /Loading stash files/);
    match(loading, /<em>stash 1<\/em>/);
    match(mod.stashFileSection({ selectedStash: "s", selectedStashDiff: { error: "bad" } }), /git-ui-error">bad</);
    match(mod.stashFileSection({ selectedStash: "s", selectedStashDiff: { diff: { files: [{ path: "a" }] } } }), /Stash files s/);
    match(mod.stashFileSection({ selectedStash: "s", selectedStashDiff: null }), /No files in this stash/);
    match(mod.stashFileSectionList("Stash files s", ["a"], { collapsedSections: { "Stash files s": true } }), /git-ui-section-head/);
    // large stash file section note
    match(mod.stashFileSectionList("T", ["a", "b"], { collapsedSections: {} }), /git-ui-section-head/);
    const stashLimit = makeSideTree({ sectionLimit: 1 });
    match(stashLimit.stashFileSectionList("T", ["a", "b"], { collapsedSections: {} }), /Showing first 1 of 2 files/);
  });

  it("summarizes files and counts sidebar entries", () => {
    const counted = makeSideTree({ diffFiles: [{ path: "a.txt", additions: 2, deletions: 1 }] });
    match(counted.fileSummary("a.txt", "M"), /git-ui-file-counts/);
    const noCounts = makeSideTree({ diffFiles: [{ path: "a.txt" }] });
    match(noCounts.fileSummary("a.txt", "M"), /git-ui-file-icon edit/);
    ok(!noCounts.fileSummary("a.txt", "M").includes("git-ui-file-counts"));
    const added = makeSideTree({ diffFiles: [{ path: "a.txt", status: "added" }] });
    match(added.fileSummary("a.txt", "M"), /git-ui-file-icon add/);
    const deleted = makeSideTree({ diffFiles: [{ path: "a.txt", status: "deleted" }] });
    match(deleted.fileSummary("a.txt", "M"), /git-ui-file-icon del/);
    const conflict = makeSideTree({ diffFiles: [{ path: "a.txt", status: "conflict" }] });
    match(conflict.fileSummary("a.txt", "M"), /git-ui-file-icon conflict/);
    // summary for a folder aggregates member files
    const dirMod = makeSideTree({ diffFiles: [{ path: "src/a", status: "deleted", additions: 4 }] });
    match(dirMod.fileSummary("src", "M"), /git-ui-file-summary/);
    sameJson(dirMod.fileSummaryEntries("src/a", "M").length, 1);
    const mod = makeSideTree();
    sameJson(mod.fileSummaryEntries("none.txt", "M"), []);
    // staged/unstaged status summaries path
    const statusMod = makeSideTree({ view: { status: { summaries: { staged: { "s.txt": { additions: 1, deletions: 2 } }, unstaged: { "u.txt": { additions: 3 } } } } } });
    ok(statusMod.fileSummary("s.txt", "S").includes("+1"));
    ok(statusMod.fileSummary("u.txt", "M").includes("+3"));
    // commit preview kind
    const previewMod = makeSideTree({
      view: { selectedCommitPreview: { diff: { files: [{ path: "c.txt" }] } }, status: {} },
      diffFiles: [],
    });
    ok(previewMod.fileSummary("c.txt", "C").includes("git-ui-file-summary"));
    equal(previewMod.commitPreviewFile("c.txt").path, "c.txt");
    equal(previewMod.commitPreviewFile("zzz"), undefined);
    // filesForKind across kinds
    const kinds = makeSideTree({ view: { compareFilePaths: ["cmp.txt"], diff: { files: [{ path: "d.txt" }] } } });
    sameJson(kinds.filesForKind("S"), ["src/s.txt"]);
    sameJson(kinds.filesForKind("M"), ["src/u.txt", "lib/x.txt"]);
    sameJson(kinds.filesForKind("?"), ["src/new/"]);
    sameJson(kinds.filesForKind("U"), ["src/c.txt"]);
    sameJson(kinds.filesForKind("C"), ["cmp.txt"]);
    sameJson(kinds.filesForKind("X"), []);
    const logMod = makeSideTree({ view: { tab: "log", selectedCommitPreview: { diff: { files: [{ path: "l.txt" }] } }, compareFilePaths: [], diff: null } });
    sameJson(logMod.filesForKind("C"), ["l.txt"]);
    const diffMod = makeSideTree({ view: { compareFilePaths: [], diff: { files: [{ path: "d.txt" }] } } });
    sameJson(diffMod.filesForKind("C"), ["d.txt"]);
    // fileTreeStatus and normalizeFileTreeStatus
    const statusKinds = makeSideTree({ diffFiles: [] });
    equal(statusKinds.fileTreeStatus("x", "M"), "modified");
    equal(statusKinds.normalizeFileTreeStatus("Added", "M"), "added");
    equal(statusKinds.normalizeFileTreeStatus("NEW", "M"), "added");
    equal(statusKinds.normalizeFileTreeStatus("removed", "M"), "deleted");
    equal(statusKinds.normalizeFileTreeStatus("renamed", "M"), "changed");
    equal(statusKinds.normalizeFileTreeStatus("copied", "M"), "changed");
    equal(statusKinds.normalizeFileTreeStatus("untracked", "M"), "untracked");
    equal(statusKinds.normalizeFileTreeStatus("conflicted", "M"), "conflict");
    equal(statusKinds.normalizeFileTreeStatus("", "M"), "modified");
    // folder status aggregates member statuses, direct member hit wins
    equal(dirMod.fileTreeStatus("src/a", "M"), "deleted");
    equal(mod.fileTreeStatus("a.txt", "M"), "modified");
    // filterFiles
    sameJson(mod.filterFiles(["A.txt", "b.txt"], "a"), ["A.txt"]);
    sameJson(mod.filterFiles(["x"], null), ["x"]);
    sameJson(mod.filterFiles(null, "x"), []);
    // commitPreviewSection gates and states
    equal(mod.commitPreviewSection({ tab: "changes", selectedLogCommits: ["h"] }), "");
    equal(mod.commitPreviewSection({ tab: "log", selectedLogCommits: [] }), "");
    const label = "abcdefghij12";
    match(mod.commitPreviewSection({ tab: "log", selectedLogCommits: [label], selectedCommitPreview: { loading: true } }), /Loading commit files/);
    match(mod.commitPreviewSection({ tab: "log", selectedLogCommits: [label], selectedCommitPreview: { error: "nope" } }), /git-ui-error">nope</);
    match(mod.commitPreviewSection({ tab: "log", selectedLogCommits: [label], selectedCommitPreview: { diff: { files: [{ path: "f" }] } } }), /Committed files abcdefghij12/);
    // sideFileCount across views
    equal(mod.sideFileCount({ tab: "log", status: {}, selectedCommitPreview: { diff: { files: [{ path: "a" }, { path: "b" }] } }, selectedLogCommits: ["h"] }), 2);
    equal(mod.sideFileCount({ tab: "stash", stashData: { stashes: [{}, {}] }, selectedStashDiff: { diff: { files: [{}, {}] } }, status: {} }), 4);
    equal(mod.sideFileCount({ tab: "stash", status: {} }), 0);
    equal(mod.sideFileCount({ committedFile: { hash: "x" }, file: "f", status: {} }), 1);
    equal(mod.sideFileCount({ status: { conflicted: ["c"], staged: ["s"], unstaged: ["u"], untracked: ["n"] } }), 4);
    equal(mod.sideFileCount(null), 0);
    const compareCounts = makeSideTree({ view: { mode: "compare", compareFilePaths: ["a", "b"] } });
    equal(compareCounts.sideFileCount(compareCounts.__view), 2);
    const diffCounts = makeSideTree({ view: { mode: "compare", compareFilePaths: [], diff: { files: [{ path: "a" }, { path: "b" }, { path: "c" }] } } });
    equal(diffCounts.sideFileCount(diffCounts.__view), 3);
  });
});

function makeLogRender(opts = {}) {
  const ctx = context();
  load(ctx, LOG_RENDER);
  const view = {
    cwd: "/repo", tab: "log", mode: "changes", file: "", logLimit: 80, logScope: "",
    logAll: false, logFilePath: "", logData: null, logFilters: {}, selectedLogCommits: [],
    selectedCommitPreview: null, status: { branch: "main" }, pendingLogScrollHash: "", loading: false,
    navigationStack: [], logLoadingMore: false,
  };
  if (opts.view) Object.assign(view, opts.view);
  const calls = { api: [], replaced: [], renders: 0 };
  const mod = ctx.HerdrGitUiLogRenderModule.create({
    active: () => (opts.noView ? null : view),
    api: async (url) => { calls.api.push(url); return opts.logData || { commits: [], has_more: false }; },
    esc: escFn,
    arg: argFn,
    gitLogDefaultBranch: () => "master",
    normalizeLogScope: (scope) => ["all", "base-current", "base"].includes(scope) ? scope : "all",
    GIT_LOG_PAGE_SIZE: 80,
    GIT_LOG_MAX_LIMIT: 500,
    isNoGitRepositoryView: () => !!opts.noRepo,
    renderFileToolbar: (tab) => `<toolbar tab="${tab}"/>`,
    renderCleanup: () => "<cleanup/>",
    renderStashDiff: () => "<stashdiff/>",
    renderConflictResolutionButtons: (file) => `<resolve file="${file}"/>`,
    renderDiff: () => "<diff/>",
    commitPreviewSection: () => "<preview/>",
    replaceContent: (version, html) => { calls.replaced.push({ version, html }); },
    render: () => { calls.renders += 1; },
  });
  ctx.HerdrGitLog = {
    render: (options) => `<log commits="${(options.data.commits || []).length}" limit="${options.logLimit}" scope="${options.logScope}" preview="${options.preview ? typeof options.preview : "none"}"/>`,
    scrollToCommit: (hash) => { calls.scrolled = hash; },
  };
  mod.__view = view;
  mod.__calls = calls;
  mod.__ctx = ctx;
  return mod;
}

describe("log_render coverage", () => {
  it("renders the log with cache, selection, and pending scroll", async () => {
    const mod = makeLogRender();
    const view = mod.__view;
    await mod.renderLog(1);
    equal(mod.__calls.api.length, 1);
    match(mod.__calls.api[0], /\/api\/git-ui\/log\?cwd=%2Frepo&all=false&scope=base-current&base=master&max=80$/);
    match(mod.__calls.replaced[0].html, /<log commits="0" limit="80" scope="base-current" preview="none"\/>/);
    // identical inputs are served from the cache
    await mod.renderLog(2);
    equal(mod.__calls.api.length, 1);
    equal(mod.__calls.replaced.length, 2);
    // selectedBranchForHash runs when exactly one commit is selected
    mod.__ctx.HerdrGitLog.selectedBranchForHash = () => "feat";
    view.selectedLogCommits = ["abc"];
    view.logScope = "all";
    await mod.renderLog(3);
    equal(view.selectedLogBranch, "feat");
    equal(mod.__calls.api.length, 2);
    match(mod.__calls.api[1], /all=true&scope=all/);
    // pending scroll hash fires requestAnimationFrame scroll
    view.pendingLogScrollHash = "abc";
    await mod.renderLog(4);
    equal(mod.__calls.scrolled, "abc");
    equal(view.pendingLogScrollHash, "");
    // responses for a view that left the log tab are dropped
    const stale = makeLogRender();
    await stale.renderLog(5);
    equal(stale.__calls.replaced.length, 1);
    stale.__view.tab = "changes";
    stale.__view.logScope = "base";
    await stale.renderLog(6);
    equal(stale.__calls.api.length, 2);
    equal(stale.__calls.replaced.length, 1);
    // file filter parameter and custom limit
    const fileMod = makeLogRender({ view: { logFilePath: "src/a.txt", logLimit: 120, logAll: true } });
    await fileMod.renderLog(1);
    match(fileMod.__calls.api[0], /&file=src%2Fa\.txt/);
    match(fileMod.__calls.replaced[0].html, /limit="120"/);
  });

  it("updates sticky offsets with searchbar, head, and observer", () => {
    const mod = makeLogRender();
    const searchbar = element();
    const head = element();
    const content = element();
    content.querySelector = (sel) => (sel === ".git-ui-log-searchbar" ? searchbar : sel === ".git-ui-log-table-head" ? head : null);
    const properties = [];
    content.style.setProperty = (name, value) => { properties.push([name, value]); };
    mod.__ctx.document.querySelectorAll = (sel) => (sel === ".git-ui-content.git-ui-content-log" ? [content] : []);
    let observerFn = null;
    mod.__ctx.ResizeObserver = class { constructor(fn) { observerFn = fn; } disconnect() {} observe() {} };
    mod.updateGitLogStickyOffsets();
    sameJson(properties, [["--git-log-search-sticky-height", "40px"], ["--git-log-table-head-sticky-height", "40px"]]);
    ok(observerFn, "resize observer created");
    // observer callback re-measures the searchbar
    observerFn();
    equal(properties.length, 3);
    // missing searchbar/head measure as zero
    const bare = makeLogRender();
    const bareContent = element();
    const bareProps = [];
    bareContent.style.setProperty = (name, value) => { bareProps.push([name, value]); };
    bare.__ctx.document.querySelectorAll = () => [bareContent];
    bare.updateGitLogStickyOffsets();
    sameJson(bareProps, [["--git-log-search-sticky-height", "0px"], ["--git-log-table-head-sticky-height", "0px"]]);
    // hidden nodes are skipped entirely
    mod.__ctx.document.querySelectorAll = () => [{ getClientRects: () => [] }];
    mod.updateGitLogStickyOffsets();
    // no log content anywhere: early return
    mod.__ctx.document.querySelectorAll = () => [];
    mod.updateGitLogStickyOffsets();
    equal(properties.length, 3);
    equal(bareProps.length, 2);
  });

  it("renders history rows, conflict actions, conflicts, and main panes", async () => {
    const mod = makeLogRender();
    match(await mod.renderHistory(), /Select file first\./);
    match(await mod.renderHistory(), /<toolbar tab="history"\/>/);
    // file-history payload maps into rows
    const rowsMod = makeLogRender({ view: { file: "a.txt" }, logData: { commits: [{ hash: "h1", message: "msg", author: "au", date: "2026-01-01" }] } });
    const historyHtml = await rowsMod.renderHistory();
    match(historyHtml, /<strong>h1<\/strong> msg/);
    match(historyHtml, /au 2026-01-01/);
    match(historyHtml, /showHistoryCommit\('h1'\)/);
    match(historyHtml, /gotoLogCommit\('h1'\)/);
    const emptyMod = makeLogRender({ view: { file: "a.txt" }, logData: { commits: [] } });
    match(await emptyMod.renderHistory(), /No history for selected file/);
    // conflict operation actions
    const actions = mod.renderConflictOperationActions();
    match(actions, /conflictAction\('rebase-continue'\)/);
    match(actions, /conflictAction\('rebase-skip'\)/);
    match(actions, /conflictAction\('rebase-abort'\)/);
    match(actions, /conflictAction\('merge-continue'\)/);
    match(actions, /conflictAction\('merge-abort'\)/);
    match(actions, /conflictAction\('cherry-pick-continue'\)/);
    match(actions, /conflictAction\('cherry-pick-abort'\)/);
    match(actions, /danger/);
    // conflicts pane with and without files
    const conflictsMod = makeLogRender({ view: { tab: "conflicts", status: { conflicted: ["a.txt"] } } });
    const conflictsHtml = conflictsMod.renderConflicts();
    match(conflictsHtml, /git-ui-conflict-file/);
    match(conflictsHtml, /<resolve file="a\.txt"\/>/);
    match(conflictsHtml, /Mark resolved \(stage\)/);
    match(conflictsHtml, /git-ui-conflict-help/);
    const noneMod = makeLogRender({ view: { tab: "conflicts", status: { conflicted: [] } } });
    const noneHtml = noneMod.renderConflicts();
    match(noneHtml, /No conflicts/);
    ok(!noneHtml.includes("git-ui-conflict-help"));
    ok(!noneHtml.includes("git-ui-conflict-actions"));
    // main pane states
    match(mod.renderMain(), /git-ui-content-log/);
    const loading = makeLogRender({ view: { loading: true } });
    match(loading.renderMain(), /Loading Git state/);
    const noRepo = makeLogRender({ noRepo: true });
    match(noRepo.renderMain(), /<cleanup\/>/);
    const changes = makeLogRender({ view: { tab: "changes" } });
    match(changes.renderMain(), /<diff\/>/);
    const stash = makeLogRender({ view: { tab: "stash" } });
    match(stash.renderMain(), /<stashdiff\/>/);
    const cleanup = makeLogRender({ view: { tab: "cleanup" } });
    match(cleanup.renderMain(), /<cleanup\/>/);
    const history = makeLogRender({ view: { tab: "history" } });
    match(history.renderMain(), /Loading history\.\.\./);
    match(makeLogRender().renderMain(), /Loading log\.\.\./);
  });
});