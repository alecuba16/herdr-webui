import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// Behavioral tests for the desktop Git explorer compare modes.
// The vm boots the same source set the server concatenates for the git-ui
// bundle (see src/assets.rs DESKTOP_GIT_UI_JS): shared helpers, git_ui
// modules, then git_ui.js. Assertions go through public outputs (fetch URLs)
// rather than internal state.

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
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

function context(fetchImpl) {
  const localStorage = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
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
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: () => element(),
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
    addEventListener() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const GIT_UI_SOURCE = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
const SHARED_SOURCES = [
  "./shared/core.js",
  "./shared/actions.js",
  "./shared/file_icons.js",
  "./shared/file_tree.js",
  "./shared/line_context.js",
  "./shared/file_content_search.js",
  "./shared/workspace_search.js",
  "./desktop/git_ui/settings.js",
  "./desktop/git_ui/syntax.js",
  "./desktop/git_ui/actions.js",
  "./desktop/git_ui/log.js",
]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n;\n");
// appRefreshIconButton comes from the desktop app bundle; stub it.
const APP_STUBS = `
function appRefreshIconButton() { return ""; }
`;

async function bootGitUi(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const raw = String(url);
    const path = raw.split("?")[0];
    const params = new URLSearchParams(raw.split("?")[1] || "");
    calls.push({ path, params, raw, init });
    const handler = responses[path];
    if (handler) {
      const body = typeof handler === "function" ? handler(params) : handler;
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const ctx = context(fetchImpl);
  vm.runInContext(SHARED_SOURCES, ctx);
  vm.runInContext(APP_STUBS, ctx);
  vm.runInContext(GIT_UI_SOURCE, ctx);
  const ui = ctx.window.HerdrGitUi;
  return { ui, ctx, calls };
}

const NEW = "cccccccccccccccccccccccccccccccccccccccc";
const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function emptyStatus() {
  return { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] };
}

async function openedWithStatus(status) {
  const booted = await bootGitUi({
    "/api/git-ui/status": status,
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
  });
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  return booted;
}

function lastPostCall(calls, path) {
  const posts = calls.filter((call) => call.path === path);
  return posts[posts.length - 1] || null;
}

test("folder context menu stages, unstages, and discards files under a directory", async () => {
  const booted = await openedWithStatus({
    branch: "main", ahead: 0, behind: 0,
    staged: ["src/lib/new.js"],
    unstaged: ["src/lib/changed.js"],
    untracked: ["src/lib/fresh.txt"],
    conflicted: [],
  });
  const { ui } = booted;
  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, "src/lib/", "M", "dir");
  // The menu is rendered from state.contextMenu; menuAction reads it.
  const menu = booted.ctx.window.HerdrGitUi;
  await ui.menuAction("stage");
  let call = lastPostCall(booted.calls, "/api/git-ui/stage");
  assert.ok(call, "expected a stage post");
  let body = JSON.parse(call.init.body);
  assert.deepEqual(body.paths.sort(), ["src/lib/changed.js", "src/lib/fresh.txt", "src/lib/new.js"], "stage must post every status path under the folder");
  await new Promise((resolve) => setTimeout(resolve, 20));

  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, "src/lib/", "M", "dir");
  await ui.menuAction("unstage");
  call = lastPostCall(booted.calls, "/api/git-ui/unstage");
  assert.ok(call, "expected an unstage post");
  body = JSON.parse(call.init.body);
  assert.equal(body.paths.length, 3, "unstage must post every status path under the folder");
  await new Promise((resolve) => setTimeout(resolve, 20));

  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, "src/lib/", "M", "dir");
  await ui.menuAction("discard");
  call = lastPostCall(booted.calls, "/api/git-ui/discard");
  assert.ok(call, "expected a discard post");
  body = JSON.parse(call.init.body);
  assert.deepEqual(body.paths, ["src/lib"], "discard must post the folder itself; the backend expands untracked files");
  assert.equal(body.confirmed, true, "discard must be pre-confirmed by the dialog");
});

