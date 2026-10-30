// Unit tests for the desktop location bar (desktop/app_js/location_bar.js).
//
// Same vm harness as composer_behavior.test.mjs: the module runs in a small
// sandbox that mirrors the bundle scope it actually reads (globalThis state,
// globalThis.HerdrAppHelpers, window.HerdrWorkspacePath, window.HerdrGitUi,
// document.getElementById("locationBar")). The bar node stub keeps innerHTML
// and hidden so the signature-based repaint guard is observable.
//
// Phase 1 scope: shapes and sources. Three chip shapes per the plan (git
// checkout: path+branch; git worktree: path+worktree+branch; plain folder:
// path only), facts resolved from cached sources only (worktrees rows,
// workspaceBranches attribution, gitStatusCache park, HerdrGitUi parks,
// worktree stamp), and the disabled branch chip while facts are unknown.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./desktop/app_js/location_bar.js", import.meta.url),
  "utf8",
);

function stubNode(id) {
  return {
    id,
    hidden: false,
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(html) {
      this._innerHTML = String(html);
    },
  };
}

function loadBar(overrides = {}) {
  const bar = stubNode("locationBar");
  const document = { getElementById: (id) => (id === "locationBar" ? bar : null) };
  const ctx = {
    document,
    state: overrides.state || { ws: null, workspaces: [] },
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  if (overrides.helpers) ctx.HerdrAppHelpers = overrides.helpers;
  if (overrides.workspacePath) ctx.HerdrWorkspacePath = overrides.workspacePath;
  if (overrides.gitUi) ctx.HerdrGitUi = overrides.gitUi;
  if (overrides.loadCss) ctx.HerdrLoadCss = overrides.loadCss;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SOURCE, contextObject);
  return { ctx, bar };
}

function workspaceOf(path, extra = {}) {
  return {
    workspace_id: "ws1",
    cwd: path,
    ...extra,
  };
}

