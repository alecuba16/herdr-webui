// Unit tests for the shell folder-change flow (desktop/app_js/open_folder_flow.js),
// the shared helper behind the location-bar path chip and the file browser's
// "Open workspace here" action.
//
// vm harness mirrors the bundle scope the module reads: state, api, go,
// showBlocking/hideBlocking, workspaceOpenTerminalFlag, window.HerdrWorkspacePath.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./desktop/app_js/open_folder_flow.js", import.meta.url),
  "utf8",
);

function loadFlow(overrides = {}) {
  const calls = { api: [], go: [], blocking: [] };
  const state = overrides.state || { ws: "cur", workspaces: [] };
  // The module owns its api() with a fetch fallback (like file_browser.js),
  // so the harness stubs fetch, not api.
  const fetchHandler = async (url, options = {}) => {
    calls.api.push({ url, options });
    const text = String(url);
    const handler = overrides.api && overrides.api[text];
    if (handler) {
      const body = await handler(text, options);
      return {
        ok: true,
        async json() { return body; },
      };
    }
    return {
      ok: true,
      async json() { return { result: {} }; },
    };
  };
  const ctx = {
    state,
    fetch: fetchHandler,
    go: (ws, tab, pane) => {
      calls.go.push([ws, tab, pane]);
      if (overrides.go) overrides.go(ws, tab, pane);
    },
    showBlocking: (msg) => calls.blocking.push(["show", msg]),
    hideBlocking: () => calls.blocking.push(["hide"]),
    alert: (msg) => (calls.alert = msg),
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  if (overrides.workspacePath) ctx.HerdrWorkspacePath = overrides.workspacePath;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SOURCE, contextObject);
  return { ctx, calls };
}

describe("open folder flow", () => {
  it("exposes HerdrOpenFolder with openFolderAsWorkspace", () => {
    const { ctx } = loadFlow();
    equal(typeof ctx.HerdrOpenFolder.openFolderAsWorkspace, "function");
  });

  it("focuses an open workspace already on the folder (no fetch, no create)", async () => {
    const { ctx, calls } = loadFlow({
      state: {
        ws: "other",
        workspaces: [
          { workspace_id: "other", cwd: "/elsewhere" },
          { workspace_id: "target", cwd: "/repo" },
        ],
      },
      workspacePath: (w) => w.cwd,
    });
    const moved = await ctx.HerdrOpenFolder.openFolderAsWorkspace("/repo");
    equal(moved, true);
    equal(calls.go.length, 1);
    equal(calls.go[0][0], "target");
    equal(calls.api.length, 0, "no fetch when a workspace already matches");
  });

  it("stays put when the current workspace already is the folder", async () => {
    const { ctx, calls } = loadFlow({
      state: { ws: "cur", workspaces: [{ workspace_id: "cur", cwd: "/repo" }] },
      workspacePath: (w) => w.cwd,
    });
    const moved = await ctx.HerdrOpenFolder.openFolderAsWorkspace("/repo");
    equal(moved, true);
    equal(calls.go.length, 0, "no navigation when the folder is already selected");
    equal(calls.api.length, 0);
  });

  it("opens a git checkout through /api/worktrees/open and navigates to its pane", async () => {
    const { ctx, calls } = loadFlow({
      api: {
        "/api/worktrees?cwd=%2Frepo": () => ({
          result: { worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "wt" }] },
        }),
        "/api/worktrees/open": () => ({
          result: { workspace: { workspace_id: "ws9" }, tab: { tab_id: "tab9" }, root_pane: { pane_id: "pane9" } },
        }),
      },
    });
    const moved = await ctx.HerdrOpenFolder.openFolderAsWorkspace("/repo");
    equal(moved, true);
    const open = calls.api.find((c) => c.url === "/api/worktrees/open");
    ok(open, "worktree.open fired for the matched checkout");
    match(open.options.body, /"path":"\/repo"/);
    ok(!calls.api.some((c) => c.url === "/api/workspaces"), "git checkout skips workspace create");
    equal(calls.go.length, 1);
    equal(calls.go[0].join("|"), "ws9|tab9|pane9");
  });

  it("creates a workspace for a plain folder and records the recent", async () => {
    const { ctx, calls } = loadFlow({
      api: {
        "/api/worktrees?cwd=%2Fplain": () => ({ result: { worktrees: [] } }),
        "/api/workspaces": () => ({
          result: { workspace: { workspace_id: "ws-new" }, tab: { tab_id: "t" }, root_pane: { pane_id: "p" } },
        }),
        "/api/recent-workspaces/record": () => ({ ok: true }),
      },
    });
    const moved = await ctx.HerdrOpenFolder.openFolderAsWorkspace("/plain");
    equal(moved, true);
    const create = calls.api.find((c) => c.url === "/api/workspaces");
    ok(create, "workspace create fired for the plain folder");
    match(create.options.body, /"cwd":"\/plain"/);
    match(create.options.body, /"label":"plain"/);
    ok(calls.api.some((c) => c.url === "/api/recent-workspaces/record"), "recents recorded");
    equal(calls.go[0][0], "ws-new");
  });

  it("survives a failing recents record (workspace still opens)", async () => {
    const { ctx, calls } = loadFlow({
      api: {
        "/api/worktrees?cwd=%2Fplain": () => ({ result: { worktrees: [] } }),
        "/api/workspaces": () => ({
          result: { workspace: { workspace_id: "ws-new" } },
        }),
        "/api/recent-workspaces/record": () => {
          throw Error("recents down");
        },
      },
    });
    const moved = await ctx.HerdrOpenFolder.openFolderAsWorkspace("/plain");
    equal(moved, true);
    equal(calls.go[0][0], "ws-new");
  });

  it("clears the blocking overlay when the flow throws", async () => {
    const { ctx, calls } = loadFlow({
      api: {
        "/api/worktrees?cwd=%2Fplain": () => {
          throw Error("network down");
        },
      },
    });
    let error = null;
    try {
      await ctx.HerdrOpenFolder.openFolderAsWorkspace("/plain");
    } catch (e) {
      error = e;
    }
    ok(error, "the failure surfaces to the caller");
    const last = calls.blocking[calls.blocking.length - 1];
    equal(last[0], "hide", "blocking overlay cleared in finally");
  });

  it("normalizes trailing slashes and backslashes when matching", async () => {
    const { ctx, calls } = loadFlow({
      state: { ws: "cur", workspaces: [{ workspace_id: "w2", cwd: "/repo/" }] },
      workspacePath: (w) => w.cwd,
    });
    await ctx.HerdrOpenFolder.openFolderAsWorkspace("/repo");
    equal(calls.go[0][0], "w2", "trailing slash paths match");
    // Backslash input normalizes to forward slashes (same contract as the
    // drawer's old sameMenuPath), so it matches the same workspace.
    await ctx.HerdrOpenFolder.openFolderAsWorkspace("\\repo");
    equal(calls.go.length, 2, "backslash input matches after normalization");
    equal(calls.go[1][0], "w2");
  });
});