test("untracked dir status entries render as directory rows, not phantom files", async () => {
  const booted = await openedWithStatus({
    branch: "main", ahead: 0, behind: 0,
    staged: [],
    unstaged: ["src/changed.js"],
    untracked: ["scratch/"],
    conflicted: [],
  });
  const html = booted.ctx.window.HerdrFileTree.renderPathTree(["src/changed.js", "scratch/"], {
    callback: "HerdrGitUi",
    toggleMethod: "toggleDir",
    selectMethod: "selectFile",
    activateMethod: "activateTreeItem",
    contextMethod: "fileMenu",
    dirContextKind: "dir",
    dataPrefix: "git",
    rowClass: "git-ui-file",
    kind: "M",
  });
  assert.match(html, /herdr-tree-row dir[^"]*"/, "scratch/ must render a dir row");
  const phantom = /herdr-tree-row file[^>]*title="scratch\/"/;
  assert.ok(!phantom.test(html), "scratch/ must not render a phantom file row");
  assert.match(html, /oncontextmenu="return HerdrGitUi\.fileMenu\(event,'scratch'[^)]*,'dir'\)"/, "dir rows must pass the dir context kind");
});

test("folder context menu stages files in nested subdirectories of the target", async () => {
  const booted = await openedWithStatus({
    branch: "main", ahead: 0, behind: 0,
    staged: [],
    unstaged: ["docs/api/spec.md"],
    untracked: ["docs/api/draft.txt", "other/root.txt"],
    conflicted: [],
  });
  const { ui } = booted;
  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, "docs/", "M", "dir");
  await ui.menuAction("stage");
  const call = lastPostCall(booted.calls, "/api/git-ui/stage");
  assert.ok(call, "expected a stage post");
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.paths.sort(), ["docs/api/draft.txt", "docs/api/spec.md"], "only paths under docs/ are staged");
});

function lastCompareCall(calls) {
  const compare = calls.filter((call) => call.path === "/api/git-ui/compare");
  return compare[compare.length - 1] || null;
}

test("compareSelectedLog puts the newest commit on the target (right) side", async () => {
  const logResponse = { commits: [{ hash: NEW }, { hash: OLD }], lines: [], rows: [], has_more: false, limit: 80 };
  const boot = () => bootGitUi({
    "/api/git-ui/status": emptyStatus(),
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": logResponse,
  });

  // Click order 1: OLD first, then NEW.
  const first = await boot();
  await first.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  first.ui.tab("log");
  await new Promise((resolve) => setTimeout(resolve, 20));
  first.ui.selectLogCommit({ shiftKey: true }, OLD);
  first.ui.selectLogCommit({ shiftKey: true }, NEW);
  await first.ui.compareSelectedLog();
  let call = lastCompareCall(first.calls);
  assert.ok(call, "expected a compare request");
  assert.equal(call.params.get("base"), OLD, "older commit must be the base (left side)");
  assert.equal(call.params.get("target"), NEW, "newest commit must be the target (right side)");

  // Click order 2: NEW first, then OLD — the result must be identical.
  const second = await boot();
  await second.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  second.ui.tab("log");
  await new Promise((resolve) => setTimeout(resolve, 20));
  second.ui.selectLogCommit({ shiftKey: true }, NEW);
  second.ui.selectLogCommit({ shiftKey: true }, OLD);
  await second.ui.compareSelectedLog();
  call = lastCompareCall(second.calls);
  assert.ok(call, "expected a compare request");
  assert.equal(call.params.get("base"), OLD, "older commit must stay the base regardless of click order");
  assert.equal(call.params.get("target"), NEW, "newest commit must stay the target regardless of click order");
});

test("current-compare keeps the working tree on the target (right) side", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": emptyStatus(),
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [{ hash: NEW }], lines: [], rows: [], has_more: false, limit: 80 },
  });
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  booted.ui.selectLogCommit({ shiftKey: true }, NEW);
  booted.ui.openSelectedCompareModal();
  await booted.ui.compareSelectedWithCurrent();
  const call = lastCompareCall(booted.calls);
  assert.ok(call, "expected a compare request");
  assert.equal(call.params.get("base"), NEW, "selected commit must be the base");
  assert.equal(call.params.get("target"), ".", "working tree must be the target (right side)");
  assert.equal(call.params.get("merge_base"), "true", "current-compare must request a merge base");
});