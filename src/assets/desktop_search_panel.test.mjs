// Embedded search panel (Search rail view) behavior tests. Pins:
//   - the panel hosts into #rightSidebarContent through HerdrRightSidebar
//     and remembers the "search" shell mode
//   - the panel renders the palette section markup against its own state
//     (input, sections, panel-scoped callbacks instead of palette ones)
//   - the expand-from-terminal fallback resolves a hosted view so the
//     extended column never renders empty
//   - resolveHostedShellMode: current hosted mode wins, per-path memory
//     covers terminal workspaces, files is the floor
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeNode(id, className) {
  const node = {
    id,
    className: className || "",
    dataset: {},
    nodeType: 1,
    children: [],
    parentNode: null,
    style: {},
    hidden: false,
    attributes: {},
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name] != null ? node.attributes[name] : null;
    },
    appendChild(child) {
      if (child.parentNode) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (node.parentNode) {
        const at = node.parentNode.children.indexOf(node);
        if (at >= 0) node.parentNode.children.splice(at, 1);
        node.parentNode = null;
      }
    },
    querySelector(selector) {
      const wantId = selector.startsWith("#") ? selector.slice(1) : null;
      const walk = (n) => {
        for (const child of n.children) {
          if (wantId && child.id === wantId) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
  };
  Object.defineProperty(node, "childNodes", {
    get() {
      return node.children;
    },
  });
  return node;
}

function buildDom() {
  const body = makeNode("body", "");
  const app = makeNode("app", "");
  const content = makeNode("rightSidebarContent", "right-sidebar-content");
  const shell = makeNode("terminalShell", "terminal-shell");
  app.appendChild(content);
  app.appendChild(shell);
  body.appendChild(app);
  const nodes = { body, app, rightSidebarContent: content, terminalShell: shell };
  // innerHTML replaces child nodes; parse the ids the panel markup carries
  // so querySelector/getElementById and focus/caret behave like the DOM.
  const parseInnerHtml = (host, html) => {
    host.children.length = 0;
    if (html.includes('id="searchPanelInput"')) {
      const input = makeNode("searchPanelInput", "search-panel-input");
      input.value = "";
      input.selectionStart = 0;
      input.selectionEnd = 0;
      input.focus = () => { document.activeElement = input; };
      input.setSelectionRange = (a, b) => { input.selectionStart = a; input.selectionEnd = b; };
      input.addEventListener = (type, fn) => {
        input.__listeners = input.__listeners || {};
        (input.__listeners[type] = input.__listeners[type] || []).push(fn);
      };
      input.__fire = (type, event) => (input.__listeners && input.__listeners[type] ? input.__listeners[type].forEach((fn) => fn(event || {})) : null);
      nodes.searchPanelInput = input;
      host.appendChild(input);
    }
    if (html.includes('id="searchPanelClear"')) {
      const clear = makeNode("searchPanelClear", "mini");
      nodes.searchPanelClear = clear;
      host.appendChild(clear);
    }
    if (html.includes('id="searchPanelResults"')) {
      const results = makeNode("searchPanelResults", "search-panel-results");
      nodes.searchPanelResults = results;
      host.appendChild(results);
    }
  };
  // Real DOM resolves created nodes by id after assignment; the fake needs
  // the registry to observe id writes (git_ui/file_browser do the same).
  const document = {
    activeElement: null,
    createElement: () => {
      const node = makeNode("", "");
      let id = "";
      let inner = "";
      Object.defineProperty(node, "id", {
        get: () => id,
        set: (value) => {
          id = String(value);
          nodes[id] = node;
        },
      });
      Object.defineProperty(node, "innerHTML", {
        get: () => inner,
        set: (html) => {
          inner = String(html);
          parseInnerHtml(node, inner);
        },
      });
      return node;
    },
    getElementById: (id) => (nodes[id] ? nodes[id] : null),
  };
  return { nodes, document };
}

function loadPanel(document, ctxOverrides = {}) {
  const stored = {};
  const ctx = {
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    localStorage: { getItem: (k) => stored[k] || null, setItem: (k, v) => { stored[k] = String(v); }, removeItem: (k) => { delete stored[k]; } },
    state: { ws: "ws-1", workspaces: [], workspaceShell: {} },
    el: (id) => document.getElementById(id),
    inputAttrs: (hint) => ` autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no" enterkeyhint="${hint}"`,
    escapeHtml: (v) => String(v),
    escapeAttr: (v) => String(v),
    currentSearchWorkspace: () => ({ workspace_id: "ws-1", label: "Repo", cwd: "/repo" }),
    workspacePath: (w) => (w && w.cwd) || "",
    selectedOrDefaultWorkspace: () => ({ workspace_id: "ws-1", label: "Repo", cwd: "/repo" }),
    workspaceDisplayTitle: () => "Repo",
    actionsOnlyQuery: (q) => String(q || "").trimStart().startsWith(">"),
    searchActionCandidates: () => [],
    searchCandidates: () => [],
    pathSearchAvailable: () => true,
    renderActionSection: (actions, opts, cb) => `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('actions')"></section>`,
    renderTargetSection: (targets, cb) => `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('workspaces')"></section>`,
    renderRecentSection: (recent, cb) => `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('recent')"></section>`,
    renderWorkspacePathSection: (opts, cb) => `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('files')"></section>`,
    renderWorkspaceContentSection: (cb) => `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('content')"></section>`,
    api: async () => ({}),
    alert: () => {},
    rememberWorkspaceShellMode: (mode, id) => {
      ctx.__remembered = { mode, id };
    },
    currentWorkspaceShellMode: () => ctx.__mode || "terminal",
    syncShellModeButtons: () => {},
    render: () => {},
    HerdrScheduleTerminalResize: () => {},
    HerdrRightSidebar: {
      collapsed: () => ctx.__collapsed === true,
      setCollapsed: (v) => {
        ctx.__collapsed = v;
      },
      openView: async (mode, id, ensurePanel) => {
        const panel = ensurePanel();
        const host = document.getElementById("rightSidebarContent");
        if (host && panel && panel.parentNode !== host) host.appendChild(panel);
        return "hosted";
      },
      afterDrawerRender: () => {},
      apply: () => {},
      isHosted: (id) => {
        const host = document.getElementById("rightSidebarContent");
        const panel = document.getElementById(id);
        return !!(host && panel && panel.parentNode === host);
      },
    },
    ...ctxOverrides,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  // search_panel.js references shared-core helpers and palette renderers;
  // the overrides above stub them, so only the panel module is needed.
  const source = readFileSync(new URL("./desktop/app_js/search_panel.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));
  return ctx;
}

test("open hosts the panel, remembers search mode, and expands a collapsed column", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);
  ctx.__collapsed = true;

  await ctx.HerdrSearchPanel.open("ws-1", {});

  assert.equal(ctx.__remembered.mode, "search", "open remembers the search shell mode");
  const panel = nodes.searchPanel;
  assert.ok(panel, "panel created and registered");
  assert.equal(panel.parentNode, nodes.rightSidebarContent, "panel hosted in the sidebar column");
  // A rail click (no forceOpen) expands a collapsed column.
  assert.equal(ctx.__collapsed, false, "rail click expands the column");
});

test("the panel renders its own input and panel-scoped section callbacks", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);

  await ctx.HerdrSearchPanel.open("ws-1", {});
  const markup = String(nodes.searchPanel.innerHTML);
  assert.ok(markup.includes('id="searchPanelInput"'), "panel input renders");
  assert.ok(markup.includes("HerdrSearchPanel.panel"), "sections call the panel api, not the palette");
  assert.ok(!markup.includes("HerdrSearchPalette.toggleSection"), "no palette callbacks leak into the panel");
});

