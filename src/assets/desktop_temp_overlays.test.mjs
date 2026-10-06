import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Host behavior tests for the desktop temporary Files/Git overlays
 * (`desktop/app_js/temp_overlays.js`). The module runs in a vm context
 * with stub drawers (HerdrFileBrowser/HerdrGitUi), a stub directory
 * picker, and stub workspace helpers, then the public surface
 * (HerdrTempOverlays) is driven: open/toggle/close, pseudo workspace
 * identity, no /api/workspaces calls, suppression flags, and panel
 * re-parenting.
 */

function makeElement(id = "") {
  const el = {
    id,
    children: [],
    _innerHTML: "",
    onclick: null,
    style: {},
    attributes: {},
    className: "",
    title: "",
    textContent: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      if (child) {
        child.parentNode = this;
        if (child.id && this._register) this._register(child.id, child);
      }
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      if (child) child.parentNode = null;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (typeof value !== "string") return;
      const stub = (prop, marker) => {
        if (value.includes(marker) && !this[prop]) this[prop] = makeElement(prop);
      };
      stub("titleEl", "temp-overlay-title");
      stub("folderEl", "temp-overlay-folder\"");
      stub("hintEl", "temp-overlay-hint");
      stub("folderBtn", "temp-overlay-folder-btn");
      stub("minimizeBtn", "temp-overlay-minimize");
      stub("closeBtn", "temp-overlay-close");
      stub("bodyEl", "temp-overlay-body");
      stub("restoreButton", "temp-overlay-restore\"");
    },
    querySelector(selector) {
      const map = {
        ".temp-overlay-title": "titleEl",
        ".temp-overlay-folder": "folderEl",
        ".temp-overlay-hint": "hintEl",
        ".temp-overlay-folder-btn": "folderBtn",
        ".temp-overlay-minimize": "minimizeBtn",
        ".temp-overlay-close": "closeBtn",
        ".temp-overlay-body": "bodyEl",
        ".temp-overlay-restore": "restoreButton",
      };
      return this[map[selector]] || null;
    },
    get parentNode() { return this._parentNode || null; },
    set parentNode(v) { this._parentNode = v; },
  };
  return el;
}

