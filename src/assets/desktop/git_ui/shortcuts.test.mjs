import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Compiled once so coverage attributes shortcuts.js lines to the real file.
const SHORTCUTS_PATH = fileURLToPath(new URL("./shortcuts.js", import.meta.url));
const shortcutsScript = new vm.Script(readFileSync(SHORTCUTS_PATH, "utf8"), {
  filename: SHORTCUTS_PATH,
});

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
  shortcutsScript.runInContext(ctx);
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

  it("passes unconsumed drawer-internal keys through to row handlers", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);

    // Enter on a focused stash entry: no git shortcut maps Enter, so the
    // capture handler must let the row's inline keydown run at target phase.
    const target = { closest: (sel) => (sel === "#gitUiPanel" ? {} : null) };
    const event = keyEvent({ key: "Enter", code: "Enter", target });
    shortcuts.handleKeydown(event);
    equal(event._stopped, undefined, "unconsumed in-panel keys keep propagating");
    equal(event.defaultPrevented, false, "row activation decides default behavior");
  });

  it("passes unconsumed keys through in the pane-hosted git mount", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);

    // Workspace panes host git log rows in .pane-git-container instead of
    // #gitUiPanel; the pass-through must cover both hosting roots.
    const target = { closest: (sel) => (sel === ".pane-git-container" ? {} : null) };
    const event = keyEvent({ key: "Enter", code: "Enter", target });
    shortcuts.handleKeydown(event);
    equal(event._stopped, undefined, "pane-hosted rows keep receiving keys");
  });

  it("passes terminal-surface keys through to the focused pane", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);

    // The wterm textarea is the keyboard input path for the terminal
    // behind the drawer; muting it left the focused terminal dead. Enter
    // must reach wterm's own keydown handler on the textarea.
    const taTarget = { id: "terminalImeInput", closest: (sel) => (sel === "#terminalShell" ? {} : null) };
    const taEvent = keyEvent({ key: "Enter", code: "Enter", target: taTarget });
    shortcuts.handleKeydown(taEvent);
    equal(taEvent._stopped, undefined, "terminal textarea keys reach the pane");

    // Same for a key whose target sits anywhere inside the shell.
    const shellTarget = { closest: (sel) => (sel === "#terminalShell" ? {} : null) };
    const shellEvent = keyEvent({ key: "c", code: "KeyC", ctrlKey: true, target: shellTarget });
    shortcuts.handleKeydown(shellEvent);
    equal(shellEvent._stopped, undefined, "ctrl combos in the shell are not eaten");
  });

  it("mutes unconsumed keys aimed outside the drawer", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);

    // Enter with focus left in the page body stays muted so typed keys
    // never leak into random handlers.
    const target = { closest: () => null };
    const event = keyEvent({ key: "Enter", code: "Enter", target });
    shortcuts.handleKeydown(event);
    ok(event._stopped, "outside-drawer keys never reach the page");
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

  it("releases the keyboard when the rail collapse hides the column", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    // The rail toggle flips the global collapse flag without touching the
    // drawer state: state.visible stays true while the column is off
    // screen. The keyboard must follow the screen, not the flag.
    ctx.window.HerdrRightSidebar = { collapsed: () => true };
    const shellTarget = { closest: (sel) => (sel === "#terminalShell" ? {} : null) };
    const bodyTarget = { closest: () => null };

    const shellEvent = keyEvent({ key: "c", code: "KeyC", ctrlKey: true, target: shellTarget });
    shortcuts.handleKeydown(shellEvent);
    equal(shellEvent._stopped, undefined, "terminal keys pass with the column collapsed");

    const bodyEvent = keyEvent({ key: "Enter", code: "Enter", target: bodyTarget });
    shortcuts.handleKeydown(bodyEvent);
    equal(bodyEvent._stopped, undefined, "body keys unmuted with the column collapsed");
    equal(calls.hides, 0, "no hide side effect");
  });

  it("keeps owning keys while a center git tab is active behind a collapsed column", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);
    // The drawer has two hosts: the sidebar column and the center git
    // pane tab. Collapsing the column hides only the first; a git log in
    // the center stays on screen, and its shortcuts must survive the
    // collapse. paneActiveTab/isGitTab are the same accessors render.js
    // reads (HerdrWorkspacePanes exports).
    ctx.window.HerdrRightSidebar = { collapsed: () => true };
    ctx.window.HerdrWorkspacePanes = {
      paneActiveTab: () => "git:log",
      isGitTab: (id) => String(id).startsWith("git:"),
    };
    const paneTarget = { closest: (sel) => (sel === ".pane-git-container" ? {} : null) };

    const event = keyEvent({ key: "Enter", code: "Enter", target: paneTarget });
    shortcuts.handleKeydown(event);
    equal(event._stopped, undefined, "pane-hosted rows still receive keys (pass-through)");

    const bodyEvent = keyEvent({ key: "Enter", code: "Enter", target: { closest: () => null } });
    shortcuts.handleKeydown(bodyEvent);
    ok(bodyEvent._stopped, "body keys stay muted while the git tab is on screen");
  });

  it("releases the keyboard again once the active tab leaves the git view", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);
    ctx.window.HerdrRightSidebar = { collapsed: () => true };
    let activeTab = "git:log";
    ctx.window.HerdrWorkspacePanes = {
      paneActiveTab: () => activeTab,
      isGitTab: (id) => String(id).startsWith("git:"),
    };
    const event = keyEvent({ key: "Enter", code: "Enter", target: { closest: () => null } });
    shortcuts.handleKeydown(event);
    ok(event._stopped, "muted while the git tab is active");

    activeTab = "tab_1";
    const after = keyEvent({ key: "Enter", code: "Enter", target: { closest: () => null } });
    shortcuts.handleKeydown(after);
    equal(after._stopped, undefined, "released once the active tab is the terminal");
  });

  it("yields the keyboard to an open location-bar popover", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, calls } = makeShortcuts(ctx);
    // The bar's popovers render inside the header, outside the git roots.
    // While one is up the drawer must not consume Escape (which would
    // navigate or hide the drawer instead of closing the popover) nor
    // Enter (which drives the new-branch field).
    let popover = null;
    ctx.document.querySelector = (selector) => (
      selector === ".location-bar-branch-popover" || selector === ".location-bar-worktree-popover"
        ? popover
        : null
    );

    popover = {};
    const escWhileOpen = keyEvent();
    shortcuts.handleKeydown(escWhileOpen);
    equal(escWhileOpen._stopped, undefined, "Escape reaches the bar's document-capture handler");
    equal(calls.hides, 0, "drawer keeps its state while the popover owns the keyboard");

    popover = null;
    const escAfterClose = keyEvent();
    shortcuts.handleKeydown(escAfterClose);
    ok(escAfterClose._stopped, "drawer owns Escape again once the popover is gone");
  });

  it("the prefix-armed V key opens the bar branch popover with no event", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts, state } = makeShortcuts(ctx);
    // The action forwards no event so the bar falls back to its rendered
    // chip; this stub records the call shape the bar receives.
    const calls = [];
    ctx.window.HerdrLocationBar = {
      openBranchPopover(arg) { calls.push(arg); },
    };

    // Arm the shortcut prefix the way a real Ctrl+B press does.
    shortcuts.handleKeydown(keyEvent({
      key: "b",
      code: "KeyB",
      ctrlKey: true,
      target: { closest: () => null },
    }));
    equal(calls.length, 0, "the prefix press itself opens nothing");

    shortcuts.handleKeydown(keyEvent({ key: "v", code: "KeyV", target: { closest: () => null } }));
    equal(calls.length, 1, "prefix-armed V dispatched to the branch action");
    equal(calls[0], null, "the bar receives no event and must use its chip fallback");
  });
});