describe("location bar module", () => {
  it("exposes HerdrLocationBar.sync and hides the bar without a workspace", () => {
    const { ctx, bar } = loadBar({ state: { ws: null, workspaces: [] } });
    equal(typeof ctx.HerdrLocationBar.sync, "function");
    ctx.HerdrLocationBar.sync();
    equal(bar.hidden, true);
    equal(bar.innerHTML, "");
  });

  it("hides the bar when the workspace has no folder path", () => {
    const state = { ws: "ws1", workspaces: [workspaceOf("")] };
    const first = loadBar({ state });
    first.ctx.HerdrLocationBar.sync();
    equal(first.bar.hidden, true);
    equal(first.bar.innerHTML, "");

    const stateWithCwd = { ws: "ws1", workspaces: [workspaceOf("/repo")] };
    const second = loadBar({ state: stateWithCwd });
    second.ctx.HerdrLocationBar.sync();
    equal(second.bar.hidden, false);
    ok(second.bar.innerHTML.includes('class="git-ui-branch-chip location-bar-path-chip"'));
  });

  it("renders path + branch for a git checkout from the worktree row", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
      worktrees: [{ path: "/repo", branch: "main" }],
    };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    equal(bar.hidden, false);
    ok(bar.innerHTML.includes("main"));
    ok(bar.innerHTML.includes("location-bar-branch-chip"));
    ok(bar.innerHTML.includes("location-bar-path-chip"));
    ok(!bar.innerHTML.includes("location-bar-worktree-chip"));
  });

  it("renders path + worktree + branch for a linked worktree", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo/.wt/feature", { worktree: { is_linked_worktree: true, branch: "feature" } })],
      worktrees: [{ path: "/repo/.wt/feature", branch: "feature" }],
    };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    equal(bar.hidden, false);
    ok(bar.innerHTML.includes('location-bar-worktree-chip'));
    ok(bar.innerHTML.includes('location-bar-branch-chip'));
    ok(bar.innerHTML.includes('location-bar-path-chip'));
  });

  it("falls back to workspaceBranches attribution when no worktree row matches", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
      worktrees: [],
      workspaceBranches: { ws1: "trunk" },
    };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes("trunk"));
  });

  it("falls back to the gitStatusCache park (branch, and not_git_repository)", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
      gitStatusCache: { cwd: "/repo", branch: "cached-branch", pending: false, failed: false },
    };
    let loaded = loadBar({ state });
    loaded.ctx.HerdrLocationBar.sync();
    ok(loaded.bar.innerHTML.includes("cached-branch"));

    const stateNotGit = {
      ws: "ws1",
      workspaces: [workspaceOf("/plain")],
      gitStatusCache: { cwd: "/plain", not_git_repository: true, pending: false, failed: false },
    };
    loaded = loadBar({ state: stateNotGit });
    loaded.ctx.HerdrLocationBar.sync();
    ok(loaded.bar.innerHTML.includes('location-bar-path-chip'));
    ok(!loaded.bar.innerHTML.includes('location-bar-branch-chip'), "plain folder renders path only");
  });

  it("reads HerdrGitUi.workspaceBranch parks before the worktree stamp", () => {
    const state = {
      ws: "ws1",
      workspaces: [
        workspaceOf("/repo", { worktree: { is_linked_worktree: false, branch: "stale" } }),
      ],
      worktrees: [],
    };
    const gitUi = {
      workspaceBranch: (workspace, cwd) => ({ branch: "parked", known: true }),
    };
    const { ctx, bar } = loadBar({ state, gitUi });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes("parked"));
    ok(!bar.innerHTML.includes("stale"));
  });

  it("uses the workspace worktree stamp as last resort and renders the disabled branch chip when nothing answers", () => {
    const stampState = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo", { worktree: { branch: "stamped" } })],
    };
    let loaded = loadBar({ state: stampState });
    loaded.ctx.HerdrLocationBar.sync();
    ok(loaded.bar.innerHTML.includes("stamped"));

    const unknownState = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
    };
    loaded = loadBar({ state: unknownState });
    loaded.ctx.HerdrLocationBar.sync();
    match(loaded.bar.innerHTML, /<button[^>]*disabled[^>]*title="Branch unknown"/);
    ok(loaded.bar.innerHTML.includes("branch\u2026"));
  });

  it("skips the DOM write when nothing changed (signature guard)", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
      worktrees: [{ path: "/repo", branch: "main" }],
    };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    const first = bar.innerHTML;
    // A poll that changes nothing must not rewrite innerHTML: the stub
    // cannot observe a same-value write, so assert the second sync leaves
    // the reference identical and the module reports no state drift.
    ctx.HerdrLocationBar.sync();
    equal(bar.innerHTML, first);
  });

  it("marks detached worktree rows as detached", () => {
    const state = {
      ws: "ws1",
      workspaces: [workspaceOf("/repo")],
      worktrees: [{ path: "/repo", branch: "", is_detached: true }],
    };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes("detached"));
  });

  it("loads git-ui.css once the bar becomes visible", () => {
    const state = { ws: "ws1", workspaces: [workspaceOf("/repo")] };
    const cssHrefs = [];
    const { ctx } = loadBar({ state, loadCss: (href) => cssHrefs.push(href) });
    ctx.HerdrLocationBar.sync();
    equal(cssHrefs.filter((h) => h === "/assets/desktop/git-ui.css").length, 1);
    ctx.HerdrLocationBar.sync();
    equal(cssHrefs.filter((h) => h === "/assets/desktop/git-ui.css").length, 1);
  });

  it("does not load git-ui.css while no workspace is selected", () => {
    const cssHrefs = [];
    const { ctx } = loadBar({ state: { ws: null, workspaces: [] }, loadCss: (href) => cssHrefs.push(href) });
    ctx.HerdrLocationBar.sync();
    equal(cssHrefs.length, 0);
  });

  it("renders the path chip with the picker click and runs the flow on change", () => {
    const state = { ws: "ws1", workspaces: [workspaceOf("/repo")] };
    const { ctx, bar } = loadBar({ state });
    ctx.HerdrLocationBar.sync();
    match(bar.innerHTML, /onclick="HerdrLocationBar\.openPathPicker\(\)"/);

    // Picker open: hidden input seeded with the workspace cwd, handed to
    // the picker, removed from the DOM after the change fires.
    const appended = [];
    const removed = [];
    const listeners = {};
    const pickerInput = {
      type: "",
      style: { display: "" },
      value: "",
      dataset: {},
      addEventListener(type, fn) { listeners[type] = fn; },
      remove() { removed.push(pickerInput); },
      parentNode: null,
    };
    ctx.document.body = { appendChild: (node) => { appended.push(node); node.parentNode = ctx.document.body; } };
    ctx.document.createElement = () => pickerInput;
    const pickerCalls = [];
    ctx.HerdrDirectoryPicker = { open: (input) => pickerCalls.push(input) };
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { flowCalls.push(dir); return true; },
    };

    ctx.HerdrLocationBar.openPathPicker();
    equal(pickerCalls.length, 1, "picker opened once");
    equal(pickerInput.value, "/repo", "hidden input seeded with the workspace cwd");

    // Same-path pick: no flow run.
    pickerInput.value = "/repo";
    listeners.change();
    equal(flowCalls.length, 0, "same-path pick is a no-op");
    equal(removed.length, 1, "input removed after change");

    // Real change: flow runs with the picked folder.
    ctx.HerdrLocationBar.openPathPicker();
    pickerInput.value = "/other";
    listeners.change();
    equal(flowCalls.length, 1);
    equal(flowCalls[0], "/other");
  });
});