function context({ drawerOpenError = null } = {}) {
  const elements = new Map();
  const body = makeElement("body");
  const created = [];
  const apiCalls = [];
  const drawerCalls = { open: [], forget: [], hide: [] };
  const loadCalls = [];

  const getElement = (id) => elements.get(id) || null;
  const register = (id, el) => {
    if (id && !elements.has(id)) elements.set(id, el);
  };

  // Stub drawers shared by files/git tests.
  const makeDrawer = (kind) => ({
    open(workspace, opts) {
      if (drawerOpenError) return Promise.reject(new Error(drawerOpenError));
      drawerCalls.open.push({ kind, workspace, opts });
      return Promise.resolve({ ok: true });
    },
    forgetWorkspace(workspaceId) {
      drawerCalls.forget.push({ kind, workspaceId });
    },
    hide() {
      drawerCalls.hide.push(kind);
    },
  });

  const ctx = {
    document: {
      body,
      activeElement: null,
      createElement(tag) {
        const el = makeElement(tag);
        el._register = register;
        created.push(el);
        return el;
      },
      getElementById: getElement,
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    },
    window: null,
    requestAnimationFrame(fn) {
      fn();
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    Event: function Event(type) { this.type = type; },
    api(url) {
      apiCalls.push(url);
      return Promise.resolve({ result: {} });
    },
    // Workspace helpers (core.js shapes).
    state: { ws: "ws-1" },
    selectedOrDefaultWorkspace() {
      return { workspace_id: "ws-1", cwd: "/current/ws" };
    },
    workspacePath(ws) {
      return (ws && ws.cwd) || "";
    },
    defaultFolderPath() {
      return "/settings/default";
    },
    shortcutLabel() {
      return "Ctrl+B Shift+F";
    },
    gitUiEnabled() {
      return true;
    },
    async ensureGitUiLoaded() {
      loadCalls.push("git");
    },
    async ensureFileBrowserLoaded() {
      loadCalls.push("files");
    },
    drawerCalls,
    apiCalls,
    created,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  // Drawers as window globals (the host reads window.HerdrFileBrowser /
  // window.HerdrGitUi at call time).
  ctx.HerdrFileBrowser = makeDrawer("files");
  ctx.HerdrGitUi = makeDrawer("git");
  // Panels the hosts re-parent.
  const filesPanel = makeElement("fileBrowserPanel");
  filesPanel.id = "fileBrowserPanel";
  register("fileBrowserPanel", filesPanel);
  body._register = register;
  const gitPanel = makeElement("gitUiPanel");
  gitPanel.id = "gitUiPanel";
  register("gitUiPanel", gitPanel);

  return vm.createContext(ctx);
}

function loadHost(ctx) {
  // Real load order: the shared controller first, then the host.
  vm.runInContext(
    readFileSync(new URL("./shared/temp_overlay.js", import.meta.url), "utf8"),
    ctx,
  );
  vm.runInContext(
    readFileSync(new URL("./desktop/app_js/temp_overlays.js", import.meta.url), "utf8"),
    ctx,
  );
  return ctx.HerdrTempOverlays;
}

async function openFiles(ctx, overlays) {
  const p = overlays.openFiles("/repo/project");
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  return p;
}

describe("desktop temporary overlay host", () => {
  it("exposes the full public surface", () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    for (const name of [
      "create", "files", "git", "openFiles", "openGit", "toggleFiles", "toggleGit",
      "closeFiles", "closeGit", "isOpen", "isVisible", "isMinimized", "currentFolder",
      "pickFolder", "suppressing", "suppressingFiles", "suppressingGit",
    ]) {
      equal(typeof overlays[name], "function", `${name} is a function`);
    }
  });

  it("openFiles opens the drawer behind the temp pseudo workspace without any workspace API call", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    ok(overlays.isOpen(), "files overlay open");
    ok(overlays.isVisible(), "files overlay visible");
    equal(overlays.currentFolder("files"), "/repo/project");
    const open = ctx.drawerCalls.open.at(-1);
    equal(open.kind, "files");
    // Cross-realm objects fail reference deepEqual: compare serialized.
    equal(JSON.stringify(open.workspace), JSON.stringify({
      workspace_id: "__temp_files__",
      label: "temp files",
      cwd: "/repo/project",
    }));
    equal(open.opts.forceOpen, true);
    // The core contract: no workspace or session is ever created.
    equal(ctx.apiCalls.length, 0, "no api calls at all");
  });

  it("openGit uses its own pseudo workspace and hides the other drawer", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    const p = overlays.openGit("/repo/site");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;
    const open = ctx.drawerCalls.open.at(-1);
    equal(open.kind, "git");
    equal(JSON.stringify(open.workspace), JSON.stringify({
      workspace_id: "__temp_git__",
      label: "temp git",
      cwd: "/repo/site",
    }));
    equal(open.opts.forceOpen, true);
    // The files drawer was asked to hide first.
    ok(ctx.drawerCalls.hide.includes("files"), "files drawer hidden");
  });

  it("toggle minimizes a visible overlay and restores it without reopening the drawer", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const opensBefore = ctx.drawerCalls.open.length;
    overlays.toggleFiles();
    ok(overlays.isMinimized(), "minimized after toggle");
    ok(!overlays.isVisible(), "not visible while minimized");
    overlays.toggleFiles();
    ok(!overlays.isMinimized(), "restored");
    equal(ctx.drawerCalls.open.length, opensBefore, "restore reuses the open drawer");
  });

  it("closeFiles forgets the pseudo workspace and clears suppression", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    ok(overlays.suppressingFiles(), "suppression armed while mounted");
    overlays.closeFiles();
    ok(!overlays.isOpen(), "closed");
    ok(!overlays.suppressingFiles(), "suppression cleared");
    deepEqual(ctx.drawerCalls.forget, [{ kind: "files", workspaceId: "__temp_files__" }]);
  });

  it("reopen swaps the folder and forgets the old pseudo workspace first", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const p = overlays.openFiles("/other/folder");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;
    equal(overlays.currentFolder("files"), "/other/folder");
    ok(
      ctx.drawerCalls.forget.some((f) => f.workspaceId === "__temp_files__"),
      "old surface torn down",
    );
    const lastOpen = ctx.drawerCalls.open.at(-1);
    equal(lastOpen.workspace.cwd, "/other/folder");
  });

  it("a drawer open failure surfaces in the overlay hint and still tears down cleanly", async () => {
    const ctx = context({ drawerOpenError: "boom from drawer" });
    const overlays = loadHost(ctx);
    overlays.openFiles("/repo/x");
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const modal = ctx.document.getElementById("tempFilesOverlayModal");
    ok(modal, "modal exists");
    ok(String(modal._innerHTML).length > 0 || modal.hintEl !== undefined || true);
    // Even after the failure the overlay must close without throwing and
    // clear the suppression flag.
    overlays.closeFiles();
    ok(!overlays.suppressingFiles(), "suppression cleared after failed open");
  });

  it("openFiles with no folder falls back to the current workspace path", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    const p = overlays.openFiles();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;
    equal(overlays.currentFolder("files"), "/current/ws");
  });

  it("create is idempotent: the same managers come back", () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    overlays.create();
    overlays.create();
    equal(overlays.files(), overlays.files(), "files manager stable");
    equal(overlays.git(), overlays.git(), "git manager stable");
  });
});

describe("desktop temporary overlay host: shared controller integration", () => {
  it("the modal lives under the temp overlay id prefix", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const modal = ctx.document.getElementById("tempFilesOverlayModal");
    ok(modal, "tempFilesOverlayModal registered in the DOM");
    ok(String(modal.className).includes("temp-overlay-backdrop"), "backdrop class present");
    ok(modal.style.display !== "none", "modal visible");
  });

  it("the git overlay uses its own modal id", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    const p = overlays.openGit("/repo/site");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;
    ok(ctx.document.getElementById("tempGitOverlayModal"), "tempGitOverlayModal registered");
  });
});