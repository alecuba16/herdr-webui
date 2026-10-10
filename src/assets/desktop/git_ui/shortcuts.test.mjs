import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Focused harness for the git_ui shortcuts Esc contract. The window-capture
// handler arbitrates Escape itself: modal states close first, the navigation
// stack pops before hiding, and the plain changes list hides through the
// confirm while any other view resets to the changes list.

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
    globalThis: {},
    window: { addEventListener() {} },
    HerdrAppHelpers: {
      escapeHtml: (value) => String(value),
    },
  };
  ctx.globalThis = ctx;
  ctx.window.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadShortcuts(ctx) {
  const source = readFileSync(new URL("./shortcuts.js", import.meta.url), "utf8");
  vm.runInContext(source, ctx);
}

function keyEvent(overrides = {}) {
  return {
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {},
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
// hide-or-reset branch.
function makeShortcuts(ctx, overrides = {}) {
  const calls = { confirms: [], hides: 0, goBack: 0, changesList: 0 };
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
      return {
        goBack() { calls.goBack += 1; },
        showChangesList() { calls.changesList += 1; },
      };
    },
    ...overrides,
  });
  return { shortcuts, state, view, calls };
}

describe("git_ui shortcuts: Escape contract", () => {
  it("hides through the confirm from the plain changes list", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);

    shortcuts.handleKeydown(keyEvent());
    deepEqual(calls.confirms, ["Hide Git UI?"], "legacy confirm path preserved");
    equal(calls.hides, 1, "hide ran after confirm");
  });

  it("pops the navigation stack before hiding", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const view = { tab: "log", navigationStack: [{}], file: null, sideEditor: null };
    const { shortcuts, calls } = makeShortcuts(ctx, { active: () => view });

    shortcuts.handleKeydown(keyEvent());
    equal(calls.goBack, 1, "navigation stack popped first");
    equal(calls.confirms.length, 0, "no hide confirm while the stack is non-empty");
    equal(calls.hides, 0, "hide never ran");
  });

  it("resets a non-changes view to the changes list without confirming", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const view = { tab: "log", navigationStack: [], file: "src/a.rs", sideEditor: null };
    const { shortcuts, calls } = makeShortcuts(ctx, { active: () => view });

    shortcuts.handleKeydown(keyEvent());
    equal(calls.changesList, 1, "showChangesList ran");
    equal(calls.confirms.length, 0, "no hide confirm outside the changes list");
    equal(calls.hides, 0, "hide never ran");
  });

  it("consumes the key and stops propagation while the drawer is visible", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);

    const event = keyEvent();
    shortcuts.handleKeydown(event);
    ok(event._stopped, "git owns the keyboard while visible");
  });

  it("ignores keys while the drawer is hidden", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx, { state: { visible: false } });

    const event = keyEvent();
    shortcuts.handleKeydown(event);
    equal(event._stopped, undefined, "hidden drawer releases keys");
    equal(calls.hides, 0);
  });
});