describe("location bar branch popover", () => {
  const LOCAL = [
    { name: "main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" },
    { name: "feature-x", author: "Bob", date: "2026-01-03T03:04:05Z", subject: "wip" },
  ];
  const REMOTE = [{ name: "origin/main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }];

  function loadPopover({ routes = {}, state, confirms = true, deferFetch } = {}) {
    const bar = stubNode("locationBar");
    const calls = [];
    const document = {
      getElementById: (id) => (id === "locationBar" ? bar : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ rel: "", href: "", set innerHTML(html) { this._html = html; }, get innerHTML() { return this._html || ""; }, firstElementChild: null, replaceWith() {}, querySelector: () => null }),
      addEventListener: () => {},
      head: { appendChild: () => {} },
    };
    const ctx = {
      document,
      state: state || {
        ws: "ws1",
        workspaces: [workspaceOf("/repo")],
        worktrees: [{ path: "/repo", branch: "feature-x" }],
      },
      fetch: (url, init) => {
        const path = String(url).split("?")[0];
        calls.push({ path, init });
        if (deferFetch) {
          // Deferred completion: the caller decides when the response lands
          // and what it carries, so close/reopen and reorder races can run.
          const gate = deferFetch(url);
          return {
            json: () => gate.then((route) => (typeof route === "function" ? route() : route)),
            ok: true,
            statusText: "OK",
          };
        }
        const route = routes[path] || (() => ({}));
        const body = typeof route === "function" ? route() : route;
        return Promise.resolve({
          ok: true,
          statusText: "OK",
          json: () => Promise.resolve(body),
        });
      },
      requestAnimationFrame: (fn) => fn(),
      confirm: () => confirms,
      alert: () => {},
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    ctx.HerdrWorkspacePath = (workspace) => workspace.cwd;
    ctx.HerdrOptions = { read: () => ({ gitUiRemoteBranchPreload: 10 }) };
    const contextObject = vm.createContext(ctx);
    vm.runInContext(SOURCE, contextObject);
    return { ctx, bar, calls };
  }

  it("chip click opens the popover, fetches branches, and pins the current branch", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    match(bar.innerHTML, /onclick="HerdrLocationBar\.openBranchPopover\(event\)"/);
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    equal(calls.filter((call) => call.path === "/api/git-ui/branches").length, 1);
    const html = bar.innerHTML;
    ok(html.includes("location-bar-branch-popover"), "popover renders inside the bar");
    ok(html.includes("Local branches"));
    ok(html.includes("Remote branches"));
    ok(html.includes('title="Current branch">✓</b><span class="git-ui-branch-row-name-text">feature-x</span>'), "current branch carries the check");
    const localSection = html.indexOf("Local branches");
    const firstRow = html.slice(localSection, localSection + 400);
    ok(firstRow.includes("feature-x"), "current branch pinned first");
    ok(html.includes('git-ui-branch-row-meta">'), "rows carry the author meta line");
    ok(html.includes('aria-label="Delete branch main"'), "trash wired on non-current rows");
    ok(html.indexOf("git-ui-branch-list-scroll") < html.indexOf("git-ui-branch-list-filter"), "filter below the rows");
    ok(html.includes("git-ui-branch-list-new"), "new-branch row renders");
    ok(html.includes("New branch from feature-x"), "new-branch names the base");
  });

  it("re-opening the chip toggles the popover closed", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-branch-popover"));
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "second click closes");
  });

  it("a stale close-then-reopen response never mutates the fresh popover", async () => {
    // Open A, close it, reopen as B while A's fetch is still in flight. A's
    // late response must not leak into B: equal row counts would mask the
    // swap if the guard only checked popover existence.
    const gates = [];
    const { ctx, bar } = loadPopover({
      deferFetch: () => new Promise((resolve) => gates.push(resolve)),
    });
    ctx.HerdrLocationBar.sync();
    const first = ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.closeBranchPopover();
    const second = ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    // B's response lands first, A's stale response lands after it.
    gates[1]({ local: [{ name: "fresh-b", current: true }], remote: [] });
    gates[0]({ local: [{ name: "stale-a", current: true }], remote: [] });
    await first;
    await second;
    ok(bar.innerHTML.includes("fresh-b"), "fresh opening kept its own response");
    ok(!bar.innerHTML.includes("stale-a"), "stale response discarded, not merged");
  });

  it("an out-of-order completion keeps the last opening's list", async () => {
    // Two fetches in flight for two openings; the older one resolves last.
    // The guard must reject the older completion even though a popover
    // exists and row counts would match.
    const gates = [];
    const { ctx, bar } = loadPopover({
      deferFetch: () => new Promise((resolve) => gates.push(resolve)),
    });
    ctx.HerdrLocationBar.sync();
    const first = ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.closeBranchPopover();
    const second = ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    gates[1]({ local: [{ name: "second", current: true }], remote: [] });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    gates[0]({ local: [{ name: "first-stale" }], remote: [] });
    await first;
    await second;
    ok(bar.innerHTML.includes("second"), "latest opening's rows render");
    ok(!bar.innerHTML.includes("first-stale"), "older opening's body rejected");
  });

  it("a workspace switch closes the popover and stale rows never act", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-ui/switch": { ok: true },
      },
      state: {
        ws: "ws1",
        workspaces: [workspaceOf("/repo"), workspaceOf("/other-repo", { workspace_id: "ws2" })],
        worktrees: [{ path: "/repo", branch: "feature-x" }],
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "popover open on the first repo");

    // Switch the selected workspace; sync must clear the stale popover.
    ctx.state.ws = "ws2";
    ctx.HerdrLocationBar.sync();
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover cleared on workspace switch");

    // Even if a stale row handler fires, it must not post against the new
    // selection.
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("main"), false);
    equal(calls.slice(before).length, 0, "stale row action never posts");
  });

  it("switch posts /api/git-ui/switch with the bare local name and closes the popover", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("main"), false);
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "switch POST fired");
    const body = JSON.parse(switchPosts[0].init.body);
    equal(body.cwd, "/repo");
    equal(body.branch, "main");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closes after switch");
  });

  it("a branch checked out in another worktree reroutes to that folder, never posts a switch", async () => {
    const worktreePath = "/repo-wt";
    const opened = [];
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": {
          local: [
            { name: "main", current: true, worktree_path: "/repo" },
            { name: "wt-lane", worktree_path: worktreePath },
          ],
          remote: [],
        },
        "/api/git-ui/switch": { ok: true },
      },
    });
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace(dir) { opened.push(String(dir)); return Promise.resolve(true); },
    };
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes(">worktree</i>"), "the checked-out-elsewhere row is badged");
    ok(bar.innerHTML.includes(`title="Checked out in ${worktreePath}"`), "the badge names the folder");
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("wt-lane"), false);
    equal(JSON.stringify(opened), JSON.stringify([worktreePath]), "folder-change flow received the worktree path");
    equal(calls.slice(before).filter((call) => call.path === "/api/git-ui/switch").length, 0, "no switch POST for a checked-out branch");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closed before the reroute");
  });

  it("a branch whose worktree_path is the current folder still switches in place", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": {
          local: [
            { name: "main", current: true, worktree_path: "/repo" },
            { name: "feature-x", worktree_path: "/repo/" },
          ],
          remote: [],
        },
        "/api/git-ui/switch": { ok: true },
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(!bar.innerHTML.includes(">worktree</i>"), "own-folder checkout carries no badge");
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("feature-x"), false);
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "in-place switch POST fired");
    equal(JSON.parse(switchPosts[0].init.body).branch, "feature-x");
  });

  it("a remote row never reroutes even when its local branch has a worktree", async () => {
    const opened = [];
    const { ctx, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": {
          local: [{ name: "main", current: true, worktree_path: "/repo" }],
          remote: [{ name: "origin/wt-lane", worktree_path: "/repo-wt" }],
        },
        "/api/git-ui/switch": { ok: true },
      },
    });
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace(dir) { opened.push(String(dir)); return Promise.resolve(true); },
    };
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("origin/wt-lane"), true);
    equal(opened.length, 0, "remote rows never hit the folder-change flow");
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "remote row posts its switch");
  });

  it("switch refuses the current branch", async () => {
    const { ctx, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("feature-x"), false);
    equal(calls.slice(before).filter((call) => call.path === "/api/git-ui/switch").length, 0, "current branch never posts");
  });

  it("switch on a remote row posts the bare local name", async () => {
    const { ctx, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("origin/release-lane"), true);
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "remote row posts a switch");
    const body = JSON.parse(switchPosts[0].init.body);
    equal(body.branch, "release-lane", "remote prefix stripped before the POST");
    equal(body.cwd, "/repo");
  });

  it("new branch posts create:true with the current branch as base", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.newBranchDraft("  fresh-lane ");
    const before = calls.length;
    await ctx.HerdrLocationBar.createBranchFromPopover();
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "create POST fired");
    const body = JSON.parse(switchPosts[0].init.body);
    equal(body.cwd, "/repo");
    equal(body.branch, "fresh-lane");
    equal(body.create, true);
    equal(body.base, "feature-x");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closes after create");
  });

  it("create refuses empty names and shows the endpoint error inline", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-ui/switch": { error: "branch already exists" },
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    await ctx.HerdrLocationBar.createBranchFromPopover();
    equal(calls.slice(before).length, 0, "empty name never posts");
    ctx.HerdrLocationBar.newBranchDraft("dupe");
    await ctx.HerdrLocationBar.createBranchFromPopover();
    ok(bar.innerHTML.includes("branch already exists"), "error renders in the popover");
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "popover stays open on error");
  });

  it("trash deletes a local branch, reloads the list, and refuses current and remote rows", async () => {
    const branches = { local: [{ name: "main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }, { name: "wip", author: "Bob", date: "2026-01-03T03:04:05Z", subject: "wip" }], remote: REMOTE.slice() };
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": () => ({ local: branches.local, remote: branches.remote }),
        "/api/git-ui/branch-delete": () => {
          branches.local = branches.local.filter((branch) => branch.name !== "wip");
          return { ok: true };
        },
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes('aria-label="Delete branch wip"'));
    const mainRow = (bar.innerHTML.match(/git-ui-branch-row current[\s\S]*?<\/div>/) || [""])[0];
    ok(!mainRow.includes("branch-row-trash"), "current row has no trash");

    const before = calls.length;
    await ctx.HerdrLocationBar.deleteBranchFromPopover(encodeURIComponent("feature-x"), false);
    await ctx.HerdrLocationBar.deleteBranchFromPopover(encodeURIComponent("origin/main"), true);
    equal(calls.slice(before).filter((call) => call.path === "/api/git-ui/branch-delete").length, 0, "current and remote rows never post");

    const deleteIndex = calls.length;
    await ctx.HerdrLocationBar.deleteBranchFromPopover(encodeURIComponent("wip"), false);
    const deletePosts = calls.slice(deleteIndex).filter((call) => call.path === "/api/git-ui/branch-delete");
    equal(deletePosts.length, 1, "one delete POST");
    const body = JSON.parse(deletePosts[0].init.body);
    equal(body.branch, "wip");
    equal(body.confirmed, true);
    ok(!bar.innerHTML.includes('aria-label="Delete branch wip"'), "deleted branch gone after reload");
  });

  it("delete on a remote row explains it inline instead of posting", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.deleteBranchFromPopover(encodeURIComponent("origin/other"), true);
    ok(bar.innerHTML.includes("Deleting remote branches is not supported here"), "inline refusal renders");
    equal(calls.filter((call) => call.path === "/api/git-ui/branch-delete").length, 0, "no delete POST");
  });

  it("row handlers keep an apostrophe branch name inert and deliver the exact ref", async () => {
    const injected = "x'-alert(1)-'";
    const name = "q'wip";
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": {
          local: [{ name, author: "Ada", date: "2026-01-02T03:04:05Z", subject: "wip" }],
          remote: [],
        },
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const row = (bar.innerHTML.match(/<button class="git-ui-branch-row-main"[^>]*>/) || [""])[0];
    ok(row.includes(encodeURIComponent(name).replace(/'/g, "%27")), "apostrophe arrives percent-encoded in the handler argument");
    ok(!row.includes(injected), "no raw expression can ride the attribute");

    const before = calls.length;
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent(name), false);
    const switchPosts = calls.slice(before).filter((call) => call.path === "/api/git-ui/switch");
    equal(switchPosts.length, 1, "switch POST fired for the apostrophe name");
    equal(JSON.parse(switchPosts[0].init.body).branch, name, "exact ref reaches the endpoint, not a decoded expression");
  });

  it("switch notifies the drawer so its cached view for the folder reloads", async () => {
    const notified = [];
    const { ctx, bar, calls } = loadPopover({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-ui/switch": { ok: true },
      },
    });
    ctx.HerdrGitUi = {
      notifyBranchChanged(cwd) { notified.push(cwd); },
    };
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("main"), false);
    equal(JSON.stringify(notified), JSON.stringify(["/repo"]), "drawer notified with the exact cwd after the switch");
    ok(calls.some((call) => call.path === "/api/git-ui/switch"), "switch POST preceded the notify");
  });

  it("create notifies the drawer the same way", async () => {
    const notified = [];
    const { ctx } = loadPopover({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-ui/switch": { ok: true },
      },
    });
    ctx.HerdrGitUi = {
      notifyBranchChanged(cwd) { notified.push(cwd); },
    };
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.newBranchDraft("fresh-lane");
    await ctx.HerdrLocationBar.createBranchFromPopover();
    equal(JSON.stringify(notified), JSON.stringify(["/repo"]), "create notified the drawer with the cwd");
  });

  it("a failed switch never notifies the drawer", async () => {
    const notified = [];
    const { ctx } = loadPopover({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-ui/switch": { error: "conflict" },
      },
    });
    ctx.HerdrGitUi = {
      notifyBranchChanged(cwd) { notified.push(cwd); },
    };
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.switchBranchFromPopover(encodeURIComponent("main"), false);
    equal(notified.length, 0, "no notify on a failed POST");
  });

  it("chips and popovers carry accessible names", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes('aria-label="Change workspace folder'), "path chip names its action");
    ok(bar.innerHTML.includes('aria-label="Switch branch"'), "branch chip names its action");
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes('role="dialog" aria-label="Branches"'), "branch popover is a named dialog");
    ok(bar.innerHTML.includes('aria-label="Current branch"'), "the current marker is readable, not just a hover title");
    ok(bar.innerHTML.includes('aria-label="New branch name"'), "the new-branch input is named");
    ok(bar.innerHTML.includes('aria-label="Filter branches"'), "the filter input is named");
  });

  it("closing the popover hands focus back to the invoking chip", async () => {
    const focused = [];
    const chipNode = { focus() { focused.push("chip"); }, disabled: false };
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: chipNode });
    ctx.HerdrLocationBar.closeBranchPopover();
    equal(JSON.stringify(focused), JSON.stringify(["chip"]), "close refocused the invoking chip");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closed");
  });

  it("keyboard entry falls back to the rendered branch chip for focus restore", async () => {
    const focused = [];
    const chipNode = { focus() { focused.push("chip"); }, disabled: false, getBoundingClientRect: () => ({ left: 40, bottom: 40, width: 100, height: 20 }) };
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    // The drawer shortcut opens the popover with no event, so the bar
    // resolves the chip from the DOM; the harness answers with this node.
    ctx.document.querySelector = (selector) =>
      (selector === ".location-bar-branch-chip:not([disabled])" ? chipNode : null);
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover(null);
    ctx.HerdrLocationBar.closeBranchPopover();
    equal(JSON.stringify(focused), JSON.stringify(["chip"]), "keyboard-open close refocused the rendered chip");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closed");
  });

  it("popover anchors never overflow the right viewport edge", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.innerWidth = 900;
    ctx.HerdrLocationBar.sync();
    // Chip at the far right of a 900px viewport: the anchor must shift
    // back so the popover fits.
    const chipAtRightEdge = { getBoundingClientRect: () => ({ left: 880, bottom: 40, right: 900, top: 20, width: 20, height: 20 }) };
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: chipAtRightEdge });
    const styleMatch = bar.innerHTML.match(/location-bar-branch-popover" role="dialog" aria-label="Branches" style="([^"]*)"/);
    ok(styleMatch, "popover style renders");
    const left = Number(/left:(-?\d+(?:\.\d+)?)px/.exec(styleMatch[1])[1]);
    const width = Number(/width:(\d+(?:\.\d+)?)px/.exec(styleMatch[1])[1]);
    ok(left + width <= 900, `popover (left ${left} + width ${width}) fits inside 900px`);
  });

  it("filter keeps matching rows and posts nothing", async () => {
    const { ctx, bar, calls } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const before = calls.length;
    ctx.HerdrLocationBar.branchPopoverFilter("feature");
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(bar.innerHTML.includes("feature-x"), "matching branch stays visible");
    ok(!bar.innerHTML.includes('>main</span>'), "non-matching local branch hidden");
    ok(!bar.innerHTML.includes("Load more branches"), "filtering shows the full remote list");
    equal(calls.slice(before).length, 1, "filter fetches the full remote list once");
    equal(calls.slice(before)[0].path, "/api/git-ui/branches");
  });

  it("load more reveals the full remote list", async () => {
    const remote = [];
    for (let index = 0; index < 14; index += 1) remote.push({ name: `origin/feature-${index}`, author: "Ada", date: "2026-01-02T03:04:05Z", subject: "x" });
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("Load more branches (4 more)"), "preload caps the remote rows");
    ctx.HerdrLocationBar.loadMoreBranches();
    ok(!bar.innerHTML.includes("Load more branches"), "all remote rows render after load more");
    ok(bar.innerHTML.includes("origin/feature-13"));
  });

  it("closeBranchPopover clears the popover without touching the chips", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.closeBranchPopover();
    ok(!bar.innerHTML.includes("location-bar-branch-popover"));
    ok(bar.innerHTML.includes("location-bar-path-chip"), "chips survive the close");
  });

  it("popover shows the error when the branches fetch fails", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { error: "not a git repository" } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("not a git repository"), "fetch failure renders the error state");
    ok(bar.innerHTML.includes("git-ui-error"), "error block renders");
  });
});

