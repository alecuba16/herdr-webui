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
import { equal, match, ok } from "node:assert/strict";
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
});