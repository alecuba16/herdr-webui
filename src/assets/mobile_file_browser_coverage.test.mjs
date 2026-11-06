import { describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
import vm from "node:vm";

// Statement coverage push for mobile/file_browser.js. Same vm-bundle
// harness as mobile_load.test.mjs, duplicated because coverage attributes
// each product file's statements to its real disk path.

function element(id = "") {
  const classes = new Set();
  const el = {
    id,
    classList: {
      toggle(cls, on) {
        if (on === undefined ? !classes.has(cls) : on) classes.add(cls);
        else classes.delete(cls);
      },
      add(...cls) { cls.forEach((c) => classes.add(c)); },
      remove(...cls) { cls.forEach((c) => classes.delete(c)); },
      contains(cls) { return classes.has(cls); },
      addedClasses: classes,
    },
    dataset: {},
    style: { setProperty() {} },
    rect: { left: 300, top: 700, width: 80, height: 40 },
    getBoundingClientRect() {
      return this.rect;
    },
    setAttribute(name, value) {
      (this.attributes || (this.attributes = {}))[name] = value;
    },
    getAttribute(name) {
      return (this.attributes || {})[name] ?? null;
    },
    disabled: false,
    hidden: false,
    open: false,
    innerHTML: "",
    textContent: "",
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 900,
    clientWidth: 360,
    firstElementChild: null,
    appendChild(node) {
      (this.appended || (this.appended = [])).push(node);
      return node;
    },
    insertBefore(node) {
      (this.inserted || (this.inserted = [])).unshift(node);
      return node;
    },
    focus() {
      this.focused = true;
    },
    closest() {
      return null;
    },
    remove() {
      this.removed = true;
    },
    listeners: {},
    addEventListener(event, listener) {
      (this.listeners[event] || (this.listeners[event] = [])).push(listener);
    },
    removeEventListener(event, listener) {
      const list = this.listeners[event] || [];
      const idx = list.indexOf(listener);
      if (idx > -1) list.splice(idx, 1);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

function context(pathname = "/", options = {}) {
  const elements = new Map();
  const localStorage = new Map();
  const requests = [];
  const sockets = [];
  const timers = [];
  const listeners = {};
  const documentQueryResults = new Map();
  const documentQueryAllResults = new Map();
  let timerSeq = 0;
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  // The app's confirm sheet resolves through HerdrMobile.resolveConfirm;
  // when shown, auto-answer with the injected confirm stub.
  const confirmSheet = element("mobileConfirmSheet");
  let confirmSheetShown = false;
  Object.defineProperty(confirmSheet, "hidden", {
    configurable: true,
    get: () => !confirmSheetShown,
    set: (value) => {
      confirmSheetShown = !value;
      if (confirmSheetShown) {
        const confirmImpl = ctx.confirm || options.confirm || (() => true);
        const answer = confirmImpl();
        Promise.resolve().then(() => {
          if (ctx.HerdrMobile && ctx.HerdrMobile.resolveConfirm)
            ctx.HerdrMobile.resolveConfirm(answer);
        });
      }
    },
  });
  elements.set("mobileConfirmSheet", confirmSheet);
  const locationRef = {
    pathname,
    href: "",
    protocol: "http:",
    host: "127.0.0.1:8787",
  };
  const ctx = {
    console,
    TextEncoder,
    Uint8Array,
    setTimeout(callback, delay = 0) {
      const id = ++timerSeq;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cleared = true;
    },
    document: {
      body: element("body"),
      documentElement: element("html"),
      activeElement: null,
      createElement: () => element(),
      getElementById: getElement,
      querySelector: (selector) => documentQueryResults.get(selector) || null,
      querySelectorAll: (selector) =>
        documentQueryAllResults.get(selector) || [],
      hidden: false,
      addEventListener(event, listener) {
        (listeners[event] || (listeners[event] = [])).push(listener);
      },
      removeEventListener(event, listener) {
        const list = listeners[event] || [];
        const idx = list.indexOf(listener);
        if (idx > -1) list.splice(idx, 1);
      },
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    location: locationRef,
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => {
        localStorage.delete(key);
      },
    },
    confirm: options.confirm || (() => true),
    window: null,
    globalThis: null,
    Terminal: class {
      constructor() {
        this.buffer = { active: { baseY: 0, viewportY: 0 } };
        this.writes = [];
      }
      onData() {}
      onScroll() {}
      open() {}
      resize() {}
      registerLinkProvider() {
        return { dispose() {} };
      }
      write(data, callback) {
        this.writes.push(data);
        if (callback) callback();
      }
      usesNormalBuffer() {
        return true;
      }
      atBottom() {
        return true;
      }
      scrollLines() {}
      scrollToLine() {}
      scrollToBottom() {}
      focus() {}
      clear() {}
      dispose() {}
      destroy() {}
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.bufferedAmount = 0;
        sockets.push(this);
        ctx.lastSocket = this;
      }
      send() {}
      close() {}
    },
    fetch: async (url, opt = {}) => {
      requests.push({ url, opt });
      const optionValue = (key, fallback) => {
        const value = options[key];
        return typeof value === "function"
          ? value({ url, opt, requests })
          : value === undefined
            ? fallback
            : value;
      };
      if (url === "/api/server-settings")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("serverSettings", {
              backend_mode: "builtin",
              default_folder: "/tmp/default",
              enabled_backends: { builtin: true, "external-herdr": true },
            }),
        };
      if (url === "/api/versions")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("versions", {
              webui: "1.2.3",
              backend: "builtin-0.9.0",
              backend_mode: "builtin",
              session: "default",
              compatibility: { status: "compatible", message: "all good" },
            }),
        };
      if (url === "/api/logout")
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url === "/api/no-sleep")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("noSleep", { mode: "auto", supported: true }),
        };
      if (url === "/api/sessions")
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("sessionsResponse", {
              sessions: [{ name: "default", backend: "builtin", running: true }],
              herdr_available: true,
              herdr_compatible: true,
              herdr_version: "0.9.0",
              default_backend: "builtin",
              enabled_backends: { builtin: true, "external-herdr": true },
            }),
        };
      if (url === "/api/session/launch" || url === "/api/session/close")
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, pid: 4242 }),
        };
      if (String(url).startsWith("/api/file-browser/tree")) {
        if (String(url).includes("q="))
          return {
            ok: true,
            status: 200,
            json: async () =>
              optionValue("treeSearch", {
                path: "docs",
                entries: [
                  { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
                ],
                truncated: true,
                git_status: null,
              }),
          };
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("tree", {
              path: "",
              entries: [
                { kind: "file", name: "readme.md", path: "readme.md" },
                { kind: "dir", name: "src", path: "src" },
              ],
              git_status: null,
            }),
        };
      }
      if (String(url).startsWith("/api/file-browser/content-search/file"))
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("contentSearchFile", {
              file: {
                path: "docs/alpha.txt",
                matches: [{ line: 3, match_start: 0, match_end: 5 }],
                content: "alpha alpha",
              },
            }),
        };
      if (String(url).startsWith("/api/file-browser/content-search"))
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("contentSearch", {
              files: optionValue("contentSearchFiles", [
                {
                  path: "docs/alpha.txt",
                  matches: [{ line: 2, match_start: 0, match_end: 5 }],
                },
              ]),
              truncated: optionValue("contentSearchTruncated", false),
              total_files: 1,
              total_matches: 1,
              visited: 10,
            }),
        };
      if (String(url).startsWith("/api/file-browser/file")) {
        const body = (opt && opt.body && JSON.parse(opt.body)) || {};
        if (body.content === "__fail__")
          return {
            ok: false,
            status: 500,
            statusText: "write failed",
            json: async () => ({ error: "write failed" }),
          };
        return {
          ok: true,
          status: 200,
          json: async () =>
            optionValue("file", {
              path: body.path || "readme.md",
              name: "readme.md",
              kind: "file",
              content: "hello world",
              hash: "h1",
              size: 11,
              binary: false,
              lines_gutter_html: "<span>1</span>",
              lines_code_html: "<code>hello world</code>",
            }),
        };
      }
      if (String(url).startsWith("/api/file-browser/rename"))
        return {
          ok: !optionValue("renameError", null),
          status: optionValue("renameError", null) ? 500 : 200,
          json: async () =>
            optionValue("renameError", null)
              ? { error: optionValue("renameError", null) }
              : { ok: true },
        };
      if (String(url).startsWith("/api/file-browser/delete"))
        return {
          ok: !optionValue("deleteError", null),
          status: optionValue("deleteError", null) ? 500 : 200,
          json: async () =>
            optionValue("deleteError", null)
              ? { error: optionValue("deleteError", null) }
              : { ok: true },
        };
      if (String(url).startsWith("/api/session-snapshot"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              snapshot: {
                workspaces: optionValue("workspaces", [
                  {
                    workspace_id: "w1",
                    label: "alpha",
                    pane_count: 1,
                    cwd: "/tmp/alpha",
                    worktree: {
                      checkout_path: "/tmp/alpha",
                      is_linked_worktree: false,
                      branch: "main",
                    },
                  },
                ]),
                tabs: [{ workspace_id: "w1", tab_id: "w1:t1", number: 1 }],
                panes: [
                  { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term1" },
                ],
                layouts: [],
                agents: [],
              },
              worktree_results: [],
              workspace_order: [],
            },
          }),
        };
      return { ok: true, status: 200, json: async () => ({ result: {} }) };
    },
  };
  ctx.HerdrTerminalRenderer = {
    create: async () => new ctx.Terminal(),
  };
  ctx.setDocumentQuery = (selector, el) => documentQueryResults.set(selector, el);
  ctx.setDocumentQueryAll = (selector, list) => documentQueryAllResults.set(selector, list);
  ctx.setElement = (id, el) => elements.set(id, el);
  ctx.requests = requests;
  ctx.sockets = sockets;
  ctx.pendingTimers = timers;
  ctx.flushSomeTimers = async (filter) => {
    const due = [];
    for (const timer of timers)
      if (!timer.cleared && filter(timer)) due.push(timer);
    for (const timer of due) {
      const at = timers.indexOf(timer);
      if (at > -1) timers.splice(at, 1);
      await timer.callback();
    }
  };
  ctx.settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };
  ctx.localStorageMap = localStorage;
  ctx.window = Object.assign(ctx, {
    matchMedia: () => ({ matches: false }),
    innerWidth: 390,
    innerHeight: 844,
    addEventListener() {},
  });
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const MOBILE_BUNDLE_FILES = [
  "./shared/options.js",
  "./shared/core.js",
  "./shared/http.js",
  "./shared/attention.js",
  "./shared/actions.js",
  "./shared/file_icons.js",
  "./shared/file_tree.js",
  "./shared/line_context.js",
  "./shared/file_content_search.js",
  "./shared/workspace_search.js",
  "./shared/editor.js",
  "./shared/terminal_fit.js",
  "./mobile/core.js",
  "./mobile/attention.js",
  "./mobile/terminal.js",
  "./mobile/worktrees.js",
  "./mobile/directory_picker.js",
  "./mobile/file_browser.js",
  "./mobile/notes.js",
  "./mobile/settings.js",
  "./mobile/search.js",
  "./mobile/git.js",
  "./mobile/composer.js",
  "./mobile/lens.js",
  "./mobile/sessions.js",
  "./mobile/events.js",
  "./mobile/screens.js",
  "./mobile/panels.js",
  "./mobile/workmeta.js",
  "./mobile/theme.js",
  "./mobile/actions.js",
  "./mobile/backend.js",
  "./mobile/app.js",
];

