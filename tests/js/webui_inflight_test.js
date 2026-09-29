// Harness that loads the real WebUI JS with stubbed globals and verifies
// the in-flight guards prevent duplicate tab.create / tab.close calls.
"use strict";
const fs = require("fs");

function loadScript(path, stubs) {
  const vm = require("vm");
  const code = fs.readFileSync(path, "utf8");
  const sandbox = Object.assign(
    {
      console,
      setTimeout,
      clearTimeout,
      JSON,
      Math,
      window: {},
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener: () => {},
        createElement: () => ({ style: {}, classList: { add() {} } }),
      },
      navigator: {},
      confirm: () => true,
      history: { pushState() {}, replaceState() {}, push: [] },
      location: { href: "http://localhost/" },
    },
    stubs
  );
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path });
  return sandbox;
}

async function makeHarness({ file, target }) {
  let pending = [];
  let createCalls = 0;
  let closeCalls = 0;
  let releaseAll;
  const gate = new Promise((res) => (releaseAll = res));

  const state = {
    ws: "ws_1",
    tab: "tab_existing",
    pane: null,
    panes: [],
    allTabs: [{ tab_id: "tab_existing", workspace_id: "ws_1" }],
    tabs: [{ tab_id: "tab_existing", workspace_id: "ws_1" }],
    workspaces: [{ workspace_id: "ws_1", label: "WS1" }],
    workspaceBranches: {},
  };

  const sandbox = loadScript(file, {
    state,
    api: async (path, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (/\/api\/tabs$/.test(path) && opts.method === "POST") {
        createCalls += 1;
        await gate; // hold every request until the harness releases
        return { result: { tab: { tab_id: "tab_new_" + createCalls } } };
      }
      if (/\/close$/.test(path) && /\/api\/tabs\//.test(path)) {
        closeCalls += 1;
      }
      if (/\/close$/.test(path) && /\/api\/workspaces\//.test(path) && opts && opts.method === "POST") {
        // workspace close, counted separately (not a tab close)
      }
      return { result: {} };
    },
    go: () => {},
    refresh: () => {},
    render: () => {},
    showBlocking: () => {},
    hideBlocking: () => {},
    resetTerminalConnection: () => {},
    replaceSelectionHistory: () => {},
    selectFallbackTabAfterClosed: () => {},
    removeClosedTabFromState: () => {},
    closeWorkspaceById: async () => {},
    worktreeForWorkspace: () => null,
    tabTitle: (t) => (t && t.tab_id) || "tab",
    confirm: () => true,
  });

  return { sandbox, state, releaseGate: releaseAll, counts: () => ({ createCalls, closeCalls }) };
}

(async () => {
  let failures = 0;
  const check = (name, cond, detail) => {
    if (cond) console.log("PASS " + name);
    else { console.log("FAIL " + name + (detail ? " -- " + detail : "")); failures++; }
  };

  // Desktop newTab: double-trigger while first POST is in flight.
  {
    const h = await makeHarness({ file: process.argv[2] });
    const p1 = h.sandbox.newTab();
    const p2 = h.sandbox.newTab();
    await Promise.resolve();
    h.releaseGate();
    await Promise.all([p1, p2].map((p) => p.catch(() => {})));
    const { createCalls } = h.counts();
    check("desktop newTab drops duplicate while in flight", createCalls === 1, "createCalls=" + createCalls);
  }

  // Desktop newTab: after settle, a new call creates again (guard resets).
  {
    const h = await makeHarness({ file: process.argv[2] });
    const p1 = h.sandbox.newTab();
    await Promise.resolve();
    h.releaseGate();
    await p1;
    await h.sandbox.newTab();
    const { createCalls } = h.counts();
    check("desktop newTab guard resets after settle", createCalls === 2, "createCalls=" + createCalls);
  }

  // Desktop closeTab: double-trigger while first close is in flight.
  {
    const h = await makeHarness({ file: process.argv[2] });
    const p1 = h.sandbox.closeTab("tab_existing");
    const p2 = h.sandbox.closeTab("tab_existing");
    await Promise.resolve();
    h.releaseGate();
    await Promise.all([p1, p2].map((p) => p.catch(() => {})));
    const { closeCalls } = h.counts();
    check("desktop closeTab drops duplicate while in flight", closeCalls === 1, "closeCalls=" + closeCalls);
  }

  // Mobile createPanel: rapid re-taps produce one tab.create.
  {
    let createCalls = 0;
    let releaseAll;
    const gate = new Promise((res) => (releaseAll = res));
    const state = {
      ws: "ws_1",
      tab: null,
      pane: null,
      session: "sess",
      screen: "worktrees",
      tabs: [{ tab_id: "tab_existing", workspace_id: "ws_1" }],
    };
    const mobile = loadScript(process.argv[3], {
      state,
      api: async (path, opts) => {
        if (/\/api\/tabs$/.test(path) && opts.method === "POST") {
          createCalls += 1;
          await gate;
          return { result: { tab: { tab_id: "tab_new_" + createCalls } } };
        }
        return { result: {} };
      },
      confirmFn: () => true,
      refresh: () => {},
      render: () => {},
      showScreen: () => {},
      selectionPath: () => "/",
      currentSessionBackend: () => "builtin",
      saveSessionSelection: () => {},
      currentWorkspaceCwd: () => "/tmp",
      tabTitle: (t) => (t && t.tab_id) || "tab",
      getMobileFileBrowser: () => ({ reset() {} }),
      getMobileTerminal: () => ({ destroy() {}, connect() {} }),
      getMobileSearch: () => ({}),
      getMobileWorktrees: () => ({ load() {}, loadRecent() {} }),
      getMobileTempTerminal: () => ({ open() {} }),
    });
    const actions = mobile.HerdrMobileActionsModule.create({
      state,
      api: mobile.api,
      confirmFn: () => true,
      refresh: () => {},
      render: () => {},
      showScreen: () => {},
      selectionPath: () => "/",
      currentSessionBackend: () => "builtin",
      saveSessionSelection: () => {},
      currentWorkspaceCwd: () => "/tmp",
      tabTitle: (t) => (t && t.tab_id) || "tab",
      getMobileFileBrowser: () => ({ reset() {} }),
      getMobileTerminal: () => ({ destroy() {}, connect() {} }),
      getMobileSearch: () => ({}),
      getMobileWorktrees: () => ({ load() {}, loadRecent() {} }),
      getMobileTempTerminal: () => ({ open() {} }),
    });
    const p1 = actions.createPanel();
    const p2 = actions.createPanel();
    const p3 = actions.createPanel();
    await Promise.resolve();
    releaseAll();
    await Promise.all([p1, p2, p3].map((p) => p.catch(() => {})));
    check("mobile createPanel drops duplicates while in flight", createCalls === 1, "createCalls=" + createCalls);
  }

  process.exit(failures ? 1 : 0);
})();