describe("location bar worktree popover", () => {
  const WORKTREES = [
    { path: "/repo", label: "repo", branch: "main" },
    { path: "/repo-lane", label: "repo-lane", branch: "feature-lane" },
  ];

  function loadWorktreePopover({ routes = {}, state, confirms = true, openFolder, listeners } = {}) {
    const bar = stubNode("locationBar");
    const calls = [];
    const document = {
      getElementById: (id) => (id === "locationBar" ? bar : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ rel: "", href: "", set innerHTML(html) { this._html = html; }, get innerHTML() { return this._html || ""; }, firstElementChild: null, replaceWith() {}, querySelector: () => null }),
      addEventListener: (type, listener, capture) => {
        if (listeners) listeners.push({ type, listener, capture });
      },
      head: { appendChild: () => {} },
    };
    const ctx = {
      document,
      state: state || {
        ws: "ws1",
        workspaces: [workspaceOf("/repo", { worktree: { is_linked_worktree: true } })],
        worktrees: [{ path: "/repo", branch: "main" }],
      },
      fetch: (url, init) => {
        const path = String(url).split("?")[0];
        calls.push({ path, init });
        const route = routes[path] || (() => ({}));
        const body = typeof route === "function" ? route() : route;
        return Promise.resolve({
          ok: true,
          statusText: "OK",
          json: () => Promise.resolve(body),
        });
      },
      requestAnimationFrame: (fn) => fn(),
      confirm: () => confirms,
      alert: () => {},
      openWorktreeCreateFromGitBranch: undefined,
      openWorktreeOpenModal: undefined,
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    ctx.HerdrWorkspacePath = (workspace) => workspace.cwd;
    ctx.HerdrOptions = { read: () => ({}) };
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: openFolder || (async () => {}),
    };
    const contextObject = vm.createContext(ctx);
    vm.runInContext(SOURCE, contextObject);
    return { ctx, bar, calls };
  }

  it("worktree chip renders only for linked worktrees and opens the popover", async () => {
    const { ctx, bar, calls } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
    });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes('onclick="HerdrLocationBar.openWorktreePopover(event)"'), "worktree chip wires the popover");
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(calls.some((call) => call.path === "/api/worktrees"), "popover fetches the worktree list");
    ok(bar.innerHTML.includes("location-bar-worktree-popover"), "popover renders in the bar");
    ok(bar.innerHTML.includes("repo-lane"), "row lists the other checkout");
    ok(bar.innerHTML.includes('class="git-ui-worktree-option current"'), "current checkout row carries the check");
    ok(bar.innerHTML.includes("Create worktree"), "create action renders");
  });

  it("worktree row handlers keep an apostrophe path inert and deliver the exact path", async () => {
    const lane = "/repo/l'ane";
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: [{ path: lane, label: "l'ane", branch: "main" }] } } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    const row = (bar.innerHTML.match(/<button class="git-ui-worktree-option"[^>]*>/) || [""])[0];
    ok(row.includes(encodeURIComponent(lane).replace(/'/g, "%27")), "apostrophe path arrives percent-encoded in the handler argument");
    const opened = [];
    ctx.HerdrOpenFolder.openFolderAsWorkspace = async (dir) => { opened.push(dir); };
    await ctx.HerdrLocationBar.selectWorktreeFromPopover(encodeURIComponent(lane));
    equal(JSON.stringify(opened), JSON.stringify([lane]), "exact path reaches the folder-change flow");
  });

  it("worktree chips and popovers carry accessible names", async () => {
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
    });
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes('aria-label="Choose worktree"'), "worktree chip names its action");
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes('role="dialog" aria-label="Worktrees"'), "worktree popover is a named dialog");
    ok(bar.innerHTML.includes('aria-label="Current worktree"'), "the current worktree marker is readable");
  });

  it("closing the worktree popover hands focus back to its chip", async () => {
    const focused = [];
    const chipNode = { focus() { focused.push("wt-chip"); }, disabled: false };
    const { ctx } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: chipNode });
    ctx.HerdrLocationBar.closeWorktreePopover();
    equal(JSON.stringify(focused), JSON.stringify(["wt-chip"]), "close refocused the worktree chip");
  });

  it("plain checkouts render no worktree chip", () => {
    const { ctx, bar } = loadWorktreePopover({
      state: {
        ws: "ws1",
        workspaces: [workspaceOf("/repo")],
        worktrees: [{ path: "/repo", branch: "main" }],
      },
    });
    ctx.HerdrLocationBar.sync();
    ok(!bar.innerHTML.includes("location-bar-worktree-chip"), "plain checkout keeps path + branch chips only");
  });

  it("row select routes through the folder-change flow after the confirm", async () => {
    const opened = [];
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
      openFolder: async (path) => {
        opened.push(path);
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.selectWorktreeFromPopover(encodeURIComponent("/repo-lane"));
    equal(JSON.stringify(opened), JSON.stringify(["/repo-lane"]), "select runs the shared folder-change flow");
    ok(!bar.innerHTML.includes("location-bar-worktree-popover"), "popover closes after the select");
  });

  it("row select refuses the current checkout and a declined confirm", async () => {
    const opened = [];
    const { ctx } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
      openFolder: async (path) => {
        opened.push(path);
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.selectWorktreeFromPopover(encodeURIComponent("/repo"));
    equal(opened.length, 0, "current checkout select is a no-op");
  });

  it("declined confirm keeps the workspace untouched", async () => {
    const opened = [];
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
      confirms: false,
      openFolder: async (path) => {
        opened.push(path);
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    await ctx.HerdrLocationBar.selectWorktreeFromPopover(encodeURIComponent("/repo-lane"));
    equal(opened.length, 0, "declined confirm never runs the flow");
  });

  it("create opens the worktree modal prefilled with the current branch", async () => {
    const created = [];
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": { result: { worktrees: WORKTREES } } },
    });
    ctx.openWorktreeCreateFromGitBranch = (cwd, branch) => created.push([cwd, branch]);
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.createWorktreeFromPopover();
    equal(JSON.stringify(created), JSON.stringify([["/repo", "main"]]), "create prefill carries cwd + current branch");
    ok(!bar.innerHTML.includes("location-bar-worktree-popover"), "popover closes before the modal opens");
  });

  it("opening one popover closes the other", async () => {
    const { ctx, bar } = loadWorktreePopover({
      routes: {
        "/api/worktrees": { result: { worktrees: WORKTREES } },
        "/api/git-ui/branches": { local: [{ name: "main", current: true }], remote: [] },
      },
    });
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-worktree-popover"), "worktree popover opens first");
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(!bar.innerHTML.includes("location-bar-worktree-popover"), "branch popover closes the worktree one");
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "branch popover is open");
    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "worktree popover closes the branch one");
  });

  it("popover shows loading and error states", async () => {
    const { ctx, bar } = loadWorktreePopover({
      routes: { "/api/worktrees": () => ({ error: "worktree probe failed" }) },
    });
    ctx.HerdrLocationBar.sync();
    const pending = ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("Loading worktrees"), "loading state renders");
    await pending;
    ok(bar.innerHTML.includes("worktree probe failed"), "error state renders");
    ok(bar.innerHTML.includes("git-ui-error"), "error block renders");
  });

  it("capture-phase Escape closes whichever popover is open and consumes the event", async () => {
    const listeners = [];
    const routes = {
      "/api/worktrees": { result: { worktrees: WORKTREES } },
      "/api/git-ui/branches": { result: { local: [{ name: "main" }], remote: [] } },
    };
    const { ctx, bar } = loadWorktreePopover({ routes, listeners });
    ctx.HerdrLocationBar.sync();
    const keydown = listeners.find((entry) => entry.type === "keydown");
    ok(keydown, "the bar registers a document keydown listener");
    ok(keydown.capture === true, "the keydown listener runs in the capture phase");

    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "branch popover is open");
    let stopped = false;
    let prevented = false;
    keydown.listener({ key: "Escape", stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "Escape closed the branch popover");
    ok(stopped && prevented, "Escape is consumed so the drawer behind stays open");

    await ctx.HerdrLocationBar.openWorktreePopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-worktree-popover"), "worktree popover is open");
    keydown.listener({ key: "Escape", stopPropagation() {}, preventDefault() {} });
    ok(!bar.innerHTML.includes("location-bar-worktree-popover"), "Escape closed the worktree popover");

    // Other keys pass through untouched: the spy events record any
    // consumption attempt, and the positive control above shows the spies
    // do fire when the handler consumes (Escape set both flags there).
    const spyKey = { key: "a", stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    keydown.listener(spyKey);
    equal(spyKey.stopped, false, "an unrelated key is not stopped");
    equal(spyKey.prevented, false, "an unrelated key keeps its default");
    ok(bar.innerHTML.includes("location-bar-path-chip"), "bar still renders, no side effects");
  });

  it("drawer yield and bar dismissal agree in real propagation order", async () => {
    // Reproduces the handler chain the served bundle installs: the drawer
    // shortcut handler on window capture runs before the bar's document
    // capture listener. Dispatch drives that order; the drawer must yield
    // while a popover is open so Escape closes the popover only, and Enter
    // must survive to the new-branch field's handler.
    const listeners = [];
    const routes = {
      "/api/worktrees": { result: { worktrees: WORKTREES } },
      "/api/git-ui/branches": { local: [{ name: "main", current: true }], remote: [] },
    };
    const { ctx, bar } = loadWorktreePopover({ routes, listeners });
    const doc = ctx.document;
    doc.querySelector = (selector) => {
      if (selector === ".location-bar-branch-popover")
        return bar.innerHTML.includes("location-bar-branch-popover") ? {} : null;
      if (selector === ".location-bar-worktree-popover")
        return bar.innerHTML.includes("location-bar-worktree-popover") ? {} : null;
      return null;
    };

    // Drawer side, minimal state: visible changes list, empty nav stack.
    // With no popover open, Escape would hide the drawer through the
    // confirm; with a popover open it must not.
    const drawerSource = readFileSync(
      new URL("./desktop/git_ui/shortcuts.js", import.meta.url),
      "utf8",
    );
    const drawer = vm.createContext({
      document: {
        querySelector: doc.querySelector,
        querySelectorAll: () => [],
      },
      HerdrAppHelpers: { escapeHtml: (value) => String(value) },
    });
    drawer.globalThis = drawer;
    drawer.window = drawer;
    vm.runInContext(drawerSource, drawer);
    let drawerHides = 0;
    const drawerCalls = [];
    const shortcuts = drawer.HerdrGitUiShortcuts.create({
      state: { visible: true, shortcutPrefixUntil: 0 },
      render() {},
      active: () => ({ tab: "changes", navigationStack: [], file: null, sideEditor: null }),
      currentMode: () => "changes",
      gitUiOptions: () => ({}),
      explorationDefaultDirectory: () => "",
      canSearchDiff: () => false,
      canEditCurrentFile: () => false,
      saveDraftFromDom() {},
      hide() { drawerHides += 1; },
      confirmFn(question) { drawerCalls.push(question); return true; },
      alertFn() {},
      getGitUi() { return { goBack() {}, showChangesList() {} }; },
    });

    const keydown = listeners.find((entry) => entry.type === "keydown");
    function dispatch(event) {
      // window capture first, then document capture, matching the DOM.
      shortcuts.handleKeydown(event);
      if (!event._stopped) keydown.listener(event);
    }

    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "branch popover is open");

    const esc = { key: "Escape", _stopped: false, defaultPrevented: false, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; }, target: { closest: () => null } };
    dispatch(esc);
    equal(drawerHides, 0, "drawer did not consume Escape or hide while the popover owned the keyboard");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closed on Escape");
    ok(esc._stopped && esc.defaultPrevented, "bar consumed the Escape after the drawer yielded");

    // Escape with no popover open still reaches the drawer.
    const escAfter = { key: "Escape", _stopped: false, defaultPrevented: false, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; }, target: { closest: () => null } };
    shortcuts.handleKeydown(escAfter);
    if (!escAfter._stopped) keydown.listener(escAfter);
    equal(drawerHides, 1, "drawer owns Escape again once no popover is open");
    deepEqual(drawerCalls, ["Hide Git UI?"], "hide path went through the confirm");

    // Enter aimed at the new-branch field while the popover is open: the
    // drawer must let it reach the field handler, which submits a create.
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.newBranchDraft("lane-2");
    const enter = { key: "Enter", _stopped: false, defaultPrevented: false, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; }, target: { closest: () => null } };
    dispatch(enter);
    equal(enter._stopped, false, "drawer yielded on Enter, no mute before the field handler");
    ctx.HerdrLocationBar.newBranchKeydown(enter);
    ok(enter.defaultPrevented, "the field handler consumed Enter for the create submit");
  });
});
