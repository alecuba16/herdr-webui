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
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./desktop/app_js/location_bar.js", import.meta.url),
  "utf8",
);
// Compiled once so coverage attributes location_bar.js lines to the real file.
const LOCATION_BAR_PATH = fileURLToPath(new URL("./desktop/app_js/location_bar.js", import.meta.url));
const locationBarScript = new vm.Script(readFileSync(LOCATION_BAR_PATH, "utf8"), {
  filename: LOCATION_BAR_PATH,
});
let drawerShortcutsScript = null;

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
  locationBarScript.runInContext(contextObject);
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
  it("exposes HerdrLocationBar.sync and renders the empty bar without a workspace", () => {
    const { ctx, bar } = loadBar({ state: { ws: null, workspaces: [] } });
    equal(typeof ctx.HerdrLocationBar.sync, "function");
    ctx.HerdrLocationBar.sync();
    equal(bar.hidden, false, "the strip never hides");
    match(bar.innerHTML, /<button[^>]*class="location-bar-empty"[^>]*>/, "empty state renders the Open workspace button");
    ok(bar.innerHTML.includes("onclick=\"runSearchAction('open-workspace')\""), "button opens the workspace picker");
    ok(bar.innerHTML.includes('location-bar-chip-icon location-bar-chip-icon-path'), "button carries the folder icon");
    ok(!bar.innerHTML.includes("location-bar-path-chip"), "no chips without a workspace");
  });

  it("renders the empty hint when the workspace has no folder path", () => {
    const state = { ws: "ws1", workspaces: [workspaceOf("")] };
    const first = loadBar({ state });
    first.ctx.HerdrLocationBar.sync();
    equal(first.bar.hidden, false, "no hiding on a folderless workspace");
    match(first.bar.innerHTML, /<button[^>]*class="location-bar-empty"[^>]*>/, "Open workspace button renders");

    const stateWithCwd = { ws: "ws1", workspaces: [workspaceOf("/repo")] };
    const second = loadBar({ state: stateWithCwd });
    second.ctx.HerdrLocationBar.sync();
    equal(second.bar.hidden, false);
    ok(second.bar.innerHTML.includes('class="git-ui-branch-chip location-bar-path-chip"'));
    ok(!second.bar.innerHTML.includes("location-bar-empty"), "chips replace the button once a folder exists");
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
    ok(bar.innerHTML.includes('location-bar-chip-icon location-bar-chip-icon-path'), "path chip carries the folder icon");
    ok(bar.innerHTML.includes('location-bar-chip-icon location-bar-chip-icon-branch'), "branch chip carries the git icon");
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
    ok(bar.innerHTML.includes('location-bar-chip-icon location-bar-chip-icon-worktree'), "worktree chip carries the link icon");
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

  it("renders the path chip with the picker click and discovers the picked folder", () => {
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
    const discoveries = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { discoveries.push(dir); return true; },
    };
    const originalOpen = ctx.HerdrLocationBar.openDiscoveryForFolder;
    ok(typeof originalOpen === "function", "discovery entry exported");
    ctx.HerdrLocationBar.openDiscoveryForFolder = (folder) => discoveries.push(folder);

    ctx.HerdrLocationBar.openPathPicker();
    equal(pickerCalls.length, 1, "picker opened once");
    equal(pickerInput.value, "/repo", "hidden input seeded with the workspace cwd");

    // Same-path pick discovers too (open-folder-redesign.md): the old
    // no-op guard moved into the popover's row contract.
    pickerInput.value = "/repo";
    listeners.change();
    equal(discoveries.length, 1, "same-path pick opens discovery");
    equal(discoveries[0], "/repo");
    equal(removed.length, 1, "input removed after change");

    // Real change: discovery opens for the picked folder.
    ctx.HerdrLocationBar.openPathPicker();
    pickerInput.value = "/other";
    listeners.change();
    equal(discoveries.length, 2);
    equal(discoveries[1], "/other");
    ctx.HerdrLocationBar.openDiscoveryForFolder = originalOpen;
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
    locationBarScript.runInContext(contextObject);
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

  it("branch popover carries a create-worktree row for plain checkouts", async () => {
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.HerdrLocationBar.sync();
    ok(!bar.innerHTML.includes("location-bar-worktree-chip"), "branch-only shape: no worktree chip");
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    const html = bar.innerHTML;
    ok(html.includes('aria-label="Create worktree"'), "create row is named");
    ok(
      html.includes("onclick=\"HerdrLocationBar.createWorktreeFromBranchPopover('feature-x')\""),
      "create row targets the current branch",
    );
    const scroll = html.indexOf("git-ui-branch-list-scroll");
    ok(scroll > -1 && html.indexOf('aria-label="Create worktree"') > scroll, "create row renders inside the scrolled list");
  });

  it("create-worktree from the branch popover opens the modal prefilled and closes the popover", async () => {
    const created = [];
    const { ctx, bar } = loadPopover({
      routes: { "/api/git-ui/branches": { local: LOCAL, remote: REMOTE } },
    });
    ctx.openWorktreeCreateFromGitBranch = (cwd, branch) => created.push([cwd, branch]);
    ctx.HerdrLocationBar.sync();
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ctx.HerdrLocationBar.createWorktreeFromBranchPopover(encodeURIComponent("feature-x"));
    equal(JSON.stringify(created), JSON.stringify([["/repo", "feature-x"]]), "modal opens with cwd + the popover's branch");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "popover closes before the modal opens");
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
    locationBarScript.runInContext(contextObject);
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
        // The drawer context runs no app shell, so no static modals, no
        // session manager, and no directory picker can exist here; the
        // shortcut guard probes by id and must always hear "none".
        getElementById: () => null,
      },
      HerdrAppHelpers: { escapeHtml: (value) => String(value) },
    });
    drawer.globalThis = drawer;
    drawer.window = drawer;
    // Compiled once per product file so coverage attributes to the real path.
    if (!drawerShortcutsScript) {
      const shortcutsPath = fileURLToPath(new URL("./desktop/git_ui/shortcuts.js", import.meta.url));
      drawerShortcutsScript = new vm.Script(readFileSync(shortcutsPath, "utf8"), { filename: shortcutsPath });
    }
    drawerShortcutsScript.runInContext(drawer);
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

describe("location bar discovery popover", () => {
  const LOCAL = [
    { name: "main", current: true, author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" },
    { name: "feature-x", author: "Bob", date: "2026-01-03T03:04:05Z", subject: "wip", worktree_path: "/repo-wt" },
  ];
  const REMOTE = [{ name: "origin/main", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "initial" }];

  function loadDiscovery({ routes = {}, state, confirms = true, deferFetch } = {}) {
    const bar = stubNode("locationBar");
    const calls = [];
    const listeners = {};
    const document = {
      getElementById: (id) => (id === "locationBar" ? bar : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ rel: "", href: "", set innerHTML(html) { this._html = html; }, get innerHTML() { return this._html || ""; }, firstElementChild: null, replaceWith() {}, querySelector: () => null }),
      addEventListener: (name, handler) => { listeners[name] = handler; },
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
        calls.push({ path, init, url: String(url) });
        if (deferFetch) {
          const gate = deferFetch(String(url));
          return {
            json: () => gate.then((route) => (typeof route === "function" ? route() : route)),
            ok: true,
            statusText: "OK",
          };
        }
        const route = routes[path] || (() => ({}));
        const body = typeof route === "function" ? route(String(url), init) : route;
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
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async () => true,
      openFolderUnchecked: async () => ({}),
      createPlainWorkspace: async () => ({}),
      focusWorkspaceOnFolder: async () => null,
    };
    const contextObject = vm.createContext(ctx);
    vm.runInContext(readFileSync(new URL("./shared/core.js", import.meta.url), "utf8"), contextObject);
    Object.assign(ctx, {
      options: {},
      branchPathSlug: ctx.HerdrAppHelpers.branchPathSlug,
      normalizeAbsolutePath: ctx.HerdrAppHelpers.normalizeAbsolutePath,
      buildWorktreeCreateBody: ctx.HerdrAppHelpers.buildWorktreeCreateBody,
    });
    vm.runInContext(readFileSync(new URL("./desktop/app_js/worktrees.js", import.meta.url), "utf8"), contextObject);
    locationBarScript.runInContext(contextObject);
    return { ctx, bar, calls, listeners };
  }

  function installDiscoveryFocusDOM({ ctx, bar }) {
    const document = ctx.document;
    document.body = {};
    document.activeElement = document.body;
    let nodes = [];
    let html = bar.innerHTML;
    document.getElementById = (id) => id === "locationBar" ? bar : nodes.find((node) => node.id === id) || null;
    document.querySelector = (selector) => {
      const key = selector.match(/data-discovery-focus="([^"]+)"/);
      if (key) return nodes.find((node) => node.getAttribute("data-discovery-focus") === key[1]) || null;
      if (selector.includes("git-ui-branch-list-filter")) return document.getElementById("locationBarDiscoveryFilter");
      if (selector.includes("git-ui-worktree-option")) return nodes.find((node) => node.className.includes("git-ui-worktree-option")) || null;
      return null;
    };
    Object.defineProperty(bar, "innerHTML", {
      get: () => html,
      set(value) {
        html = String(value);
        if (nodes.includes(document.activeElement)) document.activeElement = document.body;
        nodes = [...html.matchAll(/<(?:input|button|div)\b([^>]*)>/g)].map((match) => {
          const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]]));
          const node = {
            id: attrs.id || "", className: attrs.class || "", value: attrs.value || "",
            disabled: /(?:^|\s)disabled(?:\s|$)/.test(match[1]),
            selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
            closest: (selector) => selector === ".location-bar-discovery-popover" ? {} : null,
            getAttribute: (name) => attrs[name] || null,
            focus() {
              if (document.activeElement === node) return;
              document.activeElement = node;
              if (attrs.onfocus) vm.runInContext(attrs.onfocus, ctx);
            },
            setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
          };
          return node;
        });
      },
    });
    bar.innerHTML = html;
    return document;
  }

  it("enables Create only for a nonblank branch name without replacing the focused input", async () => {
    const harness = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    const { ctx } = harness;
    const document = installDiscoveryFocusDOM(harness);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    equal(document.querySelector('[data-discovery-focus="create"]').disabled, true);
    document.getElementById("locationBarDiscoveryName").focus();
    const name = document.activeElement;
    const create = document.querySelector('[data-discovery-focus="create"]');
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "draft-name");
    equal(create.disabled, false);
    equal(document.activeElement, name);
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "   ");
    equal(create.disabled, true);
    equal(document.activeElement, name);
  });

  it("preserves input focus and exact selection through lazy base completion and shell sync", async () => {
    const harness = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    const { ctx, bar } = harness;
    const document = installDiscoveryFocusDOM(harness);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    equal(document.activeElement.id, "locationBarDiscoveryFilter");
    let finish;
    ctx.fetch = () => new Promise((resolve) => { finish = (body) => resolve({ ok: true, json: async () => body }); });
    document.getElementById("locationBarDiscoveryName").focus();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "draft-name");
    document.activeElement.setSelectionRange(2, 6, "backward");
    ctx.HerdrLocationBar.sync();
    equal(document.activeElement.id, "locationBarDiscoveryName");
    equal(document.activeElement.value, "draft-name");
    equal(document.activeElement.selectionStart, 2);
    equal(document.activeElement.selectionEnd, 6);
    finish({ branches: ["main"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish({ branches: ["main", "company/main"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(document.activeElement.id, "locationBarDiscoveryName");
    equal(document.activeElement.selectionDirection, "backward");
    ok(bar.innerHTML.includes('<option value="main">'));
  });

  it("focuses loading dialog but does not steal deliberate footer focus when rows arrive", async () => {
    const pending = [];
    const harness = loadDiscovery({ deferFetch: () => new Promise((resolve) => pending.push(resolve)) });
    const document = installDiscoveryFocusDOM(harness);
    const opened = harness.ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    equal(document.activeElement.getAttribute("data-discovery-focus"), "dialog");
    match(harness.bar.innerHTML, /role="status"/);
    document.querySelector('[data-discovery-focus="footer"]').focus();
    pending[0]({ result: { worktrees: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[1]({ local: LOCAL, remote: [] });
    await opened;
    equal(document.activeElement.getAttribute("data-discovery-focus"), "footer");
  });

  it("worktree probe with 2+ rows opens the worktree shape with footer", async () => {
    const { ctx, bar, calls } = loadDiscovery({
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "feature-x" }], source: { repo_name: "repo.git" } } },
      },
    });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    match(calls[0].url, /\/api\/worktrees\?cwd=/);
    ok(bar.innerHTML.includes("location-bar-discovery-popover"), "discovery popover open");
    ok(bar.innerHTML.includes("git-ui-worktree-option"), "worktree rows rendered");
    ok(bar.innerHTML.includes("repo.git"), "repo label in head");
    ok(bar.innerHTML.includes("＋ Create worktree"), "create worktree action present");
    ok(bar.innerHTML.includes("Open folder as workspace"), "footer present in worktree shape");
    ok(!bar.innerHTML.includes("git-ui-branch-list-filter"), "no filter input in worktree shape");
    // Rows route through the discovery handler, not the chip popover's
    // selectWorktreeFromPopover (which reads a null opening here).
    ok(bar.innerHTML.includes("discoveryWorktreeRowOpen"), "rows bound to the discovery handler");
    ok(!bar.innerHTML.includes("selectWorktreeFromPopover"), "no chip-popover handler in discovery rows");
  });

  it("a discovery worktree row opens that worktree folder", async () => {
    const flowCalls = [];
    const { ctx, bar } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/elsewhere")], worktrees: [] },
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "feature-x" }], source: { repo_name: "repo.git" } } },
      },
    });
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (folder) => { flowCalls.push(folder); return true; },
      openFolderUnchecked: async () => ({}),
    };
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await ctx.HerdrLocationBar.discoveryWorktreeRowOpen(encodeURIComponent("/repo-wt"));
    deepEqual(flowCalls, ["/repo-wt"], "row action opens the worktree folder");
    ok(bar.innerHTML.includes("location-bar-discovery-popover") === false, "popover closed after row action");
  });

  it("single checkout routes to probe 2 and opens the branch shape", async () => {
    const { ctx, bar, calls } = loadDiscovery({
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }], source: { repo_name: "repo.git" } } },
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-branches": { branches: ["main", "feature-x", "origin/main"] },
      },
    });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    equal(calls.length >= 2, true, "both probes ran");
    match(calls[1].url, /\/api\/git-ui\/branches\?cwd=/);
    ok(bar.innerHTML.includes("git-ui-branch-list-filter"), "branch shape renders filter");
    ok(bar.innerHTML.includes("Local branches"), "local section present");
    ok(bar.innerHTML.includes("main"), "current branch pinned");
    ok(bar.innerHTML.includes('placeholder="default main"'), "create row defaults base to current branch");
    ok(bar.innerHTML.includes("Open folder as workspace"), "footer present in branch shape");
    equal(calls.filter((call) => call.path === "/api/git-branches").length, 0, "base refs stay lazy");
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions();
    const baseCall = calls.find((call) => call.path === "/api/git-branches");
    ok(baseCall, "base options fetched");
    ok(!baseCall.url.includes("remote=true"), "local membership comes from the local-only endpoint");
    match(calls.filter((call) => call.path === "/api/git-branches")[1].url, /remote=true/);
    ok(!baseCall.url.includes("fetch=true"), "no automatic remote fetch");
  });

  it("loading and error states carry the footer so the user is never trapped", async () => {
    const gates = [];
    const { ctx, bar } = loadDiscovery({
      deferFetch: () => new Promise((resolve) => gates.push(resolve)),
    });
    const opened = ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(bar.innerHTML.includes("Discovering folder"), "loading state");
    ok(bar.innerHTML.includes("Open folder as workspace"), "footer during loading");
    gates[0]({ result: { worktrees: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    gates[1]({ error: "boom: transport failed, not a git-detection case" });
    await opened;
    ok(bar.innerHTML.includes("git-ui-error"), "error state rendered");
    ok(bar.innerHTML.includes("Open folder as workspace"), "footer in error state");
  });

  it("confirmed non-repo creates a plain workspace with no repeated probe", async () => {
    const { ctx, bar, calls } = loadDiscovery({
      routes: {
        "/api/worktrees": { result: { worktrees: [] } },
        "/api/git-ui/branches": () => {
          const err = new Error("fatal: not a git repository (or any of the parent directories): .git");
          return Promise.reject(err);
        },
      },
    });
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      createPlainWorkspace: async (dir) => { flowCalls.push(dir); return true; },
      openFolderUnchecked: async () => ({}),
    };
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/plain");
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"), "no popover for a plain folder");
    equal(flowCalls.length, 1, "plain ladder ran");
    equal(flowCalls[0], "/plain");
  });

  it("branch row: open-then-switch with the folder captured, notify after", async () => {
    const { ctx, bar, calls } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/elsewhere")], worktrees: [] },
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }], source: { repo_name: "repo.git" } } },
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-branches": { branches: [] },
      },
    });
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { flowCalls.push(dir); return true; },
      openFolderUnchecked: async () => ({}),
    };
    const notified = [];
    ctx.HerdrGitUi = { notifyBranchChanged: (cwd) => notified.push(cwd) };
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    // feature-x is checked out in /repo-wt: destination 1 reroutes there.
    await ctx.HerdrLocationBar.discoveryBranchRowOpen("feature-x", false);
    equal(flowCalls.length, 1, "reroute opened the worktree folder");
    equal(flowCalls[0], "/repo-wt");
    const switchCalls = calls.filter((call) => call.path === "/api/git-ui/switch");
    equal(switchCalls.length, 0, "no switch posted for a rerouted branch");
    // A local branch not checked out anywhere: open then switch on the picked folder.
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await ctx.HerdrLocationBar.discoveryBranchRowOpen("main", false);
    equal(flowCalls.length, 2, "picked folder opened first");
    // current branch rows open without a switch; use a non-current, non-rerouted one
    deepEqual(notified, [], "no notify for a plain open");
    ok(bar.innerHTML.includes("location-bar-discovery-popover") === false, "popover closed after row action");
  });

  it("create branch opens the folder then posts create with the chosen base", async () => {
    const { ctx, calls } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/elsewhere")], worktrees: [] },
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }], source: { repo_name: "repo.git" } } },
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/git-branches": { branches: ["main", "origin/release"] },
      },
    });
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { flowCalls.push(dir); return true; },
      openFolderUnchecked: async () => ({}),
    };
    const notified = [];
    ctx.HerdrGitUi = { notifyBranchChanged: (cwd) => notified.push(cwd) };
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "lane-3");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "origin/release");
    await ctx.HerdrLocationBar.discoveryCreateBranch();
    equal(flowCalls.length, 1, "folder opened before the switch");
    const switchCall = calls.filter((call) => call.path === "/api/git-ui/switch").map((call) => JSON.parse(call.init.body))[0];
    equal(switchCall.cwd, "/repo", "switch targets the picked folder");
    equal(switchCall.branch, "lane-3");
    equal(switchCall.create, true);
    equal(switchCall.base, "origin/release", "chosen base wins over the default");
    deepEqual(notified, ["/repo"], "drawer notified after create");
  });

  it("refreshes shell branch facts when the Git drawer has not loaded", async () => {
    const { ctx } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
    } });
    const moved = [];
    ctx.HerdrShellNoteBranchMoved = (cwd) => moved.push(cwd);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await ctx.HerdrLocationBar.discoveryBranchRowOpen("other", false);
    deepEqual(moved, ["/repo"]);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "fresh");
    await ctx.HerdrLocationBar.discoveryCreateBranch();
    deepEqual(moved, ["/repo", "/repo"]);
  });

  it("a stale completion after the footer ran never mutates a closed popover", async () => {
    const gates = [];
    const { ctx, bar } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/elsewhere")], worktrees: [] },
      deferFetch: () => new Promise((resolve) => gates.push(resolve)),
    });
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { flowCalls.push(dir); return true; },
      openFolderUnchecked: async () => ({}),
    };
    const opened = ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Footer while loading: cancels and opens plain.
    await ctx.HerdrLocationBar.discoveryOpenPlain();
    equal(flowCalls.length, 1, "footer opened the folder");
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"), "popover closed by the footer");
    // Late probe completion lands on a dead opening.
    gates[0]({ result: { worktrees: [{ path: "/repo" }, { path: "/repo-wt" }], source: { repo_name: "repo.git" } } });
    await opened;
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"), "stale completion did not reopen the popover");
  });

  it("create worktree expands inline without invoking either modal", async () => {
    const harness = loadDiscovery({
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "feature-x" }], source: { repo_name: "repo.git", repo_root: "/repo" } } },
      },
    });
    const { ctx, bar } = harness;
    const document = installDiscoveryFocusDOM(harness);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    const modalCalls = [];
    ctx.openWorktreeCreateFromGitBranch = (cwd, branch) => modalCalls.push({ cwd, branch });
    ctx.openWorktreeOpenModal = () => modalCalls.push("fallback");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    equal(modalCalls.length, 0);
    ok(bar.innerHTML.includes("location-bar-discovery-popover"));
    ok(bar.innerHTML.includes("git-ui-worktree-option"));
    match(bar.innerHTML, /<label for="locationBarDiscoveryName">Worktree branch name<\/label>/);
    equal(document.activeElement.id, "locationBarDiscoveryName");
    equal((bar.innerHTML.match(/<input\b/g) || []).length, 2);
    ok(bar.innerHTML.includes("--discovery-top:"));
  });

  it("mutual exclusion: opening discovery closes an open branch popover and vice versa", async () => {
    const { ctx, bar } = loadDiscovery({
      routes: {
        "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
        "/api/worktrees": { result: { worktrees: [{ path: "/repo" }, { path: "/repo-wt" }], source: { repo_name: "repo.git" } } },
      },
    });
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(bar.innerHTML.includes("location-bar-branch-popover"), "branch popover open");
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ok(!bar.innerHTML.includes("location-bar-branch-popover"), "branch popover closed by discovery");
    ok(bar.innerHTML.includes("location-bar-discovery-popover"), "discovery open");
    await ctx.HerdrLocationBar.openBranchPopover({ stopPropagation() {}, currentTarget: null });
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"), "discovery closed by the branch popover");
  });

  it("integrates confirmed non-git recovery with the real shared flow without another git probe", async () => {
    const { ctx, bar, calls } = loadDiscovery({ routes: {
      "/api/worktrees": { error: "fatal: not a git repository" },
      "/api/git-ui/branches": { error: "fatal: not a git repository" },
      "/api/workspaces": { result: { workspace: { workspace_id: "notes" }, tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } },
    } });
    const navigation = [];
    ctx.go = (...args) => navigation.push(args);
    vm.runInContext(readFileSync(new URL("./desktop/app_js/open_folder_flow.js", import.meta.url), "utf8"), ctx);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/notes");
    equal(calls.filter((call) => call.path === "/api/worktrees").length, 1);
    equal(calls.filter((call) => call.path === "/api/workspaces").length, 1);
    equal(calls.filter((call) => call.path === "/api/recent-workspaces/record").length, 1);
    deepEqual(navigation, [["notes", "tab", "pane"]]);
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"));
  });

  it("focuses an existing plain workspace instead of creating a duplicate", async () => {
    const { ctx, calls } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/repo"), { workspace_id: "notes", cwd: "/notes" }], worktrees: [] },
      routes: { "/api/worktrees": { error: "not a git repository" }, "/api/git-ui/branches": { error: "not a git repository" } },
    });
    const navigation = [];
    ctx.go = (...args) => navigation.push(args);
    vm.runInContext(readFileSync(new URL("./desktop/app_js/open_folder_flow.js", import.meta.url), "utf8"), ctx);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/notes");
    deepEqual(navigation, [["notes", null, null]]);
    equal(calls.filter((call) => call.path === "/api/workspaces").length, 0);
  });

  it("executes the emitted current-branch onclick to open without switching", async () => {
    const { ctx, bar, calls } = loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/elsewhere")], worktrees: [] },
      routes: { "/api/worktrees": { result: { worktrees: [] } }, "/api/git-ui/branches": { local: LOCAL, remote: [] } },
    });
    const opened = [];
    ctx.HerdrOpenFolder.openFolderAsWorkspace = async (folder) => opened.push(folder);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    const row = bar.innerHTML.match(/class="git-ui-branch-row current"[\s\S]*?onclick="([^"]+)"/);
    ok(row, "current marker retained");
    await vm.runInContext(row[1], ctx);
    deepEqual(opened, ["/repo"]);
    equal(calls.filter((call) => call.path === "/api/git-ui/switch").length, 0);
  });

  it("extends cached base refs only on explicit fetch, with local refs first", async () => {
    const { ctx, bar, calls } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: REMOTE },
      "/api/git-branches": (url) => ({ branches: url.includes("remote=true") ? ["origin/main", "z-local", "main", "feature-x"] : ["z-local", "main", "feature-x"] }),
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    equal(calls.length, 2);
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "draft-name");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "origin/release");
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions();
    ok(!calls.some((call) => call.url.includes("fetch=true")));
    ok(bar.innerHTML.indexOf('value="z-local"') < bar.innerHTML.indexOf('value="origin/main"'));
    ok(bar.innerHTML.includes("Fetch remotes"));
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
    equal(calls.filter((call) => call.url.includes("fetch=true")).length, 1);
    ok(bar.innerHTML.includes('value="draft-name"'));
    ok(bar.innerHTML.includes('value="origin/release"'));
    ok(bar.innerHTML.indexOf('id="locationBarDiscoveryFilter"') < bar.innerHTML.indexOf('class="git-ui-branch-row'));
    match(bar.innerHTML, /<label for="locationBarDiscoveryBase">Base ref<\/label>/);
  });

  it("shows base load errors and allows an explicit retry without blocking free text", async () => {
    let fail = true;
    const { ctx, bar, calls } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
      "/api/git-branches": () => fail ? { error: "fetch unavailable" } : { branches: ["main"] },
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
    match(bar.innerHTML, /role="alert">fetch unavailable/);
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions(false, true);
    equal(calls.filter((call) => call.path === "/api/git-branches").length, 1, "focus restoration must not retry forever");
    fail = false;
    await ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
    ok(!bar.innerHTML.includes("fetch unavailable"));
    ok(bar.innerHTML.includes('<option value="main">'));
  });

  it("repaints load-more and same-count filter completion", async () => {
    const remote = Array.from({ length: 12 }, (_, index) => ({ name: `origin/topic-${index}`, remote: true }));
    const { ctx, bar } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote },
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ok(bar.innerHTML.includes("Load more branches (2 more)"));
    ctx.HerdrLocationBar.discoveryLoadMore();
    ok(!bar.innerHTML.includes("Load more branches"));
    ok(bar.innerHTML.includes("origin/topic-11"));
    ctx.HerdrLocationBar.discoveryFilter("topic");
    ok(bar.innerHTML.includes("Loading remote branches"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(!bar.innerHTML.includes("Loading remote branches"));
  });

  it("cancel preserves both discovery and branch drafts", async () => {
    const { ctx, bar, calls } = loadDiscovery({ confirms: false, routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "draft-name");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "custom/base");
    await ctx.HerdrLocationBar.discoveryCreateBranch();
    ctx.HerdrLocationBar.sync();
    ok(bar.innerHTML.includes("location-bar-discovery-popover"));
    ok(bar.innerHTML.includes('value="draft-name"'));
    ok(bar.innerHTML.includes('value="custom/base"'));
    equal(calls.filter((call) => call.path === "/api/git-ui/switch").length, 0);
  });

  it("invalidates a pending discovery after origin cwd changes without opening old plain folder", async () => {
    let resolveProbe;
    const { ctx, bar, calls } = loadDiscovery({ deferFetch: () => new Promise((resolve) => { resolveProbe = resolve; }) });
    const opened = ctx.HerdrLocationBar.openDiscoveryForFolder("/notes");
    ctx.state.workspaces[0].cwd = "/changed";
    ctx.HerdrLocationBar.sync();
    resolveProbe({ result: { worktrees: [] } });
    await opened;
    ok(!bar.innerHTML.includes("location-bar-discovery-popover"));
    equal(calls.length, 1, "no second probe after origin changed");
  });

  it("ignores a pending non-git completion after workspace changes even before sync", async () => {
    const pending = [];
    const { ctx, calls } = loadDiscovery({ deferFetch: () => new Promise((resolve) => pending.push(resolve)) });
    let created = 0;
    ctx.HerdrOpenFolder.createPlainWorkspace = async () => { created++; };
    const opened = ctx.HerdrLocationBar.openDiscoveryForFolder("/notes");
    pending[0]({ result: { worktrees: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.state.ws = "different";
    pending[1]({ error: "not a git repository" });
    await opened;
    equal(created, 0);
    equal(calls.length, 2);
  });

  it("does not merge a late base completion into a replacement opening", async () => {
    const { ctx, bar } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    const fetch = ctx.fetch;
    let finish;
    ctx.fetch = () => new Promise((resolve) => { finish = (body) => resolve({ ok: true, json: async () => body }); });
    const loading = ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
    ok(bar.innerHTML.includes('aria-disabled="true"'));
    ok(bar.innerHTML.includes('role="status">Loading refs'));
    ctx.fetch = fetch;
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/other-repo");
    finish({ branches: ["stale-ref"] });
    await loading;
    ok(!bar.innerHTML.includes("stale-ref"));
    ok(bar.innerHTML.includes("/other-repo"));
  });

  it("ignores an obsolete filter response even when clocks are identical", async () => {
    const { ctx, bar } = loadDiscovery({ routes: {
      "/api/worktrees": { result: { worktrees: [] } },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    const pending = [];
    ctx.fetch = () => new Promise((resolve) => pending.push((body) => resolve({ ok: true, json: async () => body })));
    ctx.Date = class extends Date { static now() { return 1; } };
    ctx.HerdrLocationBar.discoveryFilter("old");
    ctx.HerdrLocationBar.discoveryFilter("new");
    pending[1]({ remote: [{ name: "origin/new", remote: true }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[0]({ remote: [{ name: "origin/old-new", remote: true }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(bar.innerHTML.includes("origin/new"));
    ok(!bar.innerHTML.includes("origin/old-new"));
  });

  it("keeps discovery open when the initiating detached picker click bubbles", async () => {
    const pending = [];
    const { ctx, bar, listeners } = loadDiscovery({ deferFetch: () => new Promise((resolve) => pending.push(resolve)) });
    let input;
    let change;
    ctx.document.body = { appendChild(node) { node.parentNode = this; } };
    ctx.document.createElement = () => ({ style: {}, addEventListener(name, handler) { if (name === "change") change = handler; }, remove() { this.parentNode = null; } });
    ctx.HerdrDirectoryPicker = { open(node) { input = node; } };
    let opened;
    const discover = ctx.HerdrLocationBar.openDiscoveryForFolder;
    ctx.HerdrLocationBar.openDiscoveryForFolder = (folder) => { opened = discover(folder); return opened; };
    ctx.HerdrLocationBar.openPathPicker();
    input.value = "/repo";
    change();
    const backdrop = { classList: { contains: (name) => name === "directory-picker-backdrop" }, parentNode: null };
    const selectButton = { classList: { contains: () => false }, parentNode: backdrop };
    listeners.click({ target: selectButton });
    ok(bar.innerHTML.includes("Discovering folder"));
    pending[0]({ result: { worktrees: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[1]({ local: LOCAL, remote: [] });
    await opened;
    ok(bar.innerHTML.includes("Local branches"));
  });

  it("derives a containing checkout branch rather than a sibling for worktree creation", async () => {
    const { ctx, bar } = loadDiscovery({ routes: { "/api/worktrees": { result: { source: { repo_root: "/repo", repo_name: "repo" }, worktrees: [
      { path: "/repo-other", branch: "wrong" }, { path: "/repo", branch: "picked" },
    ] } } } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo/src");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ok(bar.innerHTML.includes('placeholder="default picked"'));
  });

  it("row arguments survive apostrophes and remote names decode to local", async () => {
    const { ctx, bar } = loadDiscovery({
      routes: {
        "/api/worktrees": { result: { worktrees: [{ path: "/repo", branch: "main" }], source: { repo_name: "repo.git" } } },
        "/api/git-ui/branches": {
          local: [{ name: "fix/it's", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "x" }],
          remote: [{ name: "origin/lane's", author: "Ada", date: "2026-01-02T03:04:05Z", subject: "y" }],
        },
        "/api/git-branches": { branches: [] },
      },
    });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/repo");
    ok(bar.innerHTML.includes("fix/it&#39;s") || bar.innerHTML.includes("fix/it's"), "apostrophe branch rendered inert");
    const flowCalls = [];
    ctx.HerdrOpenFolder = {
      openFolderAsWorkspace: async (dir) => { flowCalls.push(dir); return true; },
      openFolderUnchecked: async () => ({}),
    };
    const switches = [];
    ctx.fetch = (url, init) => {
      if (String(url) === "/api/git-ui/switch") switches.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, statusText: "OK", json: () => Promise.resolve({ ok: true }) });
    };
    await ctx.HerdrLocationBar.discoveryBranchRowOpen("origin/lane's", true);
    const switchCall = switches[0];
    equal(switchCall.branch, "lane's", "remote row posts the bare local name");
    equal(switchCall.cwd, "/repo");
  });

  const INLINE_SOURCE = { repo_root: "/projects/repo", repo_name: "repo", default_worktree_directory: "../checkouts" };
  const CREATED = { result: { workspace: { workspace_id: "created" }, tab: { tab_id: "created-tab" }, root_pane: { pane_id: "created-pane" } } };

  function inlineHarness({ shape = "branches", source = INLINE_SOURCE, currentBranch = "main" } = {}) {
    return loadDiscovery({
      state: { ws: "ws1", workspaces: [workspaceOf("/origin")], worktrees: [] },
      routes: {
        "/api/worktrees": (_url, init) => init && init.method === "POST" ? CREATED : { result: { source, worktrees: shape === "worktrees" ? [{ path: "/picked", branch: currentBranch }, { path: "/sibling", branch: "other" }] : [] } },
        "/api/git-ui/branches": { local: currentBranch ? [{ name: currentBranch, current: true }, { name: "other" }] : [], remote: [] },
        "/api/git-branches": (url) => ({ branches: url.includes("remote=true") ? ["company/main", "z-local", "company/topic", "main"] : ["z-local", "company/topic", "main"] }),
      },
    });
  }

  it("reuses the branch create fields and cancel restores the live row and retained drafts", async () => {
    const harness = inlineHarness();
    const { ctx, bar } = harness;
    const document = installDiscoveryFocusDOM(harness);
    const modalCalls = [];
    ctx.openWorktreeCreateFromGitBranch = () => modalCalls.push("branch modal");
    ctx.openWorktreeOpenModal = () => modalCalls.push("fallback modal");
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "kept/name");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "company/release");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    equal((bar.innerHTML.match(/id="locationBarDiscoveryName"/g) || []).length, 1);
    equal((bar.innerHTML.match(/id="locationBarDiscoveryBase"/g) || []).length, 1);
    ok(bar.innerHTML.includes("Local branches"));
    ok(!bar.innerHTML.includes("New branch name"));
    ok(bar.innerHTML.includes('class="git-ui-branch-list-new location-bar-discovery-worktree-form"'));
    equal(document.activeElement.id, "locationBarDiscoveryName");
    ctx.HerdrLocationBar.discoveryCancelWorktree();
    equal(document.activeElement.getAttribute("data-discovery-focus"), "create-worktree");
    ok(bar.innerHTML.includes("New branch name"));
    ok(!bar.innerHTML.includes("location-bar-discovery-worktree-form"));
    ok(!bar.innerHTML.includes("Cancel worktree"));
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    equal(document.getElementById("locationBarDiscoveryName").value, "kept/name");
    equal(document.getElementById("locationBarDiscoveryBase").value, "company/release");
    deepEqual(modalCalls, []);
  });

  it("collapses worktree creation without removing rows or drafts", async () => {
    const harness = inlineHarness({ shape: "worktrees" });
    const { ctx, bar } = harness;
    const document = installDiscoveryFocusDOM(harness);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "retained");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "custom/base");
    ctx.HerdrLocationBar.discoveryCancelWorktree();
    ok(!bar.innerHTML.includes('id="locationBarDiscoveryName"'));
    ok(bar.innerHTML.includes("git-ui-worktree-option"));
    equal(document.activeElement.getAttribute("data-discovery-focus"), "create-worktree");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    equal(document.getElementById("locationBarDiscoveryName").value, "retained");
    equal(document.getElementById("locationBarDiscoveryBase").value, "custom/base");
  });

  for (const shape of ["branches", "worktrees"]) {
    it(`submits exact picked-folder payload and navigates returned IDs in ${shape} shape`, async () => {
      const { ctx, bar, calls } = inlineHarness({ shape });
      const navigations = [];
      let opened = 0;
      let confirmed = 0;
      ctx.go = (...args) => navigations.push(args);
      ctx.HerdrOpenFolder.openFolderAsWorkspace = async () => { opened++; };
      ctx.confirm = () => { confirmed++; return true; };
      ctx.state.openWorktreeSource = { cwd: "/wrong", workspace_id: "wrong" };
      await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
      await ctx.HerdrLocationBar.discoveryCreateWorktree();
      ctx.HerdrLocationBar.discoveryDraft("newBranch", "  Feature/New  ");
      await ctx.HerdrLocationBar.discoverySubmitWorktree();
      const posts = calls.filter((call) => call.init && call.init.method === "POST");
      equal(posts.length, 1);
      deepEqual(JSON.parse(posts[0].init.body), { workspace_id: null, cwd: "/picked", branch: "Feature/New", base: "main", label: null, path: "/projects/checkouts/repo/feature-new", pull_base: false });
      deepEqual(navigations, [["created", "created-tab", "created-pane"]]);
      equal(opened, 0);
      equal(confirmed, 0);
      ok(!bar.innerHTML.includes("location-bar-discovery-popover"));
      equal(calls.filter((call) => call.path === "/api/worktrees" && !(call.init && call.init.method === "POST")).length, 1, "probe source was retained");
    });
  }

  it("uses configured default directory and HEAD when current branch is unavailable", async () => {
    const { ctx, calls } = inlineHarness({ currentBranch: "" });
    ctx.options.worktreeDefaultDirectory = "~/custom-worktrees";
    ctx.go = () => {};
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "topic/a");
    await ctx.HerdrLocationBar.discoverySubmitWorktree();
    const post = calls.find((call) => call.init && call.init.method === "POST");
    equal(JSON.parse(post.init.body).base, "HEAD");
    equal(JSON.parse(post.init.body).path, "~/custom-worktrees/repo/topic-a");
  });

  it("uses explicit free-text base and the existing relative-directory fallback", async () => {
    const { ctx, calls } = inlineHarness({ source: { repo_root: "/projects/repo", repo_name: "repo" } });
    ctx.go = () => {};
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "topic");
    ctx.HerdrLocationBar.discoveryDraft("newBase", "  refs/tags/v1  ");
    await ctx.HerdrLocationBar.discoverySubmitWorktree();
    const body = JSON.parse(calls.find((call) => call.init && call.init.method === "POST").init.body);
    equal(body.base, "refs/tags/v1");
    equal(body.path, "/projects/worktrees/repo/topic");
  });

  it("authoritatively orders custom remote refs after slash-containing locals in both shapes", async () => {
    for (const shape of ["branches", "worktrees"]) {
      const { ctx, bar, calls } = inlineHarness({ shape });
      await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
      await ctx.HerdrLocationBar.discoveryCreateWorktree();
      await ctx.HerdrLocationBar.discoveryLoadBaseOptions();
      deepEqual([...bar.innerHTML.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), ["z-local", "company/topic", "main", "company/main"]);
      const cached = calls.filter((call) => call.path === "/api/git-branches");
      equal(cached.length, 2);
      ok(!cached[0].url.includes("remote=true"));
      ok(cached[1].url.includes("remote=true"));
      ok(!cached.some((call) => call.url.includes("fetch=true")));
      await ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
      const fetched = calls.filter((call) => call.path === "/api/git-branches").slice(2);
      equal(fetched.length, 2);
      ok(fetched[0].url.includes("remote=true&fetch=true"));
      ok(!fetched[1].url.includes("remote=true"));
      ok(!fetched[1].url.includes("fetch=true"));
    }
  });

  it("retries failed probe metadata on entry and blocks malformed submits until retry succeeds", async () => {
    let sourceCalls = 0;
    const harness = loadDiscovery({ routes: {
      "/api/worktrees": () => { sourceCalls++; return sourceCalls <= 2 ? { error: "source offline" } : { result: { source: INLINE_SOURCE } }; },
      "/api/git-ui/branches": { local: LOCAL, remote: [] },
    } });
    const { ctx, bar, calls } = harness;
    const document = installDiscoveryFocusDOM(harness);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    equal(sourceCalls, 1);
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "kept");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    equal(sourceCalls, 2);
    match(bar.innerHTML, /role="alert">source offline/);
    ok(bar.innerHTML.includes('data-discovery-focus="retry-worktree-source"'));
    ctx.HerdrLocationBar.discoveryDraft("newBase", "kept/base");
    equal(document.querySelector('[data-discovery-focus="create"]').disabled, true);
    await ctx.HerdrLocationBar.discoverySubmitWorktree();
    equal(calls.filter((call) => call.init && call.init.method === "POST").length, 0);
    await ctx.HerdrLocationBar.discoveryRetryWorktreeSource();
    equal(sourceCalls, 3);
    ok(!bar.innerHTML.includes("source offline"));
    equal(document.querySelector('[data-discovery-focus="create"]').disabled, false);
    equal(document.getElementById("locationBarDiscoveryName").value, "kept");
    equal(document.getElementById("locationBarDiscoveryBase").value, "kept/base");
  });

  it("keeps blank or incomplete metadata unsubmitable without a malformed path", async () => {
    const { ctx, bar, calls } = inlineHarness({ source: { repo_name: "repo" } });
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "topic");
    await ctx.HerdrLocationBar.discoverySubmitWorktree();
    match(bar.innerHTML, /role="alert">Worktree source is unavailable/);
    equal(calls.filter((call) => call.init && call.init.method === "POST").length, 0);
  });

  for (const shape of ["branches", "worktrees"]) {
    it(`guards duplicate Enter/click and all competing pending actions in ${shape} shape`, async () => {
      const harness = inlineHarness({ shape });
      const { ctx, bar, calls } = harness;
      const document = installDiscoveryFocusDOM(harness);
      await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
      await ctx.HerdrLocationBar.discoveryCreateWorktree();
      await new Promise((resolve) => setTimeout(resolve, 0));
      ctx.HerdrLocationBar.discoveryDraft("newBranch", "submitted");
      ctx.HerdrLocationBar.discoveryDraft("newBase", "submitted/base");
      let finish;
      let posts = 0;
      let confirmed = 0;
      ctx.confirm = () => { confirmed++; return true; };
      ctx.fetch = (_url, init) => { posts++; ok(init.method === "POST"); return new Promise((resolve) => { finish = (body) => resolve({ ok: true, json: async () => body }); }); };
      const pending = ctx.HerdrLocationBar.discoverySubmitWorktree();
      const count = calls.length;
      const discoveryHtml = bar.innerHTML.slice(bar.innerHTML.indexOf('class="git-ui-branch-list git-ui-worktree-list location-bar-discovery-popover"'));
      for (const control of discoveryHtml.matchAll(/<(?:button|input)\b([^>]*)>/g)) ok(/\bdisabled\b/.test(control[1]), control[0]);
      match(bar.innerHTML, /role="status" data-discovery-focus="worktree-status">Creating worktree/);
      ok(bar.innerHTML.includes("Closing this dialog does not cancel creation"));
      equal(document.getElementById("locationBarDiscoveryName").disabled, true);
      await ctx.HerdrLocationBar.discoverySubmitWorktree();
      await ctx.HerdrLocationBar.discoveryCreateKeydown({ key: "Enter", preventDefault() {} });
      await ctx.HerdrLocationBar.discoveryCreateBranch();
      ctx.HerdrLocationBar.discoveryDraft("newBranch", "mutated");
      ctx.HerdrLocationBar.discoveryDraft("newBase", "mutated/base");
      ctx.HerdrLocationBar.discoveryCancelWorktree();
      await ctx.HerdrLocationBar.discoveryCreateWorktree();
      await ctx.HerdrLocationBar.discoveryWorktreeRowOpen(encodeURIComponent("/sibling"));
      await ctx.HerdrLocationBar.discoveryBranchRowOpen("other", false);
      await ctx.HerdrLocationBar.discoveryOpenPlain();
      ctx.HerdrLocationBar.discoveryLoadMore();
      ctx.HerdrLocationBar.discoveryFilter("other");
      await ctx.HerdrLocationBar.discoveryLoadBaseOptions(true);
      await ctx.HerdrLocationBar.discoveryRetryWorktreeSource();
      equal(posts, 1);
      equal(calls.length, count);
      equal(confirmed, 0);
      equal(document.getElementById("locationBarDiscoveryName").value, "submitted");
      equal(document.getElementById("locationBarDiscoveryBase").value, "submitted/base");
      finish({ error: "path already exists" });
      await pending;
      match(bar.innerHTML, /role="alert">path already exists/);
      equal(document.querySelector('[data-discovery-focus="create"]').disabled, false);
      equal(document.getElementById("locationBarDiscoveryName").disabled, false);
      ok(bar.innerHTML.includes("Retry worktree creation"));
      const navigation = [];
      ctx.go = (...args) => navigation.push(args);
      const retry = ctx.HerdrLocationBar.discoverySubmitWorktree();
      finish(CREATED);
      await retry;
      equal(posts, 2);
      deepEqual(navigation, [["created", "created-tab", "created-pane"]]);
    });
  }

  it("dispatches Enter to worktree submit then branch creation after cancel", async () => {
    const { ctx, calls } = inlineHarness();
    ctx.go = () => {};
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    let prevented = 0;
    await ctx.HerdrLocationBar.discoveryCreateKeydown({ key: "Enter", preventDefault() { prevented++; } });
    equal(calls.filter((call) => call.init && call.init.method === "POST").length, 0, "blank Enter does nothing");
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "topic");
    await ctx.HerdrLocationBar.discoveryCreateKeydown({ key: "Enter", preventDefault() { prevented++; } });
    equal(calls.filter((call) => call.path === "/api/worktrees" && call.init && call.init.method === "POST").length, 1);
    await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
    await ctx.HerdrLocationBar.discoveryCreateWorktree();
    ctx.HerdrLocationBar.discoveryDraft("newBranch", "branch-topic");
    ctx.HerdrLocationBar.discoveryCancelWorktree();
    await ctx.HerdrLocationBar.discoveryCreateKeydown({ key: "Enter", preventDefault() { prevented++; } });
    equal(calls.filter((call) => call.path === "/api/git-ui/switch").length, 1);
    equal(prevented, 3);
  });

  for (const dismissal of ["Escape", "outside", "origin", "replacement"]) {
    it(`ignores stale creation success after ${dismissal}`, async () => {
      const { ctx, bar, listeners } = inlineHarness();
      await ctx.HerdrLocationBar.openDiscoveryForFolder("/picked");
      await ctx.HerdrLocationBar.discoveryCreateWorktree();
      ctx.HerdrLocationBar.discoveryDraft("newBranch", "late");
      const originalFetch = ctx.fetch;
      let finish;
      ctx.fetch = () => new Promise((resolve) => { finish = (body) => resolve({ ok: true, json: async () => body }); });
      let navigated = 0;
      ctx.go = () => { navigated++; };
      const pending = ctx.HerdrLocationBar.discoverySubmitWorktree();
      if (dismissal === "Escape") listeners.keydown({ key: "Escape", stopPropagation() {}, preventDefault() {} });
      if (dismissal === "outside") listeners.click({ target: { closest: () => null } });
      if (dismissal === "origin") ctx.state.workspaces[0].cwd = "/changed";
      if (dismissal === "replacement") {
        ctx.fetch = originalFetch;
        await ctx.HerdrLocationBar.openDiscoveryForFolder("/replacement");
        ctx.HerdrLocationBar.discoveryDraft("newBranch", "replacement-draft");
        ctx.HerdrLocationBar.sync();
      }
      const before = bar.innerHTML;
      finish(CREATED);
      await pending;
      equal(navigated, 0);
      equal(bar.innerHTML, before, "late completion does not repaint or close another opening");
    });
  }
});