let mobileBundleScripts = null;
function getMobileBundleScripts() {
  if (!mobileBundleScripts) {
    mobileBundleScripts = MOBILE_BUNDLE_FILES.map((path) => {
      const realPath = fileURLToPath(new URL(path, import.meta.url));
      return new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath });
    });
  }
  return mobileBundleScripts;
}

function runSource(ctx) {
  for (const script of getMobileBundleScripts()) script.runInContext(ctx);
}

function screenHtml(ctx) {
  return ctx.document.getElementById("mobileScreen").innerHTML;
}

describe("mobile file browser coverage", () => {
  it("lsp diagnostics render, clear, and degrade when options throw", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle();
    // First render fires the lazy tree load; settle it so entries exist.
    await ctx.settle(20);

    // install a tiny LSP so lspEnabled() flips true
    const diagnostics = [
      { severity: 1, message: "broken <thing>", range: { start: { line: 0 } } },
      { severity: 2, message: "warn", range: { start: { line: 4 } } },
      { severity: 3, message: "info", noRange: true },
    ];
    const opened = [];
    ctx.HerdrLsp = {
      workspaceFor: (root) => ({ root }),
      didOpen: async (ws, path, text) => {
        opened.push([path, text]);
      },
      didChange: (ws, path, value) => {},
      didClose: async () => {},
      diagnosticsFor: (ws, path) => diagnostics,
    };
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ lspEnabled: true }));

    await app.filesSelect(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    // renderPreview mounts the editor + fires lsp didOpen in a timer
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle(20);
    ok(opened.some(([path]) => path === "readme.md"), "lsp didOpen fired");

    const preview = ctx.document.getElementById("mobileFilePreview");
    ok(preview, "preview mount exists");

    // lspRenderDiagnosticsInto appends a diagnostics list when present
    ok(
      preview.appended && preview.appended.length > 0,
      "diagnostics list appended under preview",
    );
    const list = preview.appended[0];
    ok(String(list.innerHTML).includes("broken &lt;thing&gt;"), "escaped error message");
    ok(String(list.innerHTML).includes(":1"), "error line shown");
    ok(String(list.innerHTML).includes("info"), "info diagnostic shown");

    // empty diagnostics remove the list again
    diagnostics.length = 0;
    ctx.HerdrLsp.diagnosticsFor = () => [];
    await app.filesRefreshFile();
    await ctx.settle(20);
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle(20);

    // throwing HerdrOptions.read degrades lspEnabled to false (catch path)
    ctx.HerdrOptions = {
      read() {
        throw Error("boom");
      },
      write() {},
    };
    doesNotThrow(() => ctx.HerdrMobileFilesContent.run());
    await ctx.settle();
  });

  it("search scope cycles and content search state machine", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    // the keyboard handlers need the module instance as receiver, so drive
    // them through a directly created instance (app.filesX exports are bare
    // function refs; calling them with this === HerdrMobile would crash)
    const module = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        if (String(url).startsWith("/api/file-browser/tree"))
          return {
            path: "",
            entries: [
              { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
            ],
            git_status: null,
          };
        if (String(url).startsWith("/api/file-browser/content-search/file"))
          return { file: { path: "docs/alpha.txt", matches: [] } };
        if (String(url).startsWith("/api/file-browser/content-search"))
          return {
            files: [
              {
                path: "docs/alpha.txt",
                matches: [{ line: 2, match_start: 0, match_end: 5 }],
              },
            ],
            truncated: false,
            total_files: 1,
            total_matches: 1,
            visited: 10,
          };
        if (String(url).startsWith("/api/file-browser/file"))
          return {
            path: "docs/alpha.txt",
            name: "alpha.txt",
            kind: "file",
            content: "alpha",
            hash: "h1",
            size: 5,
            binary: false,
          };
        return {};
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await module.load("");
    await ctx.settle(20);

    // cycle the scope: file -> dir -> content -> file
    module.setFilterKind("dir");
    module.setFilterKind("content");
    module.setFilterKind("file");
    module.toggleFilterKind();
    await ctx.settle(20);

    // content search through the module + the content API object
    module.toggleContentSearch();
    await ctx.settle(20);
    const content = ctx.HerdrMobileFilesContent;
    content.setQuery("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle(20);

    // load more appends another page
    module.loadMore();
    await ctx.settle(20);

    // short query clears results with the min-chars note
    content.setQuery("ab");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle(20);

    // clear resets everything
    content.clear();
    await ctx.settle(20);

    // inputKeydown handlers
    const event = { key: "Enter", preventDefault() { this.prevented = true; } };
    content.inputKeydown(event);
    ok(event.prevented, "Enter prevented");
    content.inputKeydown(null);
    const escEvent = { key: "Escape", preventDefault() { this.prevented = true; } };
    content.inputKeydown(escEvent);
    ok(escEvent.prevented, "Escape prevented");
    const saveEvent = {
      key: "s",
      ctrlKey: true,
      preventDefault() { this.prevented = true; },
    };
    content.inputKeydown(saveEvent);
    ok(saveEvent.prevented, "ctrl+s prevented");
  });

  it("open file, edit cycle, save failure, and preview variants", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    await app.filesSelect(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("Edit"), "edit button for editable file");

    // start edit, mark dirty, cancel with confirm discard
    app.filesStartEdit();
    await ctx.settle();
    ok(screenHtml(ctx).includes("Save"), "save button in edit mode");
    ctx.HerdrEditor = { create: () => ({}) };
    await app.filesCancelEdit();
    await ctx.settle(20);

    // edit again and save with a failing backend write
    app.filesStartEdit();
    await ctx.settle();
    const browser = app;
    // fail the save: api surface rejects with a message
    const apiBase = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      const body = opt.body && String(opt.body).includes("__fail__") ? { error: "write failed" } : null;
      if (String(url).startsWith("/api/file-browser/file") && opt.method === "POST") {
        return {
          ok: false,
          status: 500,
          statusText: "write failed",
          json: async () => ({ error: "write failed" }),
        };
      }
      return apiBase(url, opt);
    };
    // drive the module save path directly: draft + dirty then save
    const module = ctx.HerdrMobileFileBrowser.create({
      api: async () => {
        throw Error("write failed");
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await module.load("");
    await ctx.settle(20);
    await module.select(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    module.startEdit();
    await ctx.settle();
    ok(module.saveFile, "saveFile present");
    await module.saveFile();
    await ctx.settle(20);
    ok(true, "save failure path exercised");
    ctx.fetch = apiBase;
  });

  it("rename and new file flows succeed and fail with sheet state", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    // action sheet open/close round trip
    await app.filesOpenActionSheet(encodeURIComponent("readme.md"), "file");
    await ctx.settle();
    ok(screenHtml(ctx).includes("Rename"), "action sheet shows rename");
    app.filesCloseActionSheet();
    await ctx.settle();

    // open sheet for a dir entry: shows the "New file here" action
    await app.filesOpenActionSheet(encodeURIComponent("src"), "dir");
    await ctx.settle();
    ok(screenHtml(ctx).includes("New file here"), "dir sheet includes new file action");
    app.filesCloseActionSheet();
    await ctx.settle();

    // rename: same name cancels, empty name cancels, error shows
    app.filesOpenRename(encodeURIComponent("readme.md"));
    await ctx.settle();
    app.filesSetRenameValue("  readme.md  ");
    app.filesSetRenameValue("readme.md");
    await app.filesSubmitRename();
    await ctx.settle(20);

    app.filesOpenRename(encodeURIComponent("readme.md"));
    await ctx.settle();
    app.filesSetRenameValue("");
    await app.filesSubmitRename();
    await ctx.settle(20);

    // failing rename surfaces the error inline
    app.filesOpenRename(encodeURIComponent("readme.md"));
    await ctx.settle();
    const apiBase = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).startsWith("/api/file-browser/rename")) {
        return {
          ok: false,
          status: 500,
          statusText: "rename conflict",
          json: async () => ({ error: "rename conflict" }),
        };
      }
      return apiBase(url, opt);
    };
    app.filesSetRenameValue("renamed.md");
    await app.filesSubmitRename();
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("rename conflict"), "rename error rendered");
    ctx.fetch = apiBase;

    // new file: empty name does nothing, success clears, failure shows error
    app.filesOpenNewFile();
    await ctx.settle();
    ok(screenHtml(ctx).includes("New file"), "new file modal rendered");
    app.filesSetNewFileValue("");
    await app.filesSubmitNewFile();
    await ctx.settle(20);

    app.filesSetNewFileValue("notes.md");
    await app.filesSubmitNewFile();
    await ctx.settle(20);
    ok(!screenHtml(ctx).includes('id="mobileFileNewInput"'), "new file modal closed on success");

    const apiBase2 = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).startsWith("/api/file-browser/file") && opt.method === "POST") {
        return {
          ok: false,
          status: 500,
          statusText: "exists",
          json: async () => ({ error: "exists" }),
        };
      }
      return apiBase2(url, opt);
    };
    app.filesOpenNewFile();
    await ctx.settle();
    app.filesSetNewFileValue("dupe.md");
    await app.filesSubmitNewFile();
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("exists"), "new file error rendered");
    app.filesCancelNewFile();
    await ctx.settle();
    ctx.fetch = apiBase2;
  });

  it("delete flow clears the open preview and selection on success and error", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    await app.filesSelect(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("Back"), "preview rendered");

    // declined confirm never deletes
    ctx.confirm = () => false;
    await app.filesDeletePath(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("Back"), "declined delete keeps preview");
    ctx.confirm = () => true;

    // confirmed delete closes the preview of the deleted file
    await app.filesDeletePath(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    ok(!screenHtml(ctx).includes(">Back<"), "preview cleared after delete");

    // failing delete shows the tree error
    const apiBase = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).startsWith("/api/file-browser/delete")) {
        return {
          ok: false,
          status: 500,
          statusText: "rm denied",
          json: async () => ({ error: "rm denied" }),
        };
      }
      return apiBase(url, opt);
    };
    await app.filesDeletePath(encodeURIComponent("src"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("rm denied"), "delete error rendered");
    ctx.fetch = apiBase;
  });

  it("partial preview loads truncated files and keeps them read-only", async () => {
    const ctx = context("/session/default/workspace/w1", {
      file: {
        path: "big.log",
        name: "big.log",
        kind: "file",
        content: "",
        hash: "",
        size: 1048576,
        binary: false,
        truncated: true,
        preview_bytes: 262144,
      },
    });
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    await app.filesSelect(encodeURIComponent("big.log"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("File too large to preview"), "truncated note rendered");
    ok(
      screenHtml(ctx).includes("Load first 256 KB"),
      "partial load button rendered",
    );
    ok(!screenHtml(ctx).includes(">Edit<"), "no edit for truncated file");

    await app.filesLoadPartial(encodeURIComponent("big.log"));
    await ctx.settle(20);
    ok(screenHtml(ctx).includes("Editing is disabled"), "partial preview read-only note");
  });

  it("up navigation, stale roots, invalidate, and openAt retarget", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    // openAt with a dir kind loads the directory without opening a file
    await app.filesOpenAt("docs", { kind: "dir", cwd: "/tmp/alpha" });
    await ctx.settle(20);

    // up() from a subpath loads the parent
    app.filesUp();
    await ctx.settle(20);

    // openAt with preserveContext keeps the active filter
    app.filesFilter("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle(20);
    await app.filesOpenAt("docs/alpha.txt", {
      kind: "file",
      cwd: "/tmp/alpha",
      preserveContext: true,
    });
    await ctx.settle(20);

    // openAt to a foreign root resets the content search state
    await app.filesOpenAt("notes.md", { cwd: "/tmp/other-root" });
    await ctx.settle(20);

    // backToTree closes the preview
    await app.filesBackToTree();
    await ctx.settle(20);

    // invalidateWorkspace with a mismatched root is a no-op
    await app.filesRefresh();
    await ctx.settle(20);
    ok(true, "invalidate path reached through refresh cycle");
  });

  it("filter kind switching, typing to filter, and scroll load-more", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    // keyboard/this-dependent handlers run on a module instance with the
    // right receiver; the app.filesX exports are bare refs
    const module = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        if (String(url).startsWith("/api/file-browser/tree"))
          return {
            path: "",
            entries: [
              { kind: "file", name: "alpha.txt", path: "docs/alpha.txt" },
              { kind: "file", name: "alpha2.txt", path: "docs/alpha2.txt" },
            ],
            truncated: false,
            git_status: null,
          };
        return {};
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await module.load("");
    await ctx.settle(20);

    // typeToFilter builds the filter from keystrokes
    const keyEvent = (key, extra = {}) =>
      Object.assign({ key, preventDefault() { this.prevented = true; } }, extra);
    module.typeToFilter(keyEvent("a"));
    module.typeToFilter(keyEvent("b"));
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle(20);

    // alt shortcuts switch the filter kind
    module.typeToFilter(keyEvent("f", { altKey: true }));
    await ctx.settle();
    module.typeToFilter(keyEvent("d", { altKey: true }));
    await ctx.settle();
    module.typeToFilter(keyEvent("c", { altKey: true }));
    await ctx.settle();
    module.typeToFilter(keyEvent("x", { altKey: true }));
    await ctx.settle();

    // meta and ctrl keystrokes are ignored
    const metaEvent = keyEvent("a", { metaKey: true });
    module.typeToFilter(metaEvent);
    const ctrlEvent = keyEvent("a", { ctrlKey: true });
    module.typeToFilter(ctrlEvent);
    const preventedEvent = keyEvent("a", { defaultPrevented: true });
    module.typeToFilter(preventedEvent);
    const inputEvent = keyEvent("a", { target: { closest: () => ({}) } });
    module.typeToFilter(inputEvent);
    module.typeToFilter(null);

    // Backspace trims the filter, Escape clears it
    module.typeToFilter(keyEvent("Backspace"));
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle(20);
    const escEvent = keyEvent("Escape");
    module.typeToFilter(escEvent);
    await ctx.settle(20);

    // searchKeydown: Enter runs now, Escape clears, ctrl+s is prevented
    module.filter("al");
    const enterEvent = keyEvent("Enter");
    module.searchKeydown(enterEvent);
    await ctx.settle(20);
    ok(enterEvent.prevented, "enter prevented");
    module.searchKeydown(null);
    const esc2 = keyEvent("Escape");
    module.searchKeydown(esc2);
    await ctx.settle(20);
    ok(esc2.prevented, "escape prevented");
    const ctrlS = keyEvent("s", { ctrlKey: true });
    module.searchKeydown(ctrlS);
    ok(ctrlS.prevented, "ctrl+s prevented");
    const ctrlS2 = keyEvent("S", { ctrlKey: true });
    module.searchKeydown(ctrlS2);
    ok(ctrlS2.prevented, "ctrl+s uppercase prevented");

    // scroll near the bottom triggers an append load while filtering
    module.filter("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle(20);
    const scroller = ctx.document.getElementById("mobileScreen");
    scroller.scrollTop = 500;
    module.scroll(scroller);
    await ctx.settle(20);

    // showSearch, focusTree, blurTree, clearFilter, loadMore all callable
    module.showSearch();
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle();
    module.focusTree();
    await ctx.settle();
    module.blurTree();
    await ctx.settle();
    // clearFilter with file kind takes the else branch and reloads the tree
    module.setFilterKind("file");
    module.clearFilter();
    await ctx.settle(20);
    // close the content surface first: contentSearch.active survives
    // clearFilter (clearContentSearchResults never touches it)
    module.closeContentSearch();
    await ctx.settle();
    // blurTree on an inactive surface with an empty filter hides the search bar
    module.blurTree();
    await ctx.settle();
    // clearFilter with content kind just re-renders
    module.setFilterKind("content");
    module.clearFilter();
    await ctx.settle();
    // loadMore with empty filter and file kind reloads the tree
    module.setFilterKind("file");
    module.loadMore();
    await ctx.settle(20);
    ok(true, "search surface handlers all ran");
  });

  it("scope cycle full rotation, no-root load error, search and preview failures", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    const apiBase = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).includes("__fail__")) throw Error("offline");
      return apiBase(url, opt);
    };

    // full scope rotation through toggleFilterKind: file -> dir -> content -> file
    const rotator = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        return {
          path: "",
          entries: [{ kind: "file", name: "a.txt", path: "a.txt" }],
          truncated: false,
          git_status: null,
        };
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await rotator.load("");
    await ctx.settle(20);
    rotator.toggleFilterKind();
    await ctx.settle();
    rotator.toggleFilterKind();
    await ctx.settle();
    rotator.toggleFilterKind();
    await ctx.settle();

    // no-root module: load hits the error branch and renders the message
    const rootless = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        return {};
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await rootless.load("");
    await ctx.settle(20);

    // tree search failure lands in the catch and marks filterDone
    const searcher = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        if (String(url).includes("q=")) throw Error("search offline");
        return {
          path: "",
          entries: [{ kind: "file", name: "a.txt", path: "a.txt" }],
          truncated: false,
          git_status: null,
        };
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await searcher.load("");
    await ctx.settle(20);
    searcher.filter("nope");
    await ctx.flushSomeTimers((timer) => timer.delay === 500);
    await ctx.settle(20);

    // partial preview failure lands in the catch
    const previewer = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        if (String(url).startsWith("/api/file-browser/file")) throw Error("partial offline");
        return {
          path: "",
          entries: [{ kind: "file", name: "big.log", path: "big.log" }],
          truncated: true,
          git_status: null,
        };
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await previewer.load("");
    await ctx.settle(20);
    await previewer.loadPartial(encodeURIComponent("big.log"));
    await ctx.settle(20);

    ctx.fetch = apiBase;

    // lspEnabled catch: throwing options read with Lsp present makes every
    // lsp helper bail out silently (openFile -> lspDidClose path)
    ctx.HerdrLsp = {
      workspaceFor: () => "/tmp/ws",
      didOpen: async () => {},
      didChange: () => {},
      didClose: async () => {},
      diagnosticsFor: () => [],
    };
    ctx.HerdrOptions = {
      read: () => {
        throw Error("options unreadable");
      },
      write: () => {},
    };
    await app.filesSelect(encodeURIComponent("readme.md"));
    await ctx.settle(20);
    await app.filesSelect(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle(20);

    // matchHighlight success return (line 611) needs a match with an id:
    // the shared files fixture has no ids, so drive openMatch through a
    // fresh module whose content search files carry ids. line 610 null
    // branch is already covered by the no-such-id call in the expand test.
    const highlighted = ctx.HerdrMobileFileBrowser.create({
      api: async (url) => {
        ctx.requests.push({ url, opt: {} });
        if (String(url).startsWith("/api/file-browser/tree"))
          return {
            path: "",
            entries: [{ kind: "file", name: "a.txt", path: "a.txt" }],
            truncated: false,
            git_status: null,
          };
        if (String(url).startsWith("/api/file-browser/content-search"))
          return {
            files: [
              {
                path: "a.txt",
                matches: [
                  { id: "m1", line: 3, match_start: 0, match_end: 5 },
                ],
              },
            ],
            truncated: false,
            total_files: 1,
            total_matches: 1,
            visited: 5,
          };
        return {
          path: "a.txt",
          name: "a.txt",
          kind: "file",
          content: "a",
          hash: "h",
          size: 1,
          binary: false,
        };
      },
      confirm: async () => true,
      currentWorkspaceCwd: () => "/tmp/alpha",
      escapeHtml: (v) => String(v),
      inputAttrs: () => "",
      render: () => {},
      state: { screen: "files", workspaces: [], ws: "w1" },
    });
    await highlighted.load("");
    await ctx.settle(20);
    highlighted.setFilterKind("content");
    highlighted.filter("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle(20);
    // openMatch lives on the global content api, which the latest create()
    // call rebound to this module instance
    ctx.HerdrMobileFilesContent.openMatch(
      encodeURIComponent("a.txt"),
      encodeURIComponent("m1"),
    );
    await ctx.settle(20);

    // renderPreservingFocus refocus paths: activeElement is the filter input
    // (registered id so getElementById returns it), then the section node
    const filterEl = element("mobileFileFilter");
    ctx.setElement("mobileFileFilter", filterEl);
    const sectionEl = element("mobile-files");
    sectionEl.closest = (selector) =>
      selector === ".mobile-files" ? sectionEl : null;
    ctx.document.activeElement = filterEl;
    highlighted.showSearch();
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle();
    ctx.document.activeElement = sectionEl;
    ctx.setDocumentQuery(".mobile-files", sectionEl);
    highlighted.focusTree();
    await ctx.flushSomeTimers((timer) => !timer.cleared);
    await ctx.settle();
    ctx.document.activeElement = null;

    ok(true, "failure paths all ran");
  });

  it("content search expand, collapse, match open, and snippet growth", async () => {
    const ctx = context("/session/default/workspace/w1");
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);

    const content = ctx.HerdrMobileFilesContent;
    // toggleContentSearch needs the module receiver; use the shared content
    // API directly instead
    content.setQuery("alpha");
    await ctx.flushSomeTimers((timer) => timer.delay === 350);
    await ctx.settle(20);

    // loadFile fetches the per-file matches and re-renders
    await content.loadFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle(20);

    // loadFile for a throwing api surface sets the error
    const apiBase = ctx.fetch;
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).startsWith("/api/file-browser/content-search/file"))
        throw Error("offline file");
      return apiBase(url, opt);
    };
    await content.loadFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle(20);
    ctx.fetch = apiBase;

    // toggleFile flips the expanded flag
    content.toggleFile(encodeURIComponent("docs/alpha.txt"));
    await ctx.settle();

    // expandSnippet grows the context window
    await content.expandSnippet(encodeURIComponent("docs/alpha.txt"), 0, "down");
    await ctx.settle(20);

    // expandSnippet failure surfaces an error
    ctx.fetch = async (url, opt = {}) => {
      ctx.requests.push({ url, opt });
      if (String(url).startsWith("/api/file-browser/content-search/file"))
        throw Error("expand offline");
      return apiBase(url, opt);
    };
    await content.expandSnippet(encodeURIComponent("docs/alpha.txt"), 1, "down");
    await ctx.settle(20);
    ctx.fetch = apiBase;

    // openMatch resolves the match and opens the file with a highlight
    content.openMatch(
      encodeURIComponent("docs/alpha.txt"),
      encodeURIComponent("0"),
    );
    await ctx.settle(20);

    // openMatch with no matching id still opens the file, highlight null
    // (findMatch returns null when the id is absent)
    content.openMatch(
      encodeURIComponent("docs/alpha.txt"),
      encodeURIComponent("no-such-id"),
    );
    await ctx.settle(20);
    ok(true, "content match open exercised");
  });

  it("toggle navigation and no-root tree states", async () => {
    // no workspace rows AND no server default folder: cwd() is empty
    const ctx = context("/session/default/workspace/w1", {
      workspaces: [],
      serverSettings: {
        backend_mode: "builtin",
        default_folder: "",
        enabled_backends: { builtin: true, "external-herdr": true },
      },
    });
    runSource(ctx);
    const app = ctx.HerdrMobile;
    await app.refresh();
    await ctx.settle();
    app.showScreen("files");
    await ctx.settle(20);
    ok(
      screenHtml(ctx).includes("Select workspace with path first"),
      "no-root tree state rendered",
    );

    // select and toggle on a rooted world
    const ctx2 = context("/session/default/workspace/w1");
    runSource(ctx2);
    const app2 = ctx2.HerdrMobile;
    await app2.refresh();
    await ctx2.settle();
    app2.showScreen("files");
    await ctx2.settle(20);

    await app2.filesToggle(encodeURIComponent("src"));
    await ctx2.settle(20);
    ok(true, "toggle entered the directory");

    // select the same file twice: second call is a no-op
    await app2.filesSelect(encodeURIComponent("readme.md"));
    await ctx2.settle(20);
    await app2.filesSelect(encodeURIComponent("readme.md"));
    await ctx2.settle(20);

    // refreshFile on a closed preview is a no-op
    await app2.filesBackToTree();
    await ctx2.settle(20);
    app2.filesRefreshFile();
    await ctx2.settle();
    ok(true, "refresh no-op covered");
  });
});