test("close removes the panel and reopen remounts it", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);

  await ctx.HerdrSearchPanel.open("ws-1", { forceOpen: true });
  assert.ok(nodes.searchPanel.parentNode === nodes.rightSidebarContent);
  ctx.HerdrSearchPanel.close();
  assert.equal(nodes.searchPanel.parentNode, null, "close detaches the panel");
  assert.equal(ctx.HerdrSearchPanel.isOpen(), false);

  await ctx.HerdrSearchPanel.open("ws-1", { forceOpen: true });
  assert.equal(nodes.searchPanel.parentNode, nodes.rightSidebarContent, "reopen hosts the panel again");
});

test("resolveHostedShellMode: current hosted mode wins, path memory next, files floor", () => {
  const { document } = buildDom();
  const stored = {};
  const ctx = {
    document,
    localStorage: { getItem: (k) => stored[k] || null, setItem: (k, v) => { stored[k] = String(v); } },
    state: {
      ws: "ws-1",
      workspaces: [{ workspace_id: "ws-1", cwd: "/repo" }],
      workspaceShell: {},
    },
    el: (id) => document.getElementById(id),
    workspacePath: (w) => (w && w.cwd) || "",
    syncShellModeButtons: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const source = readFileSync(new URL("./desktop/app_js/workspace_shell.js", import.meta.url), "utf8");
  vm.runInContext(source, vm.createContext(ctx));

  // Floor: terminal mode with no memory resolves files.
  assert.equal(ctx.resolveHostedShellMode("ws-1"), "files", "terminal with no memory falls back to files");

  // A remembered path entry for the same folder wins over files.
  ctx.state.workspaceShell["path:/repo"] = { mode: "git", at: 1 };
  assert.equal(ctx.resolveHostedShellMode("ws-1"), "git", "per-path memory resolves the last hosted view");

  // A live hosted mode beats the path memory.
  ctx.state.workspaceShell["ws-1"] = { mode: "search" };
  assert.equal(ctx.resolveHostedShellMode("ws-1"), "search", "current hosted mode wins");

  // rememberWorkspaceShellMode accepts search and persists it.
  ctx.rememberWorkspaceShellMode("search", "ws-1");
  assert.equal(ctx.currentWorkspaceShellMode("ws-1"), "search", "search persists as a shell mode");
});

test("typing keeps focus and caret across the re-render", async () => {
  const { nodes, document } = buildDom();
  const ctx = loadPanel(document);

  await ctx.HerdrSearchPanel.open("ws-1", {});
  const input = nodes.searchPanelInput;
  assert.ok(input, "panel input exists after open");
  input.focus();
  assert.equal(document.activeElement, input, "input focused before typing");

  // Type "read": each keystroke fires input, which re-renders the panel.
  input.value = "read";
  input.selectionStart = 4;
  input.selectionEnd = 4;
  input.__fire("input");
  const afterFirst = nodes.searchPanelInput;
  assert.notEqual(afterFirst, input, "innerHTML swap replaces the input node");
  assert.equal(document.activeElement, afterFirst, "focus restored on the new node");
  assert.equal(afterFirst.selectionStart, 4, "caret position preserved");
  assert.equal(afterFirst.value, "read", "query synced to the fresh node");

  // A second keystroke keeps focus on the latest node too.
  afterFirst.value = "readm";
  afterFirst.selectionStart = 5;
  afterFirst.selectionEnd = 5;
  afterFirst.__fire("input");
  const afterSecond = nodes.searchPanelInput;
  assert.equal(document.activeElement, afterSecond, "focus survives the second re-render");
  assert.equal(afterSecond.selectionStart, 5, "caret follows typing");
});

test("search falls back to the default folder when nothing is selected", async () => {
  const { nodes, document } = buildDom();
  const searched = [];
  const ctx = loadPanel(document, {
    state: { ws: null, workspaces: [], workspaceShell: {} },
    currentSearchWorkspace: () => null,
    selectedOrDefaultWorkspace: () => ({ workspace_id: "__default_folder__", label: "Default folder", cwd: "/Users/alejandro.blanco", default_folder: true }),
    HerdrWorkspaceSearch: {
      settings: () => ({ searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, searchSectionOrder: ["workspaces", "files", "content"], contentMinChars: 3 }),
      createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
      resetContentState: () => {},
      workspaceCwd: (w) => (w && w.cwd) || "",
      searchPaths: async (args) => { searched.push({ kind: "paths", cwd: args.cwd }); return { entries: [], git_status: null, truncated: false }; },
      searchContent: async (args) => { searched.push({ kind: "content", cwd: args.cwd }); return { files: [], total_files: 0, total_matches: 0, truncated: false }; },
    },
  });

  await ctx.HerdrSearchPanel.open("ws-1", {});
  // Boot-clean state: nothing selected, default folder is the root.
  const state = ctx.HerdrSearchPanel;
  assert.ok(state, "panel api exposed");
  const input = nodes.searchPanelInput;
  input.value = "term";
  input.__fire("input");

  // The debounced runSearch fires after 180ms; the input event already
  // re-rendered. Wait for the debounce, then inspect the searched roots.
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.ok(searched.some((s) => s.cwd === "/Users/alejandro.blanco"), "paths searched the default folder");
  assert.ok(searched.some((s) => s.cwd === "/Users/alejandro.blanco" && s.kind === "content"), "content search used the default folder");
});

test("selected workspace folder wins over the default folder", async () => {
  const { nodes, document } = buildDom();
  const searched = [];
  const ctx = loadPanel(document, {
    currentSearchWorkspace: () => ({ workspace_id: "ws-1", label: "Repo", cwd: "/repo" }),
    HerdrWorkspaceSearch: {
      settings: () => ({ searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, searchSectionOrder: ["workspaces", "files", "content"], contentMinChars: 3 }),
      createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
      resetContentState: () => {},
      workspaceCwd: (w) => (w && w.cwd) || "",
      searchPaths: async (args) => { searched.push({ kind: "paths", cwd: args.cwd }); return { entries: [], git_status: null, truncated: false }; },
      searchContent: async (args) => { searched.push({ kind: "content", cwd: args.cwd }); return { files: [], total_files: 0, total_matches: 0, truncated: false }; },
    },
  });

  await ctx.HerdrSearchPanel.open("ws-1", {});
  const input = nodes.searchPanelInput;
  input.value = "term";
  input.__fire("input");
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.ok(searched.length > 0, "search ran");
  assert.ok(searched.every((s) => s.cwd === "/repo"), "every search used the selected workspace folder");
});

test("panel result callbacks use panel-local rows and route file opens", async () => {
  const { document } = buildDom();
  const opened = [];
  const ctx = loadPanel(document, {
    searchCandidates: () => [{ type: "path", kind: "file", path: "src/lib.rs", title: "lib.rs" }],
    buildSearchSelectionRows: (_actions, targets) => targets,
    openWorkspaceSearchPath: (...args) => opened.push(args),
  });

  await ctx.HerdrSearchPanel.open("ws-1", {});
  ctx.HerdrSearchPanel.panel.chooseSearchResult(0);

  assert.deepEqual(opened, [["src/lib.rs", "file"]], "clicking a panel result opens its file through the shared path flow");
});

test("panel content expansion uses the per-file search endpoint", async () => {
  const { nodes, document } = buildDom();
  const requests = [];
  const helper = {
    settings: () => ({ searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, searchSectionOrder: ["workspaces", "files", "content"], contentMinChars: 3, contextLines: 2 }),
    createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0, contextLines: 2 }),
    resetContentState: () => {},
    workspaceCwd: (workspace) => (workspace && workspace.cwd) || "",
    searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
    searchContent: async () => ({ files: [], total_files: 0, total_matches: 0, truncated: false }),
    searchContentFile: async (args) => {
      requests.push(args);
      return { file: { path: args.file, matches: [], truncated: false } };
    },
  };
  const ctx = loadPanel(document, {
    setTimeout: () => 1,
    HerdrWorkspaceSearch: helper,
  });

  await ctx.HerdrSearchPanel.open("ws-1", {});
  const input = nodes.searchPanelInput;
  input.value = "needle";
  input.__fire("input");
  await ctx.HerdrSearchPanel.content.loadFile(encodeURIComponent("src/app.rs"));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].cwd, "/repo");
  assert.equal(requests[0].file, "src/app.rs");
  assert.equal(requests[0].query, "needle");
  assert.equal(requests[0].contextLines, 2);
  assert.equal(requests[0].matchesPerFile, 500);
});

test("panel repaints while the content search is still running", async () => {
  const { nodes, document } = buildDom();
  let searching = false;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let paintsDuringSearch = 0;
  const ctx = loadPanel(document, {
    renderWorkspaceContentSection: (cb) => {
      if (searching) paintsDuringSearch++;
      return `<section class="search-section" onclick="${cb && cb.panel}.toggleSection('content')"></section>`;
    },
    HerdrWorkspaceSearch: {
      settings: () => ({ searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, searchSectionOrder: ["workspaces", "files", "content"], contentMinChars: 3 }),
      createContentState: () => ({ query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 }),
      resetContentState: () => {},
      workspaceCwd: (w) => (w && w.cwd) || "",
      searchPaths: async () => ({ entries: [], git_status: null, truncated: false }),
      searchContent: async () => {
        searching = true;
        await gate;
        searching = false;
        return { files: [], total_files: 0, total_matches: 0, truncated: false };
      },
    },
  });

  await ctx.HerdrSearchPanel.open("ws-1", {});
  const input = nodes.searchPanelInput;
  input.value = "needle";
  input.__fire("input");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.ok(paintsDuringSearch > 0, "panel repainted mid-search so the searching row shows");
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
});
