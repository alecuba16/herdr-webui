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
  "./desktop/git_ui/syntax.js",
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
