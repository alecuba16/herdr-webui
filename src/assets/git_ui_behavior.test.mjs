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
  "./desktop/git_ui/primitives.js",
  "./desktop/git_ui/diff_search.js",
  "./desktop/git_ui/syntax.js",
  "./desktop/git_ui/log.js",
  "./desktop/git_ui/shortcuts.js",
  "./desktop/git_ui/stash.js",
  "./desktop/git_ui/cleanup.js",
  "./desktop/git_ui/diff_render.js",
  "./desktop/git_ui/conflicts.js",
  "./desktop/git_ui/side_tree.js",
  "./desktop/git_ui/modals.js",
  "./desktop/git_ui/branch_list.js",
  "./desktop/git_ui/toasts.js",
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

// The vm document stub captures the git panel's rendered HTML so tests can
// assert on toolbar buttons and modal markup.
function ctxHtml(booted) {
  return (booted.ctx.document.__panelHtml || "");
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
test("showChangesList exits current-compare back to plain working-tree diff", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": emptyStatus(),
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [{ hash: NEW }], lines: [], rows: [], has_more: false, limit: 80 },
  });
  const { ui } = booted;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  ui.selectLogCommit({ shiftKey: true }, NEW);
  ui.openSelectedCompareModal();
  await ui.compareSelectedWithCurrent();
  let call = lastCompareCall(booted.calls);
  assert.ok(call, "expected the current-compare request");
  assert.equal(call.params.get("target"), ".");
  // Leaving compare mode must reload the working-tree diff, not the compare.
  await ui.showChangesList();
  const last = booted.calls[booted.calls.length - 1];
  assert.equal(last.path, "/api/git-ui/diff", "returning to changes must fetch the working-tree diff");
  assert.equal(last.params.get("cwd"), "/tmp/demo-repo");
});

test("folder mutations are hidden and refused outside the changes view", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": emptyStatus(),
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [{ hash: NEW }, { hash: OLD }], lines: [], rows: [], has_more: false, limit: 80 },
  });
  const { ui } = booted;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  // Enter a compare mode with a dirty working tree to simulate the Compared
  // section showing a dir row.
  ui.selectLogCommit({ shiftKey: true }, NEW);
  ui.openSelectedCompareModal();
  await ui.compareSelectedWithCurrent();
  const before = booted.calls.length;
  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, "src/", "M", "dir");
  await ui.menuAction("stage");
  const staged = booted.calls.slice(before).filter((call) => call.path === "/api/git-ui/stage");
  assert.equal(staged.length, 0, "no stage POST may fire outside changes mode");
});

