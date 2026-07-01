import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function element(id = "") {
  return {
    id,
    classList: {
      add() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    style: { setProperty() {} },
    dataset: {},
    value: "",
    checked: false,
    focused: false,
    selected: false,
    textContent: "",
    innerHTML: "",
    title: "",
    setAttribute(name, value) {
      this[name] = value;
    },
    closest() {
      return this;
    },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
    addEventListener() {},
    getBoundingClientRect() {
      return { bottom: 100, height: 100, left: 0, top: 0, width: 100 };
    },
    querySelector() {
      return element();
    },
    querySelectorAll() {
      return [];
    },
  };
}

function context() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorage = new Map();
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) {
      return 1;
    },
    document: {
      body: getElement("body"),
      title: "",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    xterm: { Terminal: class {} },
    WebSocket: class {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    addEventListener() {},
    prompt: () => null,
    confirm: () => true,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

describe("app bundle load", () => {
  let source;
  let gitUiSource;

  beforeEach(() => {
    const desktopAppSource = [
      "./desktop/app_js/core.js",
      "./desktop/app_js/render.js",
      "./desktop/app_js/terminal.js",
      "./desktop/app_js/worktrees.js",
      "./desktop/app_js/shortcuts.js",
      "./desktop/app_js/workspace_create.js",
      "./desktop/app_js/bindings.js",
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("");
    source =
      readFileSync(new URL("./shared/core.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./desktop/search.js", import.meta.url), "utf8") +
      "\n" +
      desktopAppSource;
    gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
  });

  it("loads without initialization-order ReferenceError", () => {
    doesNotThrow(() => vm.runInContext(source, context()));
  });

  it("keeps file history header scoped to selected files", () => {
    match(gitUiSource, /function renderFileToolbar\(activeTab\) \{\n\s+const view = active\(\) \|\| \{\};\n\s+if \(!view\.file\) return "";/);
    equal([...gitUiSource.matchAll(/git-ui-log-head/g)].length, 1);
  });

  it("hides only large file diffs by default", () => {
    match(gitUiSource, /const LARGE_FILE_DIFF_LINE_LIMIT = 500;/);
    match(gitUiSource, /Large diffs are not rendered by default\./);
    match(gitUiSource, /Diff hidden to keep large change sets responsive\./);
    match(gitUiSource, /loadLargeDiff\(file, kind\)/);
    ok(!gitUiSource.includes("Select a file from left list to render its changes."));
    ok(!gitUiSource.includes("Large change set hidden"));
  });

  it("defines Git UI changes-list Escape navigation", () => {
    match(gitUiSource, /window\.addEventListener\("keydown", handleKeydown, true\);/);
    match(gitUiSource, /if \(tab === "changes"\) \{\n\s+this\.showChangesList\(\);\n\s+return;\n\s+\}/);
    match(gitUiSource, /Leave commit editor and return to changes\? Draft is saved locally\./);
    match(gitUiSource, /Hide Git UI\?/);
    match(gitUiSource, /function isChangesListView\(view\)/);
  });

  it("keeps Git UI keyboard input away from the terminal", () => {
    match(gitUiSource, /Git drawer owns keyboard while visible/);
    match(gitUiSource, /event\.stopImmediatePropagation/);
    match(gitUiSource, /function handleGitShortcut\(event, view\)/);
    match(gitUiSource, /function isGitShortcutPrefix\(event\)/);
    match(gitUiSource, /function gitShortcutPrefixLabel\(\)/);
    match(gitUiSource, /function shortcutFilePath\(event, view\)/);
    match(gitUiSource, /DEFAULT_GIT_SHORTCUTS/);
    match(gitUiSource, /gitShortcutMap\(\)/);
    match(gitUiSource, /activateTreeItem\(event\)/);
    match(gitUiSource, /role="treeitem" tabindex="0" data-git-path=/);
    match(source, /HerdrGitUi\.isVisible\(\)\)\n\s+return false;/);
  });

  it("renders shortcut editor with collision detection", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.shortcutsModalHtml();

    match(html, /id="shortcutEditor"/);
    match(source, /DEFAULT_WEBUI_SHORTCUTS/);
    match(source, /removeWorktreeAlt: "Backspace"/);
    match(source, /removeWorktreeAlt: \(\) =>/);
    match(source, /DEFAULT_GIT_SHORTCUTS/);
    match(source, /function shortcutCollisionFor\(scope, action, key\)/);
    match(source, /data-shortcut-record/);
    match(source, /Shortcut conflict with:/);
  });

  it("keeps Git prefix shortcuts collision-free with WebUI prefix keys", () => {
    const webuiKeys = new Set([...source.matchAll(/case "([^"]+)":/g)].map((match) => match[1]));
    const gitKeys = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyC", "KeyL", "KeyR", "KeyG", "KeyY", "KeyU", "KeyD", "KeyZ", "KeyH", "KeyM", "KeyE", "KeyO", "KeyV", "KeyI", "Digit0"];
    equal(gitKeys.filter((key) => webuiKeys.has(key)).join(","), "");
  });

  it("defines Git cleanup tab and maintenance endpoints", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(gitUiSource, /git-ui-cleanup-tab-icon/);
    match(gitUiSource, /scanCleanup/);
    match(gitUiSource, /selectAllCleanup/);
    match(gitUiSource, /Delete selected/);
    match(gitUiSource, /\/api\/git-ui\/cleanup-scan/);
    match(gitUiSource, /\/api\/git-ui\/branch-delete/);
    match(gitUiSource, /\/api\/git-ui\/worktree-remove/);
    match(gitUiSource, /HerdrDirectoryPicker\.openInput\('gitUiCleanupRoot'\)/);
  });

  it("defines file explorer and Git file filters", () => {
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /q=\$\{encodeURIComponent\(state\.filter\.trim\(\)\)\}/);
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /setTimeout\(\(\) => \{/);
    match(gitUiSource, /placeholder="Filter files"/);
    match(gitUiSource, /filterFiles/);
  });

  it("renders new workspace modal with manual folder field", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.workspaceCreateModalHtml();

    match(html, /id="workspaceCreatePath"/);
    ok(!html.includes("workspacePathOptions"));
    match(html, /id="workspaceCreateLabel"/);
    match(html, /id="workspaceCreateSubmit"/);
  });

  it("renders unified workspace and worktree opener", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.worktreeOpenModalHtml();

    match(html, /<h2>Open workspace<\/h2>/);
    match(html, /id="worktreeDiscoverPath"/);
    match(html, /id="worktreeWorkspaceLabel"/);
    match(html, /id="worktreeWorkspaceSubmit"/);
    match(html, /id="worktreeOpenList"/);
    match(html, /id="worktreeNewSection"/);
    ok(!source.includes('id = "openWorktrees"'));
  });

  it("resolves workspace path from pane cwd when workspace metadata is missing", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext(`state.panes = [
      {
        workspace_id: "ws1",
        cwd: "/repo/from-pane",
        foreground_cwd: "/repo/from-foreground",
      },
    ];`, ctx);

    equal(ctx.workspacePath({ workspace_id: "ws1" }), "/repo/from-foreground");
    equal(
      ctx.workspacePath({ workspace_id: "ws1", cwd: "/repo/from-workspace" }),
      "/repo/from-workspace",
    );
  });

  it("renders server access settings fields", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.serverSettingsHtml();

    match(html, /id="optServerBind"/);
    match(html, /id="optServerUser"/);
    match(html, /id="optServerPassword"/);
    match(html, /id="optServerLocalBypass"/);
    match(html, /id="optNoSleepAutoCooldown"/);
    match(html, /id="serverSettingsApply"/);
    match(html, /<h3>Network access<\/h3>/);
    match(html, /<h3>Power behavior<\/h3>/);
    match(html, /\.config\/herdr-webui\/webui-settings\.json/);
  });

  it("defines grouped settings sections", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id=\"settingsSearch\"/);
    match(source, /function setupSettingsSearch\(\)/);
    match(source, /function filterSettings\(\)/);
    match(source, /settings-filter-hidden/);
    match(source, /title: "Appearance"/);
    match(source, /title: "Terminal input"/);
    match(source, /title: "Agents and alerts"/);
    match(source, /id="optBrowserNotifications"/);
    match(source, /title: "Worktrees"/);
    match(source, /title: "Server"/);
  });

  it("defines keyboard shortcuts and terminal font settings", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optGlobalShortcutsEnabled"/);
    match(source, /id="optGlobalShortcutPrefix"/);
    match(source, /id="optGlobalShortcutPrefixCapture"/);
    match(source, /DEFAULT_GLOBAL_SHORTCUT_PREFIX/);
    match(source, /id="optTerminalFontFamily"/);
    match(source, /id="optTerminalLinks"/);
    match(source, /JetBrainsMono Nerd Font/);
    match(source, /handleGlobalShortcut/);
    match(source, /isShortcutPrefix/);
    match(source, /runPrefixedShortcut/);
    match(source, /selectRelativeAgent\(1\)/);
    match(source, /selectRelativeAgent\(-1\)/);
    match(source, /terminalFontFamily/);
    match(source, /applyTerminalLinks/);
    match(source, /registerLinkProvider/);
    match(source, /buffer\.viewportY/);
  });

  it("normalizes configurable shortcut prefixes", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.normalizeShortcutPrefix("control+b"), "Ctrl+B");
    equal(ctx.normalizeShortcutPrefix("Option+Shift+x"), "Alt+Shift+X");
    equal(ctx.normalizeShortcutPrefix("bad+b"), "Ctrl+B");
    equal(ctx.normalizeShortcutPrefix("b"), "Ctrl+B");
  });

  it("cycles agents by blocked done idle working priority", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const order = vm.runInContext(
      `state.agents = [
        { agent_status: "working", pane_id: "working" },
        { agent_status: "idle", pane_id: "idle" },
        { agent_status: "blocked", pane_id: "blocked" },
        { agent_status: "done", pane_id: "done" },
      ];
      agentCycleList().map((agent) => agent.pane_id).join(",");`,
      ctx,
    );

    equal(order, "blocked,done,idle,working");
  });

  it("shows linked worktree branch as title and custom label as label chip", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `const workspace = {
        workspace_id: "ws1",
        label: "friendly label",
        pane_count: 1,
        agent_status: "idle",
        worktree: {
          is_linked_worktree: true,
          checkout_path: "/tmp/repo/folder-name",
        },
      };
      state.worktrees = [{
        open_workspace_id: "ws1",
        path: "/tmp/repo/folder-name",
        branch: "feature/demo",
        label: "repo label",
      }];
      ({ title: workspaceDisplayTitle(workspace), meta: spaceMeta(workspace) });`,
      ctx,
    );

    equal(result.title, "feature/demo");
    match(result.meta, /chip label/);
    match(result.meta, /friendly label/);
    equal(result.meta.includes("chip branch"), false);
  });

  it("shows linked worktree custom label in agent list", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `const workspace = {
        workspace_id: "ws1",
        label: "friendly label",
        worktree: {
          is_linked_worktree: true,
          checkout_path: "/tmp/repo/folder-name",
          repo_key: "repo",
          repo_name: "repo",
        },
      };
      state.worktrees = [{
        open_workspace_id: "ws1",
        path: "/tmp/repo/folder-name",
        branch: "feature/demo",
        label: "repo label",
      }];
      renderAgentRow(
        { workspace_id: "ws1", tab_id: "tab1", pane_id: "pane1", agent_status: "idle", name: "agent" },
        { ws1: workspace },
        { tab1: { workspace_id: "ws1", tab_id: "tab1", label: "" } },
        new Map([["ws1", 1]]),
      );`,
      ctx,
    );

    match(html, /agent-worktree[^>]*>friendly label</);
    equal(html.includes("feature/demo"), false);
  });

  it("searches labels agents repos and returns panel targets", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const results = vm.runInContext(
      `state.workspaces = [{
        workspace_id: "ws1",
        label: "friendly label",
        worktree: {
          is_linked_worktree: true,
          repo_name: "repo-name",
          repo_key: "repo-key",
          repo_root: "/tmp/repo",
          checkout_path: "/tmp/worktrees/repo/feature",
        },
      }];
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "main panel" }];
      state.allTabs = state.tabs;
      state.panes = [{ tab_id: "tab1", pane_id: "pane1" }];
      state.worktrees = [{ open_workspace_id: "ws1", path: "/tmp/worktrees/repo/feature", branch: "feature/demo", label: "repo label" }];
      state.agents = [{ workspace_id: "ws1", tab_id: "tab1", pane_id: "pane1", agent_status: "blocked", name: "deploy agent" }];
      ({ label: searchCandidates("friendly")[0], agent: searchCandidates("deploy")[0], repo: searchCandidates("repo-name")[0] });`,
      ctx,
    );

    equal(results.label.ws, "ws1");
    equal(results.label.tab, "tab1");
    equal(results.label.pane, "pane1");
    equal(results.agent.kind, "agent");
    equal(results.repo.ws, "ws1");
  });

  it("hides repo header actions when parent workspace card exists", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.worktrees = [{ is_linked_worktree: true, source_repo_key: "repo", open_workspace_id: null }];
      renderRepoHeader({ key: "repo", label: "repo", parent: { workspace_id: "ws1" } });`,
      ctx,
    );

    equal(html.includes("with-actions"), false);
    equal(html.includes("repo-actions"), false);
  });

  it("does not render repo header when parent workspace card exists", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.workspaces = [
        {
          workspace_id: "parent",
          label: "repo",
          pane_count: 1,
          agent_status: "idle",
          worktree: {
            is_linked_worktree: false,
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/tmp/repo",
            checkout_path: "/tmp/repo",
          },
        },
        {
          workspace_id: "child",
          label: "feature",
          pane_count: 1,
          agent_status: "idle",
          worktree: {
            is_linked_worktree: true,
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/tmp/repo",
            checkout_path: "/tmp/worktrees/repo/feature",
          },
        },
      ];
      state.worktrees = [
        { open_workspace_id: "parent", path: "/tmp/repo", branch: "main" },
        { open_workspace_id: "child", path: "/tmp/worktrees/repo/feature", branch: "feature" },
      ];
      renderSpaces();`,
      ctx,
    );

    equal(html.includes("repo-header workspace-orphan-header"), false);
    match(html, /workspace-group-main/);
  });

  it("closes the last panel by closing its workspace instead of tab.close", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const calls = await vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        return { result: {} };
      };
      refresh = () => {};
      state.ws = "ws1";
      state.tab = "tab1";
      state.pane = "pane1";
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "one" }];
      state.allTabs = state.tabs;
      state.panes = [{ tab_id: "tab1", pane_id: "pane1" }];
      closeTab("tab1").then(() => calls);`,
      ctx,
    );

    equal(calls.length, 1);
    equal(calls[0].url, "/api/workspaces/ws1/close");
  });

  it("closes workspace panels through workspace.close", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const calls = await vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        return { result: {} };
      };
      closeWorkspaceById("ws1").then(() => calls);`,
      ctx,
    );

    equal(calls.map((call) => call.url).join(","), "/api/workspaces/ws1/close");
  });

  it("defines stuck-working dismissal controls", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optWorkingDismissMinutes"/);
    match(source, /id="optStuckWorkingEnabled"/);
    match(source, /id="optAgentSortMode"/);
    match(source, /id="optParentCloseMode"/);
    match(source, /Dismiss/);
    match(source, /herdr-web-working-dismissals/);
    match(source, /displayStatus = dismissed \? "ignored"/);
  });

  it("defines sidebar collapse controls", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

    match(html, /id="sidebarToggle"/);
    match(source, /herdr-web-sidebar-collapsed/);
    match(source, /applySidebarCollapsed/);
    match(source, /sidebarAgentStatusCounts/);
    match(source, /sidebar-count/);
  });

  it("renders collapsed sidebar agent counters", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-sidebar-collapsed", "1");
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.agents = [
        { agent_status: "blocked" },
        { agent_status: "working" },
        { agent_status: "idle" },
        { agent_status: "done" },
        { agent_status: "done" },
      ];
      sidebarToggleHtml();`,
      ctx,
    );

    match(html, /sidebar-count blocked[^>]*>1</);
    match(html, /sidebar-count working[^>]*>1</);
    match(html, /sidebar-count idle[^>]*>1</);
    match(html, /sidebar-count done[^>]*>2</);
  });

  it("fast-refreshes pane, tab, and worktree lifecycle events", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.eventNeedsFastRefresh("pane.closed"), true);
    equal(ctx.eventNeedsFastRefresh("pane.exited"), true);
    equal(ctx.eventNeedsFastRefresh("tab.closed"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.created"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.opened"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.removed"), true);
    equal(ctx.eventNeedsFastRefresh("pane.focused"), false);
  });

  it("switches selected pane when Herdr reports current pane exited", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tab = "tab_1";
       state.panes = [
         { tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" },
         { tab_id: "tab_1", pane_id: "pane_2", terminal_id: "term_2" },
       ];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });
       ({ pane: state.pane, terminalId: state.terminalId });`,
      ctx,
    );

    equal(result.pane, "pane_2");
    equal(result.terminalId, "term_2");
  });

  it("replaces stale route after selected panel disappears", async () => {
    const ctx = context();
    const replaced = [];
    ctx.location.pathname = "/session/default/workspace/ws1/tab/old/pane/oldpane";
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    ctx.Terminal = class {
      open() {}
      onData() {}
      onScroll() {}
      loadAddon() {}
      clear() {}
      focus() {}
      resize() {}
      dispose() {}
    };
    ctx.fetch = async (url) => {
      const text = String(url);
      const result = text.includes("workspaces")
        ? { workspaces: [{ workspace_id: "ws1", label: "repo" }] }
        : text.includes("workspace-order")
          ? { order: [] }
          : text.includes("worktrees")
            ? { source: {}, worktrees: [] }
            : text.includes("tabs")
              ? { tabs: [{ workspace_id: "ws1", tab_id: "new", number: 1 }] }
              : text.includes("panes")
                ? { panes: [{ workspace_id: "ws1", tab_id: "new", pane_id: "newpane", terminal_id: "term2" }] }
                : text.includes("pane-layout")
                  ? { layout: { panes: [] } }
                  : { agents: [] };
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    vm.runInContext(source, ctx);

    const result = await vm.runInContext(
      "refreshSeq = 1; refreshOnline(1).then(() => ({ tab: state.tab, pane: state.pane }))",
      ctx,
    );

    equal(result.tab, "new");
    equal(result.pane, "newpane");
    ok(replaced.some((url) => String(url).includes("/tab/new/pane/newpane")));
  });

  it("clears selected pane when no fallback pane remains", () => {
    const ctx = context();
    const replaced = [];
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tab = "tab_1";
       state.ws = "ws1";
       state.panes = [{ tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" }];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });
       ({ pane: state.pane, terminalId: state.terminalId });`,
      ctx,
    );

    equal(result.pane, null);
    equal(result.terminalId, null);
    equal(replaced.at(-1), "/session/default/workspace/ws1");
  });

  it("clears stale terminal DOM when selected pane exits even without xterm object", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const terminal = ctx.document.getElementById("terminal");
    terminal.innerHTML = "stale terminal";

    vm.runInContext(
      `term = null;
       state.ws = "ws1";
       state.tab = "tab_1";
       state.pane = "pane_1";
       state.terminalId = "term_1";
       state.panes = [{ tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" }];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });`,
      ctx,
    );

    equal(terminal.innerHTML, "");
  });

  it("auto-closes pane when Herdr reports it exited", async () => {
    const requests = [];
    const ctx = context();
    ctx.fetch = async (url, opt) => {
      requests.push({ url, method: (opt && opt.method) || "GET" });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    vm.runInContext(source, ctx);

    vm.runInContext(
      `forgetClosedSelection("pane.exited", { pane_id: "pane_1" });`,
      ctx,
    );
    await Promise.resolve();

    const closeRequest = requests.find((request) => request.url === "/api/panes/pane_1/close");
    ok(closeRequest);
    equal(closeRequest.method, "POST");
  });

  it("keeps blocked agents first when attention sorting is inverted", () => {
    const ctx = context();
    ctx.localStorage.setItem(
      "herdr-web-options",
      JSON.stringify({ agentSortMode: "attention_inverted" }),
    );
    vm.runInContext(source, ctx);

    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "blocked" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "working" },
          { agent_status: "blocked" },
        ),
      ),
      1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "working" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "unknown" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
  });

  it("keeps blocked agents first, then idle before done", () => {
    const ctx = context();
    ctx.localStorage.setItem(
      "herdr-web-options",
      JSON.stringify({ agentSortMode: "attention" }),
    );
    vm.runInContext(source, ctx);

    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "blocked" },
          { agent_status: "idle" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "idle" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "idle" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "done" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
  });

  it("defines tab activity setting and badge", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optShowTabActivity"/);
    match(source, /tab-activity/);
    match(source, /tabActivityLabel/);
  });

  it("renders current panel as label with add and close buttons", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const html = vm.runInContext(
      `state.ws = "ws1";
       state.tab = "tab1";
       state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "main" }];
       renderPanelField();`,
      ctx,
    );

    match(html, /panel-label/);
    match(html, /panel-add/);
    match(html, /panel-close/);
    match(html, /Close current panel/);
    ok(!html.includes("panelSelector"));
  });

  it("captures terminal paste before xterm native paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /pasteToTerminal\(text\)/);
  });

  it("renders no-sleep control options", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.noSleepControlHtml("noSleepTest");

    match(html, /id="noSleepTest"/);
    match(html, /value="off"/);
    match(html, /shell-icon-button/);
    match(html, /coffee-outline/);
  });

  it("does not duplicate no-sleep control in static header", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

    equal(html.includes("noSleepSelect"), false);
  });

  it("handles rejected audio unlock attempts", () => {
    const ctx = context();
    ctx.AudioContext = class {
      resume() {
        return Promise.reject(new Error("blocked"));
      }
    };
    vm.runInContext(source, ctx);

    doesNotThrow(() => ctx.unlockAudio());
  });

  it("requests browser notification permission before enabling notifications", async () => {
    const ctx = context();
    let requested = false;
    ctx.Notification = {
      permission: "default",
      async requestPermission() {
        requested = true;
        this.permission = "granted";
        return "granted";
      },
    };
    vm.runInContext(source, ctx);

    await ctx.setBrowserNotifications(true);

    equal(requested, true);
    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).browserNotifications,
      true,
    );
  });

  it("uses louder attention sound gain", () => {
    match(source, /notificationVolume: 0\.24/);
    match(source, /function attentionSoundVolume\(\)/);
  });

  it("stores desktop notification volume from Settings", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.document.getElementById("optNotificationVolume").value = "65";
    ctx.document.getElementById("optNotificationVolume").oninput();

    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).notificationVolume,
      0.65,
    );
    equal(ctx.document.getElementById("notificationVolumeValue").textContent, "65");
  });

  it("requires credentials for non-local server bind", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(
      ctx.serverSettingsValidationError("0.0.0.0:8787", "", "", false),
      "Username and password are required before binding to 0.0.0.0 or any non-local address.",
    );
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "pass", false), "");
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "", true), "");
    equal(ctx.serverSettingsValidationError("127.0.0.1:8787", "", "", false), "");
  });

  it("renders extracted worktree and shortcut modals", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateForm"/);
    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateSubmit"/);
    match(ctx.worktreeOpenModalHtml(), /id="worktreeDiscoverPath"/);
    ok(!ctx.worktreeOpenModalHtml().includes("worktreePathOptions"));
    match(ctx.worktreeOpenModalHtml(), /id="worktreeBranchOptions"/);
    match(ctx.shortcutsModalHtml(), /id="shortcutsModal"/);
    match(ctx.shortcutsModalHtml(), /id="closeShortcutCurrent"/);
  });

  it("prefills workspace label from final folder segment", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value =
      "/Users/me/projects/herdr-webui/";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "herdr-webui");
  });

  it("keeps manually edited workspace label while folder changes", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/first";
    ctx.syncWorkspaceCreateLabel();
    ctx.document.getElementById("workspaceCreateLabel").value = "custom";
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/second";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "custom");
  });

  it("focuses and selects suggested workspace label", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/project";

    ctx.focusWorkspaceCreateLabel();

    const label = ctx.document.getElementById("workspaceCreateLabel");
    equal(label.value, "project");
    equal(label.focused, true);
    equal(label.selected, true);
  });

  it("uses workspace fallback label for empty folder", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.suggestedWorkspaceLabel(""), "workspace");
  });

  it("does not expose old path suggestion helper", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.loadDirectoryPathSuggestions, undefined);
    equal(ctx.schedulePathSuggestions, undefined);
  });

  it("workspace path changes only update generated label", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/project";

    ctx.workspaceCreatePathChanged();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "project");
  });

  it("keeps exploration and worktree default directories separate", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "");

    ctx.document.getElementById("optWorktreeDefaultDirectory").value = "/tmp/worktrees";
    ctx.document.getElementById("optWorktreeDefaultDirectory").oninput();
    ctx.document.getElementById("optExplorationDefaultDirectory").value = "/tmp/code";
    ctx.document.getElementById("optExplorationDefaultDirectory").oninput();
    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "/tmp/code");

    ctx.openWorktreeOpenModal();

    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "/tmp/code");

    vm.runInContext('state.openWorktreeSource = { repo_name: "repo", repo_root: "/src/repo" }', ctx);
    ctx.document.getElementById("worktreeNewBranch").value = "feature/x";
    ctx.syncWorktreeCheckoutPath();
    equal(ctx.document.getElementById("worktreeNewPath").value, "/tmp/worktrees/repo/feature-x");
  });
});
