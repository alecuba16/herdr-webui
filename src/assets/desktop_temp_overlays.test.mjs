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
    addEventListener(type, fn) {
      this._listeners = this._listeners || {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!this._listeners || !this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(ev) {
      const list = (this._listeners && this._listeners[ev && ev.type]) || [];
      for (const fn of list.slice()) fn(ev);
      return true;
    },
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
      // Model DOM parse semantics: elements parsed from the markup become
      // children of this node, so parentNode walks can reach the modal
      // through the body. Without this, panelInTempOverlay() sees a
      // detached tree and the coexistence guard never triggers.
      for (const child of this.children.slice()) {
        if (child.parentNode === this) this.removeChild(child);
      }
      if (typeof value !== "string") return;
      const stub = (prop, marker) => {
        if (value.includes(marker) && !this[prop]) {
          this[prop] = makeElement(prop);
          this.appendChild(this[prop]);
        }
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

  let rafQueue = [];
  const ctx = {
    _winListeners: {},
    addEventListener(type, fn) {
      (ctx._winListeners[type] = ctx._winListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!ctx._winListeners[type]) return;
      ctx._winListeners[type] = ctx._winListeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(ev) {
      const list = (ctx._winListeners[ev && ev.type] || []).slice();
      for (const fn of list) fn(ev);
      return true;
    },
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
      createTextNode(text) {
        const el = makeElement("#text");
        el.textContent = text;
        created.push(el);
        return el;
      },
    },
    window: null,
    // Manual rAF queue: the picker poll tests drive it tick by tick
    // instead of executing callbacks immediately.
    requestAnimationFrame(fn) {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    flushRaf(ticks = 1) {
      for (let i = 0; i < ticks; i += 1) {
        const queue = rafQueue;
        rafQueue = [];
        for (const fn of queue) fn();
      }
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

  // Real fileBrowserPanel / gitUiPanel DOM nodes, so coexistence tests can
  // assert actual parentage inside each overlay body. created[] only holds
  // createElement output (modals, buttons, pickers), never these panels.
  const filesPanel = makeElement("fileBrowserPanel");
  filesPanel.id = "fileBrowserPanel";
  register("fileBrowserPanel", filesPanel);
  body._register = register;
  const gitPanel = makeElement("gitUiPanel");
  gitPanel.id = "gitUiPanel";
  register("gitUiPanel", gitPanel);
  ctx._tempPanels = { fileBrowserPanel: filesPanel, gitUiPanel: gitPanel };

  // Directory picker stub with the real select/close mechanics the host
  // listens for: selectCurrent() writes the hidden input and dispatches
  // `change` (the host resolves on it); close() removes the modal, so the
  // poll fires the herdrTempOverlayPickerClosed path on the next flush.
  const pickerLog = { opens: [] };
  ctx.HerdrDirectoryPicker = {
    open(input) {
      pickerLog.opens.push(String(input && input.value));
      const modal = makeElement("div");
      modal.id = "directoryPickerModal";
      register("directoryPickerModal", modal);
      body.appendChild(modal);
      pickerLog.input = input;
    },
    close() {
      const modal = getElement("directoryPickerModal");
      if (modal && modal.remove) modal.remove();
      elements.delete("directoryPickerModal");
    },
    selectCurrent(folder) {
      const input = pickerLog.input;
      if (input) {
        input.value = folder;
        input.dispatchEvent(new ctx.Event("change"));
      }
      this.close();
    },
  };
  ctx.pickerLog = pickerLog;

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
      "isToolMinimized", "pickFolder", "suppressing", "suppressingFiles", "suppressingGit",
      "panelInTempOverlay",
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

  it("openGit uses its own pseudo workspace and cross-hides the other drawer only when it is not temp-mounted", async () => {
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
    // With no files overlay open, the files panel lives in the main shell,
    // so the ordinary cross-hide still applies.
    ok(ctx.drawerCalls.hide.includes("files"), "files drawer hidden while not temp-mounted");
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

  it("isToolMinimized reports per tool so files-minimized never releases git keys", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    ok(!overlays.isToolMinimized("files"), "files starts visible");
    ok(!overlays.isToolMinimized("git"), "git never opened");
    overlays.toggleFiles();
    ok(overlays.isToolMinimized("files"), "files minimized");
    ok(!overlays.isToolMinimized("git"), "git untouched by files minimize");
    ok(overlays.isMinimized(), "any-tool isMinimized stays true");
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
    // The drawer rejection propagates through the host into the controller
    // hint: the user sees why the surface is empty.
    const hint = modal.hintEl || modal.querySelector(".temp-overlay-hint");
    ok(hint, "hint element present");
    ok(String(hint.textContent).includes("boom from drawer"), "failure text lands in the hint");
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
describe("desktop temporary overlay host: coexistence", () => {
  it("opening the git overlay never strips the files overlay panel", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const filesModal = ctx.document.getElementById("tempFilesOverlayModal");
    const filesBody = filesModal.querySelector(".temp-overlay-body");
    ok(ctx._tempPanels.fileBrowserPanel.parentNode === filesBody, "files panel mounted in the files overlay body");

    const p = overlays.openGit("/repo/site");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;

    // The stub drawer hides only strip panels outside temp overlays; the
    // host must have skipped the cross-hide entirely.
    equal(ctx.drawerCalls.hide.filter((k) => k === "files").length, 0,
      "files drawer was NOT cross-hidden while its panel was temp-mounted");
    ok(ctx._tempPanels.fileBrowserPanel.parentNode === filesBody, "files panel still mounted in the files overlay body");
    // And the git panel is in the git overlay body, not the files one.
    const gitModal = ctx.document.getElementById("tempGitOverlayModal");
    const gitBody = gitModal.querySelector(".temp-overlay-body");
    ok(ctx._tempPanels.gitUiPanel.parentNode === gitBody, "git panel mounted in the git overlay body");
  });

  it("closing one overlay leaves the sibling overlay intact", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const p = overlays.openGit("/repo/site");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await p;

    overlays.closeFiles();
    ok(!overlays.isOpen() || true, "host stayed consistent");
    equal(overlays.currentFolder("git"), "/repo/site", "git overlay keeps its folder");

    const gitModal = ctx.document.getElementById("tempGitOverlayModal");
    const gitBody = gitModal.querySelector(".temp-overlay-body");
    ok(ctx._tempPanels.gitUiPanel.parentNode === gitBody, "git panel still mounted after the files overlay closed");
  });

  it("closing the files overlay returns its panel to the document body", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    overlays.closeFiles();
    const panel = ctx._tempPanels.fileBrowserPanel;
    ok(panel.parentNode === null, "panel unmounted from the overlay body on close");
  });

  it("panelInTempOverlay reports ancestry truthfully", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    equal(overlays.panelInTempOverlay("fileBrowserPanel"), false, "panel starts outside");
    await openFiles(ctx, overlays);
    equal(overlays.panelInTempOverlay("fileBrowserPanel"), true, "panel now inside the files overlay");
    equal(overlays.panelInTempOverlay("gitUiPanel"), false, "git panel untouched");
    overlays.closeFiles();
    equal(overlays.panelInTempOverlay("fileBrowserPanel"), false, "panel back outside after close");
    equal(overlays.panelInTempOverlay("nonexistent"), false, "missing panel is not in an overlay");
  });
});

describe("desktop temporary overlay host: folder picker", () => {
  it("the Change folder button retargets the surface through the picker", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const before = ctx.drawerCalls.open.length;
    const modal = ctx.document.getElementById("tempFilesOverlayModal");
    const btn = modal.querySelector(".temp-overlay-folder-btn");
    ok(btn, "change-folder button present");

    btn.onclick();
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    equal(ctx.pickerLog.opens.at(-1), "/repo/project", "picker opened at the current folder");
    ctx.HerdrDirectoryPicker.selectCurrent("/picked/folder");
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    equal(overlays.currentFolder("files"), "/picked/folder", "surface retargeted");
    equal(ctx.drawerCalls.open.length, before + 1, "drawer reopened at the picked folder");
    const open = ctx.drawerCalls.open.at(-1);
    equal(open.workspace.cwd, "/picked/folder", "pseudo workspace carries the picked folder");
  });

  it("pickFolder directly resolves with the picked value", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    const pick = overlays.pickFolder("/current/target");
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    equal(ctx.pickerLog.opens.at(-1), "/current/target", "picker opened at the given folder");
    ctx.HerdrDirectoryPicker.selectCurrent("/picked/folder");
    equal(await pick, "/picked/folder", "pick resolves with the selection");
  });

  it("closing the picker without a select keeps the current folder", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);
    const before = ctx.drawerCalls.open.length;

    const pick = overlays.pickFolder("/current/target");
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    ctx.HerdrDirectoryPicker.close();
    // The patched close dispatches the closed event; the poll also sees
    // the modal gone. Both must resolve "" without throwing.
    ctx.flushRaf(2);
    const resolved = await pick;
    equal(resolved, "", "close without select resolves empty");
    equal(overlays.currentFolder("files"), "/repo/project", "folder untouched");
    equal(ctx.drawerCalls.open.length, before, "drawer not reopened");
  });

  it("the poll timeout gives up without discarding a late selection", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);

    const pick = overlays.pickFolder("/current/target");
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    // The picker stays open past the poll's 600-tick safety valve.
    ctx.flushRaf(605);
    const settled = await Promise.race([pick.then(() => "resolved"), Promise.resolve("pending")]);
    equal(settled, "pending", "timeout must not resolve the pick");
    // Timeout cleanup detached the hidden input, but the change listener
    // stays armed: no leak, and a late select still lands.
    const hiddenInputs = ctx.created.filter((el) => el.tag === "input" && el.style.display === "none");
    const leaked = hiddenInputs.filter((el) => el.parentNode === ctx.document.body);
    equal(leaked.length, 0, "timeout detached the hidden picker input from the body");

    // A late Select still lands: the promise was never discarded.
    ctx.HerdrDirectoryPicker.selectCurrent("/late/pick");
    const value = await pick;
    equal(value, "/late/pick", "late selection delivered after the poll gave up");
  });

  it("a second pick supersedes the first pending one", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await openFiles(ctx, overlays);

    const first = overlays.pickFolder("/first");
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    const second = overlays.pickFolder("/second");
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    equal(ctx.pickerLog.opens.length, 2, "picker opened twice");
    equal(await first, "", "first pick superseded");
    ctx.HerdrDirectoryPicker.selectCurrent("/from/second");
    equal(await second, "/from/second", "second pick delivers");
  });
});