test("status button labels Pull/Push/Fetch from sync state and runs the matching action", async () => {
  // In sync: plain Fetch, no arrows or counts.
  const synced = await openedWithStatus({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/main" });
  let html = String(ctxHtml(synced));
  assert.match(html, /git-ui-status-label" data-method="fetchOrigin"[^>]*title="git fetch origin"[^>]*>Fetch</);
  assert.ok(!/Pull ↓|Push ↑/.test(html), "synced status shows no arrows");
  assert.ok(!html.includes("updateFromUpstream"), "old Update button is gone");
  assert.ok(!html.includes("git-ui-split"), "old split button is gone");
  assert.ok(!/HerdrGitUi\.rebase\(\)">Rebase</.test(html), "old Rebase button is gone");
  assert.ok(!/HerdrGitUi\.reset\(\)">Reset</.test(html), "old Reset button is gone");

  const before = synced.calls.length;
  await synced.ui.runStatusAction();
  const fetchPosts = synced.calls.slice(before).filter((call) => call.path === "/api/git-ui/fetch");
  assert.equal(fetchPosts.length, 1, "synced status runs fetch");
  assert.equal(JSON.parse(fetchPosts[0].init.body).cwd, "/tmp/demo-repo");

  // Behind: Pull ↓N posts mode=update (fetch + ff-only, no branch).
  const behind = await openedWithStatus({ branch: "main", ahead: 0, behind: 3, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/main" });
  html = String(ctxHtml(behind));
  assert.match(html, /git-ui-status-label" data-method="pullUpdateFromUpstream"[^>]*>Pull ↓3</);
  const beforePull = behind.calls.length;
  await behind.ui.pullUpdateFromUpstream();
  const pullPosts = behind.calls.slice(beforePull).filter((call) => call.path === "/api/git-ui/pull");
  assert.equal(pullPosts.length, 1, "exactly one pull POST fired");
  assert.equal(JSON.parse(pullPosts[0].init.body).mode, "update");
  assert.equal(JSON.parse(pullPosts[0].init.body).branch, undefined);

  // Ahead: Push ↑N posts a regular push.
  const ahead = await openedWithStatus({ branch: "main", ahead: 2, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/main" });
  html = String(ctxHtml(ahead));
  assert.match(html, /git-ui-status-label" data-method="pushNow"[^>]*>Push ↑2</);
  const beforePush = ahead.calls.length;
  await ahead.ui.pushNow();
  const pushPosts = ahead.calls.slice(beforePush).filter((call) => call.path === "/api/git-ui/push");
  assert.equal(pushPosts.length, 1, "push POST fired");
  assert.equal(JSON.parse(pushPosts[0].init.body).mode, "regular");

  // Pull modal still offers Update as the default mode.
  await ahead.ui.openPullModal();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pullHtml = String(ctxHtml(ahead));
  assert.match(pullHtml, /<option value="update" selected>Update \(fetch \+ fast-forward\)<\/option>/);
  await ahead.ui.closeGitOpModal();
});

test("header menu dropdown offers exactly the seven git-flow actions", async () => {
  const booted = await openedWithStatus(emptyStatus());
  const { ui, calls } = booted;

  // Old Update/split toolbar buttons no longer exist.
  let html = String(ctxHtml(booted));
  assert.ok(!html.includes("git-ui-header-menu"), "menu closed initially");

  const toggleEvent = { stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 40, bottom: 60 }) }, clientX: 40, clientY: 60 };
  ui.toggleHeaderMenu(toggleEvent);
  html = String(ctxHtml(booted));
  assert.match(html, /class="git-ui-menu git-ui-header-menu"/);
  const items = (html.match(/git-ui-header-menu" style[^>]*>.*?<\/div>/s) || [""])[0]
    .split(/<button onclick="HerdrGitUi\./).slice(1)
    .map((chunk) => (chunk.match(/^([a-zA-Z]+)\(\)/) || [])[1]);
  assert.deepEqual(items, ["fetchOrigin", "openFetchFromModal", "openPullModal", "pullWithRebase", "openPushModal", "openPushToModal", "openForcePushModal"], "exactly seven menu items in Zed order");
  const labels = (html.match(/git-ui-header-menu" style[^>]*>.*?<\/div>/s) || [""])[0]
    .match(/<button onclick="[^"]*">[^<]+/g)
    .map((chunk) => chunk.replace(/^<button onclick="[^"]*">/, ""));
  assert.deepEqual(labels, ["Fetch", "Fetch From", "Pull", "Pull (rebase)", "Push", "Push to", "Force push"], "menu labels match the Zed wording");

  // Fetch from the menu posts to the fetch endpoint.
  const before = calls.length;
  await ui.fetchOrigin();
  const fetchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/fetch");
  assert.equal(fetchPosts.length, 1, "fetch POST fired");
  assert.equal(JSON.parse(fetchPosts[0].init.body).cwd, "/tmp/demo-repo");
  assert.equal(JSON.parse(fetchPosts[0].init.body).branch, undefined);

  // Pull (rebase) posts mode=rebase.
  ui.toggleHeaderMenu(toggleEvent); // reopen
  const beforeRebase = calls.length;
  await ui.pullWithRebase();
  const pullPosts = calls.slice(beforeRebase).filter((call) => call.path === "/api/git-ui/pull");
  assert.equal(pullPosts.length, 1, "pull POST fired");
  assert.equal(JSON.parse(pullPosts[0].init.body).mode, "rebase");
  const menuHtml = String(ctxHtml(booted));
  assert.ok(!menuHtml.includes("git-ui-header-menu"), "menu closes after action");
});

test("branch chip shows the branch and the status button shows sync arrows when diverged", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "feature-x", ahead: 2, behind: 3, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/feature-x" },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
    "/api/git-ui/branches": { local: [{ name: "main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }, { name: "feature-x", author: "Bob", date: "2026-01-03T03:04:05Z", subject: "wip" }], remote: [{ name: "origin/main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }] },
  });
  const { ui } = booted;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });

  let html = String(ctxHtml(booted));
  assert.match(html, /git-ui-branch-chip/);
  assert.match(html, /<span class="git-ui-branch-chip-name">feature-x<\/span>/);
  // Incoming wins: Pull ↓3 on the status button (behind takes priority).
  assert.match(html, /data-method="pullUpdateFromUpstream"[^>]*>Pull ↓3</);

  const chipEvent = { stopPropagation() {}, currentTarget: null, clientX: 0, clientY: 0 };
  await ui.openBranchList(chipEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  html = String(ctxHtml(booted));
  assert.match(html, /git-ui-branch-list"/);
  assert.match(html, /Local branches/);
  assert.match(html, /Remote branches/);
  // Two-line rows: name line and author · relative time meta line; hover
  // title carries the commit subject and details.
  assert.match(html, /title="[^"]*Ada[^"]*"/);
  assert.match(html, /git-ui-branch-row-meta">[^<]*Ada[^<]*<\/span>/);
  // Current branch pinned first with a ✓ check; other rows show the branch icon.
  assert.match(html, /✓<\/b><span class="git-ui-branch-row-name-text">feature-x<\/span>/, "current branch row carries the ✓ check");
  const localSection = html.indexOf("Local branches");
  const firstRowAfterSection = html.slice(localSection).indexOf("git-ui-branch-row");
  const firstRow = html.slice(localSection + firstRowAfterSection, localSection + firstRowAfterSection + 400);
  assert.ok(localSection === -1 || firstRow.includes("feature-x"), "current branch row is pinned at the top of the local section");
  assert.match(html, /git-ui-branch-row-icon/);
  // Trash icon is wired for non-current rows.
  assert.match(html, /deleteFromBranchList/);
  // Filter lives below the scrollable rows.
  assert.ok(html.indexOf("git-ui-branch-list-scroll") < html.indexOf("git-ui-branch-list-filter"), "filter sits at the bottom");

  // Filter narrows the visible rows: in the vm the DOM stub cannot swap
  // nodes, so assert the renderer honors the filter by re-rendering.
  ui.branchListFilter("main");
  html = String(ctxHtml(booted));
  assert.ok(html.includes("main"), "matching branch stays visible");
  const renderedNames = (html.match(/git-ui-branch-row-name">.*?<\/span>/g) || []).join(" ");
  assert.ok(!renderedNames.includes("feature-x"), "filtered rows hide non-matching branch");

  // Switching to another local branch posts to /switch with the bare name.
  const before = booted.calls.length;
  await ui.switchFromBranchList(encodeURIComponent("main"), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const switchPosts = booted.calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
  assert.equal(switchPosts.length, 1, "switch POST fired");
  assert.equal(JSON.parse(switchPosts[0].init.body).branch, "main");
  assert.ok(!String(ctxHtml(booted)).includes("git-ui-branch-list"), "list closes after switch");
});

test("status button shows plain Fetch and the chip no check when in sync with upstream", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/main" },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
  });
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  const html = String(ctxHtml(booted));
  assert.match(html, /git-ui-status-label" data-method="fetchOrigin"[^>]*title="git fetch origin"[^>]*>Fetch</);
  assert.ok(!/chip-count/.test(html), "sync badges moved off the chip");
});

test("branch list trash deletes a local branch and refreshes the list", async () => {
  const branches = { local: [{ name: "main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }, { name: "wip", author: "Bob", date: "2026-01-03T03:04:05Z", subject: "wip" }], remote: [] };
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], upstream: "origin/main" },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
    "/api/git-ui/branches": () => ({ local: branches.local, remote: branches.remote }),
    // Deleting really drops the branch, so the list reload loses the row.
    "/api/git-ui/branch-delete": () => {
      branches.local = branches.local.filter((branch) => branch.name !== "wip");
      return { ok: true, message: "" };
    },
  });
  const { ui, calls } = booted;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });

  // Current branch rows show no trash icon.
  await ui.openBranchList({ stopPropagation() {}, currentTarget: null, clientX: 0, clientY: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let html = String(ctxHtml(booted));
  assert.match(html, /aria-label="Delete branch wip"/);
  const mainRow = (html.match(/git-ui-branch-row current[\s\S]*?<\/div>/) || [""])[0];
  assert.ok(!mainRow.includes("branch-row-trash"), "current branch row has no trash icon");

  // Deleting refuses the current branch and remote rows without posting.
  const before = calls.length;
  await ui.deleteFromBranchList(encodeURIComponent("main"), false);
  await ui.deleteFromBranchList(encodeURIComponent("origin/main"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.slice(before).filter((call) => call.path === "/api/git-ui/branch-delete").length, 0, "no delete POST for current or remote branch");

  // Deleting a local branch posts to the endpoint, then reloads the list.
  const deleteIndex = calls.length;
  await ui.deleteFromBranchList(encodeURIComponent("wip"), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deletePosts = calls.slice(deleteIndex).filter((call) => call.path === "/api/git-ui/branch-delete");
  assert.equal(deletePosts.length, 1, "one branch-delete POST fired");
  const body = JSON.parse(deletePosts[0].init.body);
  assert.equal(body.branch, "wip");
  assert.equal(body.confirmed, true);
  // The handler reloads the branches endpoint; wip is gone from the list.
  html = String(ctxHtml(booted));
  assert.match(html, /git-ui-branch-list"/);
  assert.ok(!/aria-label="Delete branch wip"/.test(html), "deleted branch is gone from the list");
});

test("stash renderer module is registered and wired before git_ui.js consumes it", async () => {
  const stashSource = readFileSync(new URL("./desktop/git_ui/stash.js", import.meta.url), "utf8");
  assert.match(stashSource, /globalThis\.HerdrGitUiStashModule = \{ create: createGitUiStash \}/);
  assert.match(stashSource, /\/api\/git-ui\/stashes\?cwd=/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiStashModule\.create\(\{/);
  assert.match(gitUiSource, /const renderStash = stash\.renderStash;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const stashIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/stash.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(stashIndex > -1 && stashIndex < gitUiIndex, "stash.js concatenates before git_ui.js");
});

test("cleanup renderer module is registered and wired before git_ui.js consumes it", () => {
  const cleanupSource = readFileSync(new URL("./desktop/git_ui/cleanup.js", import.meta.url), "utf8");
  assert.match(cleanupSource, /globalThis\.HerdrGitUiCleanupModule = \{ create: createGitUiCleanup \}/);
  assert.match(cleanupSource, /git-ui-cleanup-bulk/);
  assert.match(cleanupSource, /use --force/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiCleanupModule\.create\(\{/);
  assert.match(gitUiSource, /const renderCleanup = cleanup\.renderCleanup;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const cleanupIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/cleanup.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(cleanupIndex > -1 && cleanupIndex < gitUiIndex, "cleanup.js concatenates before git_ui.js");
});

test("diff render module is registered and wired before git_ui.js consumes it", () => {
  const diffRenderSource = readFileSync(new URL("./desktop/git_ui/diff_render.js", import.meta.url), "utf8");
  assert.match(diffRenderSource, /globalThis\.HerdrGitUiDiffRenderModule = \{ create: createGitUiDiffRender \}/);
  assert.match(diffRenderSource, /\/api\/git-ui\/blame\?cwd=/);
  assert.match(diffRenderSource, /git-ui-word-change/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiDiffRenderModule\.create\(\{/);
  assert.match(gitUiSource, /const renderChunk = diffRender\.renderChunk;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const diffIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/diff_render.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(diffIndex > -1 && diffIndex < gitUiIndex, "diff_render.js concatenates before git_ui.js");
});

test("conflicts module is registered and wired before git_ui.js consumes it", () => {
  const conflictsSource = readFileSync(new URL("./desktop/git_ui/conflicts.js", import.meta.url), "utf8");
  assert.match(conflictsSource, /globalThis\.HerdrGitUiConflictsModule = \{ create: createGitUiConflicts \}/);
  assert.match(conflictsSource, /function conflictBlocksInText\(text\)/);
  assert.match(conflictsSource, /HerdrGitUi\.resolveEditorConflictBlock\(/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiConflictsModule\.create\(\{/);
  assert.match(gitUiSource, /const renderSideEditor = conflicts\.renderSideEditor;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const conflictsIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/conflicts.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(conflictsIndex > -1 && conflictsIndex < gitUiIndex, "conflicts.js concatenates before git_ui.js");
});

test("conflict block parsing resolves ours, base, and theirs per block", () => {
  const conflictsSource = readFileSync(new URL("./desktop/git_ui/conflicts.js", import.meta.url), "utf8");
  const ctx = context(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vm.runInContext(conflictsSource, ctx);
  const create = ctx.globalThis.HerdrGitUiConflictsModule.create;
  const deps = {
    active: () => ({ status: { conflicted: ["src/app.js"] } }),
    esc: (s) => String(s),
    arg: (s) => String(s),
    currentMode: () => "changes",
    diffLayoutMode: () => "side-by-side",
  };
  const mod = create(deps);
  const text = [
    "shared top",
    "<<<<<<< HEAD",
    "ours line",
    "||||||| base",
    "base line",
    "=======",
    "theirs line",
    ">>>>>>> remote",
    "shared bottom",
  ].join("\n");
  const blocks = mod.conflictBlocksInText(text);
  assert.equal(blocks.length, 1);
  assert.equal(JSON.stringify(blocks[0].ours), JSON.stringify(["ours line"]));
  assert.equal(JSON.stringify(blocks[0].base), JSON.stringify(["base line"]));
  assert.equal(JSON.stringify(blocks[0].theirs), JSON.stringify(["theirs line"]));
  assert.equal(mod.resolveConflictBlockText(text, 0, "ours").includes("theirs line"), false);
  assert.equal(mod.resolveConflictBlockText(text, 0, "base").includes("base line"), true);
  assert.equal(mod.resolveConflictBlockText(text, 0, "theirs").includes("ours line"), false);
  // A block without the ||||||| base section resolves base to null (button disabled).
  const twoWay = ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> e"].join("\n");
  const twoWayBlocks = mod.conflictBlocksInText(twoWay);
  assert.equal(twoWayBlocks.length, 1);
  assert.equal(twoWayBlocks[0].base, null);
  assert.equal(mod.resolveConflictBlockText(twoWay, 0, "base"), twoWay);
});

test("conflict resolution buttons render per mode and conflicted path", () => {
  const conflictsSource = readFileSync(new URL("./desktop/git_ui/conflicts.js", import.meta.url), "utf8");
  const ctx = context(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vm.runInContext(conflictsSource, ctx);
  const create = ctx.globalThis.HerdrGitUiConflictsModule.create;
  let mode = "changes";
  const mod = create({
    active: () => ({ status: { conflicted: ["src/app.js"] } }),
    esc: (s) => String(s),
    arg: (s) => String(s),
    currentMode: () => mode,
    diffLayoutMode: () => "side-by-side",
  });
  const conflicted = { path: "src/app.js" };
  const clean = { path: "README.md" };
  assert.match(mod.renderDiffConflictResolutionButtons(conflicted), /git-ui-conflict-diff-actions/);
  assert.match(mod.renderDiffConflictResolutionButtons(conflicted), />Mark resolved</);
  assert.equal(mod.renderDiffConflictResolutionButtons(clean), "");
  mode = "current-compare";
  assert.equal(mod.renderDiffConflictResolutionButtons(conflicted), "");
  const full = mod.renderConflictResolutionButtons("src/app.js");
  assert.match(full, /HerdrGitUi\.resolve\('src\/app\.js','ours'\)/);
  assert.match(full, /HerdrGitUi\.resolve\('src\/app\.js','base'\)/);
  assert.match(full, /HerdrGitUi\.resolve\('src\/app\.js','theirs'\)/);
  assert.match(full, /HerdrGitUi\.resolve\('src\/app\.js','mark'\)/);
});

test("side editor renders editable hunks with conflict block controls", () => {
  const conflictsSource = readFileSync(new URL("./desktop/git_ui/conflicts.js", import.meta.url), "utf8");
  const ctx = context(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vm.runInContext(conflictsSource, ctx);
  const create = ctx.globalThis.HerdrGitUiConflictsModule.create;
  let layout = "side-by-side";
  const mod = create({
    active: () => null,
    esc: (s) => String(s),
    arg: (s) => String(s),
    currentMode: () => "changes",
    diffLayoutMode: () => layout,
  });
  const conflictedHunk = {
    index: 0,
    header: "@@ -1,3 +1,5 @@",
    oldText: "base",
    text: ["ours", "<<<<<<< HEAD", "keep", "=======", "new", ">>>>>>> r"].join("\n"),
    newStart: 1,
    newEnd: 5,
  };
  const sideHtml = mod.renderSideEditor({ sideEditor: { hunks: [conflictedHunk] } });
  assert.match(sideHtml, /git-ui-hunk-editor-list/);
  assert.match(sideHtml, /Previous hunk stays read-only/);
  assert.match(sideHtml, /Conflict block 1/);
  assert.match(sideHtml, /HerdrGitUi\.resolveEditorConflictBlock\(0,0,'ours'\)/);
  assert.match(sideHtml, /disabled>Use parent</);
  layout = "unified";
  const unifiedHtml = mod.renderSideEditor({ sideEditor: { hunks: [conflictedHunk] } });
  assert.match(unifiedHtml, /Edit the hunk text below/);
  assert.match(unifiedHtml, /git-ui-hunk-editor-unified/);
  const loading = mod.renderSideEditor({ sideEditor: { loading: true } });
  assert.match(loading, /Loading file editor/);
});

test("buildEditableHunks splits chunk lines into old and current hunk text", () => {
  const conflictsSource = readFileSync(new URL("./desktop/git_ui/conflicts.js", import.meta.url), "utf8");
  const ctx = context(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vm.runInContext(conflictsSource, ctx);
  const create = ctx.globalThis.HerdrGitUiConflictsModule.create;
  const mod = create({
    active: () => null,
    esc: (s) => String(s),
    arg: (s) => String(s),
    currentMode: () => "changes",
    diffLayoutMode: () => "side-by-side",
  });
  const file = {
    chunks: [{
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { line_type: "context", content: "shared", new_line_number: 1 },
        { line_type: "delete", content: "old", old_line_number: 2 },
        { line_type: "add", content: "new", new_line_number: 2 },
      ],
    }],
  };
  const hunks = mod.buildEditableHunks(file);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldText, "shared\nold");
  assert.equal(hunks[0].text, "shared\nnew");
  assert.equal(JSON.stringify(hunks[0].oldLineTypes), JSON.stringify(["context", "del"]));
  assert.equal(JSON.stringify(hunks[0].newLineTypes), JSON.stringify(["context", "add"]));
  assert.equal(hunks[0].newStart, 1);
  assert.equal(hunks[0].newEnd, 2);
});

test("side tree module is registered and wired before git_ui.js consumes it", () => {
  const sideTreeSource = readFileSync(new URL("./desktop/git_ui/side_tree.js", import.meta.url), "utf8");
  assert.match(sideTreeSource, /globalThis\.HerdrGitUiSideTreeModule = \{ create: createGitUiSideTree \}/);
  assert.match(sideTreeSource, /function renderFileTree\(files, kind, view, options\)/);
  assert.match(sideTreeSource, /FileTree\.renderPathTree\(files, \{/);
  assert.match(sideTreeSource, /git-ui-stash-entry/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiSideTreeModule\.create\(\{/);
  assert.match(gitUiSource, /const section = sideTree\.section;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const sideTreeIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/side_tree.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(sideTreeIndex > -1 && sideTreeIndex < gitUiIndex, "side_tree.js concatenates before git_ui.js");
});

test("side tree sections render status trees with bulk actions and limits", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "main", ahead: 0, behind: 0, staged: ["src/app.js"], unstaged: ["src/lib.js"], untracked: ["scratchdir/"], conflicted: ["src/conf.js"] },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
  });
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  const html = ctxHtml(booted);
  // Sections render for all four kinds with counts.
  assert.match(html, /git-ui-section-head[\s\S]*?>Conflicted</);
  assert.match(html, /Staged</);
  assert.match(html, /Unstaged</);
  assert.match(html, /Untracked</);
  // Staged section carries the unstage-all bulk action; unstaged/untracked carry stage-all.
  assert.match(html, /HerdrGitUi\.bulkSectionAction\('unstage','Staged'\)/);
  assert.match(html, /HerdrGitUi\.bulkSectionAction\('stage','Unstaged'\)/);
  assert.match(html, /HerdrGitUi\.bulkSectionAction\('stage','Untracked'\)/);
  // Conflicted kind has no bulk action button.
  const conflictedChunk = (html.split("Conflicted")[1] || "").split("</div>")[0] + (html.split("Conflicted")[1] || "").slice(0, 400);
  assert.ok(!conflictedChunk.includes("bulkSectionAction('stage','Conflicted')"), "conflicted section has no bulk action");
  // File rows are rendered by the shared FileTree (renderPathTree), so assert
  // the shared row markup with the git callback instead of direct onclick.
  assert.match(html, /herdr-tree-row file git-ui-file/);
  assert.ok(html.includes("src/app.js"), "staged file appears in the tree");
});

test("side tree stash tab renders stash list and file sections through the module", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], stashes: 2 },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
    "/api/git-ui/stashes": { stashes: [{ name: "stash@{0}", date: "2024-01-01", message: "wip" }, { name: "stash@{1}", date: "2024-01-02", message: "wip2" }] },
    "/api/git-ui/stash-show": { files: [{ path: "src/app.js" }] },
  });
  await booted.ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  const ui = booted.ui;
  ui.tab("stash");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const html = ctxHtml(booted);
  assert.match(html, /git-ui-stash-list/);
  assert.match(html, /stash \(2\)/);
  await ui.selectStash(encodeURIComponent("stash@{0}"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stashHtml = ctxHtml(booted);
  assert.match(stashHtml, /Stash files stash 0/);
  assert.ok(stashHtml.includes("src/app.js"), "stash file appears in the tree");
  assert.match(stashHtml, /No files in this stash|herdr-tree-row/);
});

test("modals module is registered and wired before git_ui.js consumes it", () => {
  const modalsSource = readFileSync(new URL("./desktop/git_ui/modals.js", import.meta.url), "utf8");
  assert.match(modalsSource, /globalThis\.HerdrGitUiModalsModule = \{ create: createGitUiModals \}/);
  assert.match(modalsSource, /git-ui-modal-backdrop/);
  assert.match(modalsSource, /Commit & Push/);
  assert.match(modalsSource, /Retry push/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiModalsModule\.create\(\{/);
  assert.match(gitUiSource, /const renderCommitModal = modals\.renderCommitModal;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const modalsIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/modals.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(modalsIndex > -1 && modalsIndex < gitUiIndex, "modals.js concatenates before git_ui.js");
});

test("modals render commit and git-op flows from module state", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "main", ahead: 0, behind: 0, staged: ["src/app.js"], unstaged: [], untracked: [], conflicted: [] },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
    "/api/git-ui/branches": { local: [{ name: "main", current: true }, { name: "feature-x" }], remote: [{ name: "origin/feature-x", remote: true }] },
  });
  const ui = booted.ui;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  // Commit modal: opens, toggles body textarea, drafts persist.
  ui.openCommitModal();
  let html = ctxHtml(booted);
  assert.match(html, /Commit staged changes/);
  assert.match(html, /HerdrGitUi\.commitFromModal\(true\)">Commit & Push</);
  assert.ok(!/gitCommitBody/.test(html), "body textarea hidden before toggle");
  ui.toggleCommitBody(true);
  html = ctxHtml(booted);
  assert.match(html, /id="gitCommitBody"/);
  // Pull modal: loads branches and renders the pull mode select via the module.
  await ui.openPullModal();
  await new Promise((resolve) => setTimeout(resolve, 300));
  html = ctxHtml(booted);
  assert.match(html, /Pull changes/);
  assert.match(html, /id="gitUiOpMode"/);
  assert.match(html, /Update \(fetch \+ fast-forward\)/);
  assert.match(html, /HerdrGitUi\.runPullFromModal\(\)/);
  // Branch select dedupes and marks the current branch; the default for pull
  // is Current upstream, so main carries the (current) label without selected.
  assert.match(html, /<option value="main"[^>]*>main \(current\)<\/option>/);
  assert.match(html, /<option value="" selected>Current upstream<\/option>/);
});

test("branch list module is registered and wired before git_ui.js consumes it", () => {
  const branchListSource = readFileSync(new URL("./desktop/git_ui/branch_list.js", import.meta.url), "utf8");
  assert.match(branchListSource, /globalThis\.HerdrGitUiBranchListModule = \{ create: createGitUiBranchList \}/);
  assert.match(branchListSource, /function branchListRow\(branch, currentBranch\)/);
  assert.match(branchListSource, /Local branches/);
  assert.match(branchListSource, /Load more branches/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiBranchListModule\.create\(\{/);
  assert.match(gitUiSource, /const renderBranchList = branchList\.renderBranchList;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const branchListIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/branch_list.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(branchListIndex > -1 && branchListIndex < gitUiIndex, "branch_list.js concatenates before git_ui.js");
});

test("primitives clamp option values, escape html, and build diff keys", () => {
  const primitivesSource = readFileSync(new URL("./desktop/git_ui/primitives.js", import.meta.url), "utf8");
  const ctx = vm.createContext({ window: {}, globalThis: null, console, Math, JSON, Object, Array, String, Number, Set, encodeURIComponent, Error });
  ctx.globalThis = ctx;
  vm.runInContext(primitivesSource, ctx);
  const primitives = ctx.globalThis.HerdrGitUiPrimitivesModule.create();
  // No HerdrOptions: defaults must apply and reads must not throw.
  assert.deepEqual([
    primitives.largeDiffLineLimit(),
    primitives.largeChangeFileLimit(),
    primitives.largeSectionFileLimit(),
    primitives.gitRemoteBranchPreload(),
  ], [2000, 25, 250, 10]);
  assert.equal(primitives.fileListMode(), "tree");
  assert.equal(primitives.diffLayoutMode(), "side-by-side");
  assert.equal(primitives.gitLogDefaultBranch(), "master");
  assert.equal(primitives.normalizeLogScope("bogus"), "all");
  assert.equal(primitives.normalizeLogScope("base-current"), "base-current");
  assert.equal(primitives.normalizeLogScope("base"), "base");
  // With HerdrOptions: values are clamped and normalized.
  ctx.window.HerdrOptions = {
    read: () => ({ gitUiLargeDiffLineLimit: -5, gitUiLargeChangeFileLimit: 999, gitUiRemoteBranchPreload: 500, gitUiFileListMode: "flat", gitUiDiffLayout: "unified", gitUiDefaultBranch: "  develop  " }),
  };
  assert.equal(primitives.largeDiffLineLimit(), 0, "negative clamps to 0");
  assert.equal(primitives.largeChangeFileLimit(), 999, "finite passes through");
  assert.equal(primitives.gitRemoteBranchPreload(), 100, "preload caps at 100");
  assert.equal(primitives.fileListMode(), "flat");
  assert.equal(primitives.diffLayoutMode(), "unified");
  assert.equal(primitives.gitLogDefaultBranch(), "develop", "default branch trims");
  // esc/arg escaping.
  assert.equal(primitives.esc("<a href=\"x\">&amp;"), "&lt;a href=&quot;x&quot;&gt;&amp;amp;");
  assert.equal(primitives.arg("it's"), "it%27s");
  // diffFileKey accepts both path and file object forms.
  assert.equal(primitives.diffFileKey("src/a.js", "staged"), "staged:src/a.js");
  assert.equal(primitives.diffFileKey({ path: "src/b.js", diff_kind: "unstaged" }), "unstaged:src/b.js");
  // previewChunkLines keeps delete+add groups together and honors the limit.
  const lines = [
    { line_type: "context", text: "a" },
    { line_type: "delete", text: "b" },
    { line_type: "delete", text: "c" },
    { line_type: "add", text: "d" },
    { line_type: "context", text: "e" },
  ];
  const grouped = primitives.previewChunkLines(lines, 5);
  assert.equal(JSON.stringify(grouped.map((line) => line.text)), JSON.stringify(["a", "b", "c", "d", "e"]));
  const limited = primitives.previewChunkLines(lines, 2);
  assert.equal(JSON.stringify(limited.map((line) => line.text)), JSON.stringify(["a"]), "delete group that exceeds the limit is dropped");
});

test("diff_search module is registered and wired before git_ui.js consumes it", () => {
  const diffSearchSource = readFileSync(new URL("./desktop/git_ui/diff_search.js", import.meta.url), "utf8");
  assert.match(diffSearchSource, /globalThis\.HerdrGitUiDiffSearchModule = \{ create: createGitUiDiffSearch \}/);
  assert.match(diffSearchSource, /function highlightDiffText\(code, path\) \{/);
  assert.match(diffSearchSource, /git-ui-search-match/);
  assert.match(diffSearchSource, /\["history", "log", "stash", "cleanup", "conflicts"\]\.includes\(view\.tab\)/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiDiffSearchModule\.create\(\{/);
  assert.match(gitUiSource, /const highlightDiffText = diffSearch\.highlightDiffText;/);
  assert.match(gitUiSource, /unifiedRows: \(chunk\) => unifiedRows\(chunk\)/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const diffSearchIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/diff_search.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(diffSearchIndex > -1 && diffSearchIndex < gitUiIndex, "diff_search.js concatenates before git_ui.js");
});

test("diff search counts matches and wraps hits in marks", () => {
  const diffSearchSource = readFileSync(new URL("./desktop/git_ui/diff_search.js", import.meta.url), "utf8");
  const ctx = vm.createContext({ window: {}, globalThis: null, console, Math, JSON, Object, Array, String, Number, Set, Error });
  ctx.globalThis = ctx;
  vm.runInContext(diffSearchSource, ctx);
  let activeView = { diffSearchQuery: "todo" };
  const fakeSyntax = { highlight: (code) => `[${code}]` };
  const mod = ctx.globalThis.HerdrGitUiDiffSearchModule.create({
    active: () => activeView,
    Syntax: () => fakeSyntax,
    diffLayoutMode: () => "unified",
    unifiedRows: (chunk) => chunk.lines.map((line) => ({ line })),
    sideBySideRows: (chunk) => chunk.lines.map((line) => ({ oldLine: line, newLine: null })),
  });
  assert.equal(mod.diffSearchQuery(), "todo");
  assert.equal(mod.countTextMatches("todo TODO todo", "todo"), 3);
  assert.equal(mod.countTextMatches("anything", ""), 0);
  // highlightDiffText wraps each hit in a mark and routes through Syntax.
  assert.equal(
    mod.highlightDiffText("a todo b", "src/x.js"),
    "[a ]<mark class=\"git-ui-search-match\">[todo]</mark>[ b]"
  );
  // No query: plain highlight passthrough.
  activeView = { diffSearchQuery: "" };
  assert.equal(mod.highlightDiffText("plain", "src/x.js"), "[plain]");
  // canSearchDiff: side editor blocks, file presence allows.
  assert.equal(mod.canSearchDiff({ sideEditor: true }), false);
  assert.equal(mod.canSearchDiff({ tab: "log" }), false);
  assert.equal(mod.canSearchDiff({ tab: "changes", diff: { files: [{ path: "a" }] } }), true);
  assert.equal(mod.canSearchDiff({ tab: "changes", file: "a.js", diff: { files: [] } }), true);
  assert.equal(mod.canSearchDiff(null), false);
  // diffSearchMatchCount over unified rows.
  activeView = { diffSearchQuery: "todo" };
  const view = {
    diff: {
      files: [
        { chunks: [{ lines: [{ content: "todo fix" }, { content: "clean" }] }] },
        { chunks: [{ lines: [{ content: "todo todo" }] }] },
      ],
    },
  };
  assert.equal(mod.diffSearchMatchCount(view, "todo"), 3);
});

test("primitives module is registered and wired before git_ui.js consumes it", () => {
  const primitivesSource = readFileSync(new URL("./desktop/git_ui/primitives.js", import.meta.url), "utf8");
  assert.match(primitivesSource, /globalThis\.HerdrGitUiPrimitivesModule = \{ create: createGitUiPrimitives \}/);
  assert.match(primitivesSource, /function gitUiOptions\(\) \{/);
  assert.match(primitivesSource, /window\.HerdrOptions \? window\.HerdrOptions\.read\(\) : \{\}/);
  assert.match(primitivesSource, /function esc\(value\) \{/);
  assert.match(primitivesSource, /function arg\(value\) \{/);
  assert.match(primitivesSource, /function hashText\(value\) \{/);
  assert.match(primitivesSource, /function previewChunkLines\(lines, limit\) \{/);
  assert.match(primitivesSource, /gitUiFileListMode === "flat" \? "flat" : "tree"/);
  assert.match(primitivesSource, /gitUiDiffLayout === "unified" \? "unified" : "side-by-side"/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiPrimitivesModule\.create\(\)/);
  assert.match(gitUiSource, /const esc = primitives\.esc;/);
  assert.match(gitUiSource, /const arg = primitives\.arg;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const primitivesIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/primitives.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(primitivesIndex > -1 && primitivesIndex < gitUiIndex, "primitives.js concatenates before git_ui.js");
});

test("toasts module is registered and wired before git_ui.js consumes it", () => {
  const toastsSource = readFileSync(new URL("./desktop/git_ui/toasts.js", import.meta.url), "utf8");
  assert.match(toastsSource, /globalThis\.HerdrGitUiToastsModule = \{ create: createGitUiToasts \}/);
  assert.match(toastsSource, /`\$\{base\}\/branch\/\$\{branchPath\(branch\)\}`/);
  assert.match(toastsSource, /pull-requests\/new\?source=\$\{encodeURIComponent\(branch\)\}/);
  assert.match(toastsSource, /Permalink copied/);
  const gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  assert.match(gitUiSource, /globalThis\.HerdrGitUiToastsModule\.create\(\{/);
  assert.match(gitUiSource, /const renderGitToast = toasts\.renderGitToast;/);
  const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
  const toastsIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui/toasts.js")');
  const gitUiIndex = assetsSource.indexOf('include_str!("assets/desktop/git_ui.js")');
  assert.ok(toastsIndex > -1 && toastsIndex < gitUiIndex, "toasts.js concatenates before git_ui.js");
});

test("permalink copy shows a toast and builds PR urls from the remote", async () => {
  const booted = await bootGitUi({
    "/api/git-ui/status": { branch: "feature-x", ahead: 2, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], remote_url: "git@github.com:acme/widget.git" },
    "/api/git-ui/diff": { files: [] },
    "/api/git-ui/compare": { files: [] },
    "/api/git-ui/log": { commits: [], lines: [], rows: [], has_more: false, limit: 80 },
    "/api/git-ui/permalink": { url: "https://github.com/acme/widget/blob/abc/src/app.js" },
  });
  const ui = booted.ui;
  await ui.open({ cwd: "/tmp/demo-repo", title: "demo" }, { forceOpen: true });
  const html0 = ctxHtml(booted);
  assert.ok(!/git-ui-toast/.test(html0), "no toast before copy");
  // Drive the context-menu copyPermalink flow, which routes through the
  // toasts module: clipboard write + Permalink copied toast.
  ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5 }, "src/app.js", "M");
  await ui.menuAction("copyPermalink");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const calls = booted.calls;
  const permalinkCall = calls.find((call) => call.path === "/api/git-ui/permalink");
  assert.ok(permalinkCall, "permalink GET reached the stubbed backend");
  const html1 = ctxHtml(booted);
  assert.match(html1, /git-ui-toast/);
  assert.match(html1, /Permalink copied/);
});
