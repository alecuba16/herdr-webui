import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Focused harness for the git_ui shortcuts Esc contract while the panel is
// mounted inside a temporary overlay. The window-capture handler runs before
// the shared overlay escapeTrap, so it arbitrates Escape itself:
// temp-mounted panel -> closeTopmost() (unless a foreign modal is open),
// and it releases the whole keyboard while the git overlay is minimized.

function makeContext() {
  const elements = new Map();
  const docListeners = new Map();

  const doc = {
    body: { appendChild() {}, children: [] },
    activeElement: null,
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener() {},
  };

  const ctx = {
    document: doc,
    Date,
    Object,
    console,
    // Ambient overlays/terminal globals; tests overwrite as needed.
    HerdrTempOverlays: null,
    HerdrTempOverlay: null,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  return vm.createContext(ctx);
}

function loadShortcuts(ctx) {
  vm.runInContext(
    readFileSync(new URL("./shortcuts.js", import.meta.url), "utf8"),
    ctx,
  );
  return ctx.HerdrGitUiShortcuts;
}

function keyEvent(overrides = {}) {
  return {
    key: "Escape",
    target: null,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    code: "Escape",
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._immediateStopped = true; },
    ...overrides,
  };
}

// Minimal git_ui state/view surface the Esc path reads. Escape with no
// menus/modals and an empty navigation stack falls through to the
// temp-mounted branch.
function makeShortcuts(ctx, overrides = {}) {
  const calls = { closeTopmost: 0, confirms: [], hides: 0, foreignVisible: false };
  const state = {
    visible: true,
    shortcutPrefixUntil: 0,
    contextMenu: null,
    logContextMenu: null,
    headerMenu: null,
    branchList: null,
    worktreeList: null,
    branchModal: null,
    gitOpModal: null,
    commitModal: null,
    compareSelectedModal: null,
    resetSelectedModal: null,
    tagSelectedModal: null,
    cleanupConfirm: null,
  };
  const view = { tab: "changes", navigationStack: [], file: null, sideEditor: null };
  const shortcuts = ctx.HerdrGitUiShortcuts.create({
    state,
    render() {},
    active: () => view,
    currentMode: () => "changes",
    gitUiOptions: () => ({}),
    explorationDefaultDirectory: () => "",
    canSearchDiff: () => false,
    canEditCurrentFile: () => false,
    saveDraftFromDom() {},
    hide() { calls.hides += 1; },
    confirmFn(question) {
      calls.confirms.push(question);
      return true;
    },
    alertFn() {},
    getGitUi() {
      throw new Error("getGitUi must not be reached on these Esc paths");
    },
    ...overrides,
  });
  return { shortcuts, state, view, calls };
}

describe("git_ui shortcuts: Escape inside temporary overlays", () => {
  it("closes the topmost overlay when the git panel is temp-mounted", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: (id) => id === "gitUiPanel",
      isToolMinimized: () => false,
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => calls.foreignVisible,
    };

    shortcuts.handleKeydown(keyEvent());
    equal(calls.closeTopmost, 1, "overlay closed through closeTopmost");
    equal(calls.confirms.length, 0, "git's own hide confirm never ran");
    equal(calls.hides, 0, "git's own hide() never ran");
  });

  it("never closes anything while a foreign modal (folder picker) is open", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: (id) => id === "gitUiPanel",
      isToolMinimized: () => false,
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => true,
    };

    const event = keyEvent();
    shortcuts.handleKeydown(event);
    equal(calls.closeTopmost, 0, "picker owns Escape");
    // The foreign modal check now guards the whole handler: git's
    // window-capture handler releases every key while the directory
    // picker (or any other foreign modal) is open, so the picker's own
    // close paths receive them.
    equal(event.defaultPrevented, false, "git did not consume the default action");
    equal(event._stopped, undefined, "git did not stop propagation");
    equal(calls.hides, 0, "git's own hide never ran");
    equal(calls.confirms.length, 0, "no confirm while picker is open");
  });

  it("releases the whole keyboard while the git overlay is minimized", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: (id) => id === "gitUiPanel",
      isToolMinimized: (tool) => tool === "git",
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => false,
    };

    // Any key, not just Escape, must pass through untouched.
    for (const key of ["Escape", "a", "F5"]) {
      const event = keyEvent({ key, code: key });
      shortcuts.handleKeydown(event);
      equal(event.defaultPrevented, false, `${key} not consumed`);
      equal(event._stopped, undefined, `${key} propagation untouched`);
    }
    equal(calls.closeTopmost, 0);
  });

  it("still hides through the confirm when mounted outside overlays", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: () => false,
      isToolMinimized: () => false,
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => false,
    };

    shortcuts.handleKeydown(keyEvent());
    deepEqual(calls.confirms, ["Hide Git UI?"], "legacy confirm path preserved");
    equal(calls.hides, 1, "hide ran after confirm");
    equal(calls.closeTopmost, 0, "overlay trap not involved");
  });

  it("isToolMinimized is consulted per tool: files-minimized does not release git keys", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    let asked = [];
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: (id) => id === "gitUiPanel",
      isToolMinimized: (tool) => { asked.push(tool); return tool === "files"; },
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => false,
    };

    shortcuts.handleKeydown(keyEvent());
    ok(asked.includes("git"), "git tool checked");
    equal(calls.closeTopmost, 1, "files-minimized still lets git own its keys");
  });

  it("terminal visibility releases keys before any git handling", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    ctx.HerdrTempOverlays = {
      panelInTempOverlay: () => true,
      isToolMinimized: () => false,
    };
    ctx.HerdrTempOverlay = {
      closeTopmost() { calls.closeTopmost += 1; },
      isForeignModalVisible: () => false,
    };
    // A visible temp terminal backdrop above the git drawer.
    const backdrop = { style: { display: "grid" } };
    ctx.document.querySelectorAll = (selector) =>
      selector === ".temp-terminal-backdrop" ? [backdrop] : [];

    const event = keyEvent();
    shortcuts.handleKeydown(event);
    equal(event.defaultPrevented, false, "terminal owns the key");
    equal(calls.closeTopmost, 0, "overlay untouched");
  });
});