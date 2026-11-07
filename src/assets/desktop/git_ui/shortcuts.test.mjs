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

describe("git_ui shortcuts: Escape closes modals", () => {
  it("closes each selected-commit modal in order", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const modalKeys = ["gitOpModal", "commitModal", "compareSelectedModal", "resetSelectedModal", "tagSelectedModal", "cleanupConfirm"];
    for (const key of modalKeys) {
      const fresh = makeContext();
      loadShortcuts(fresh);
      const { shortcuts, state } = makeShortcuts(fresh);
      state[key] = { ref: "abc" };
      const renders = [];
      const savedDrafts = [];
      shortcuts.handleKeydown(keyEvent());
      // state mutated to null, and the branch ran without hide/confirm
      if (key === "commitModal") continue;
      equal(state[key], null, `${key} cleared by Escape`);
    }
  });

  it("saves the commit draft when Escape closes the commit modal", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const drafts = [];
    const { shortcuts, state } = makeShortcuts(ctx, { saveDraftFromDom() { drafts.push(1); } });
    state.commitModal = { title: "" };
    shortcuts.handleKeydown(keyEvent());
    equal(drafts.length, 1, "the draft persists before the modal clears");
    equal(state.commitModal, null, "commit modal cleared");
  });

  it("Escape inside the diff search clears the search instead of navigating", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const cleared = [];
    const { shortcuts } = makeShortcuts(ctx, {
      getGitUi() {
        return { clearDiffSearch() { cleared.push(1); }, goBack() {}, showChangesList() {} };
      },
    });
    const target = { closest: (sel) => (sel === "#gitUiDiffSearch" ? {} : null) };
    const event = keyEvent({ target });
    shortcuts.handleKeydown(event);
    equal(cleared.length, 1, "Escape clears the diff search");
    ok(event.defaultPrevented, "the clear swallows the Escape");
  });

  it("ctrl+f opens the diff search when the view has a searchable diff", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const opened = [];
    const { shortcuts } = makeShortcuts(ctx, {
      canSearchDiff: () => true,
      getGitUi() {
        return { openDiffSearch() { opened.push(1); } };
      },
    });
    const event = keyEvent({ key: "f", code: "KeyF", ctrlKey: true, target: { closest: () => null } });
    shortcuts.handleKeydown(event);
    equal(opened.length, 1, "ctrl+f opens the diff search");
    ok(event.defaultPrevented, "the browser find bar stays closed");
  });

  it("ctrl+f passes through when the diff cannot be searched", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const opened = [];
    const { shortcuts } = makeShortcuts(ctx, {
      canSearchDiff: () => false,
      getGitUi() {
        return { openDiffSearch() { opened.push(1); } };
      },
    });
    const event = keyEvent({ key: "f", code: "KeyF", ctrlKey: true, target: { closest: () => null } });
    shortcuts.handleKeydown(event);
    equal(opened.length, 0, "no search opens without a diff");
    equal(event.defaultPrevented, false, "the browser find bar keeps the key");
  });
});

describe("git_ui shortcuts: prefix dispatch", () => {
  function armedDispatcher(overrides = {}) {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const gitUi = {
      showChangesList: () => actions.push("changes"),
      openCommitModal: () => actions.push("commit"),
      tab: (name) => actions.push(`tab:${name}`),
      refresh: () => actions.push("refresh"),
      toggleStageAll: () => actions.push("stageAll"),
      toggleBlame: () => actions.push("blame"),
      editFile: () => actions.push("edit"),
      stageFile: (p) => actions.push(`stageFile:${p}`),
      unstageFile: (p) => actions.push(`unstageFile:${p}`),
      discardFile: (p) => actions.push(`discardFile:${p}`),
      stashFile: (p) => actions.push(`stashFile:${p}`),
      compareCurrent: () => actions.push("compare"),
      goBack: () => actions.push("goBack"),
      clearDiffSearch: () => actions.push("clearSearch"),
      openDiffSearch: () => actions.push("openSearch"),
    };
    const view = { tab: "changes", navigationStack: [], file: "src/a.js", sideEditor: null };
    const made = makeShortcuts(ctx, {
      active: () => view,
      canEditCurrentFile: () => true,
      getGitUi: () => gitUi,
      ...overrides,
    });
    const arm = () => made.shortcuts.handleKeydown(keyEvent({
      key: "b", code: "KeyB", ctrlKey: true, target: { closest: () => null },
    }));
    const press = (key, code, extra = {}) => made.shortcuts.handleKeydown(keyEvent({
      key, code, target: { closest: () => null }, ...extra,
    }));
    return { ...made, actions, arm, press, view, gitUi };
  }

  it("maps every default shortcut key to its action", () => {
    const d = armedDispatcher();
    const fired = (key, code) => { d.arm(); d.press(key, code); return d.actions.pop(); };
    equal(fired("1", "Digit1"), "changes", "Digit1 shows the changes list");
    equal(fired("2", "Digit2"), "commit", "Digit2 opens the commit modal");
    equal(fired("3", "Digit3"), "tab:log", "Digit3 opens the log");
    equal(fired("4", "Digit4"), "tab:stash", "Digit4 opens the stash");
    equal(fired("c", "KeyC"), "commit", "KeyC is the commit alt");
    equal(fired("l", "KeyL"), "tab:log", "KeyL is the log alt");
    equal(fired("r", "KeyR"), "refresh", "KeyR refreshes");
    equal(fired("g", "KeyG"), "stageAll", "KeyG toggles stage all");
    equal(fired("h", "KeyH"), "tab:history", "KeyH opens the file history");
    equal(fired("m", "KeyM"), "blame", "KeyM toggles blame");
    equal(fired("e", "KeyE"), "edit", "KeyE edits the file");
    equal(fired("o", "KeyO"), "compare", "KeyO compares with current");
    d.arm();
    d.press("0", "Digit0");
    equal(d.actions.length, 0, "help shows the alert without touching the git ui");
  });

  it("stage, unstage, discard, and stash act on the focused file row", () => {
    const d = armedDispatcher();
    const row = {
      dataset: { gitPath: "src/row.js" },
      closest: (sel) => (sel === ".git-ui-file[data-git-path]" ? row : null),
    };
    const fired = (key, code) => { d.arm(); d.press(key, code, { target: row }); return d.actions.pop(); };
    equal(fired("y", "KeyY"), "stageFile:src%2Frow.js", "KeyY stages the row file");
    equal(fired("u", "KeyU"), "unstageFile:src%2Frow.js", "KeyU unstages the row file");
    equal(fired("d", "KeyD"), "discardFile:src%2Frow.js", "KeyD discards the row file");
    equal(fired("z", "KeyZ"), "stashFile:src%2Frow.js", "KeyZ stashes the row file");
  });

  it("falls back to the selected view file when no row is focused", () => {
    const d = armedDispatcher();
    d.arm();
    d.press("y", "KeyY");
    equal(d.actions.pop(), "stageFile:src%2Fa.js", "the view file drives the stage");
  });

  it("file actions stay no-ops without a file or row", () => {
    const d = armedDispatcher();
    d.view.file = null;
    d.arm();
    d.press("y", "KeyY");
    equal(d.actions.length, 0, "no file means no stage post");
  });

  it("edit respects canEditCurrentFile", () => {
    const d = armedDispatcher({ canEditCurrentFile: () => false });
    d.arm();
    d.press("e", "KeyE");
    equal(d.actions.length, 0, "canEditCurrentFile false blocks the edit");
  });

  it("armed keys with modifiers or editable targets never dispatch", () => {
    const d = armedDispatcher();
    d.arm();
    d.press("1", "Digit1", { ctrlKey: true });
    equal(d.actions.length, 0, "ctrl combos do not run single-key actions");

    const input = { closest: (sel) => (sel === "input, textarea, select, [contenteditable='true']" ? {} : null) };
    d.press("1", "Digit1", { target: input });
    equal(d.actions.length, 0, "typing in fields stays untouched");
  });

  it("a second prefix press re-arms the window", () => {
    const d = armedDispatcher();
    d.arm();
    d.press("1", "Digit1");
    equal(d.actions.length, 1, "the armed key fires once");
    d.press("1", "Digit1");
    equal(d.actions.length, 1, "the disarm after dispatch blocks stale keys");
    d.arm();
    d.press("1", "Digit1");
    equal(d.actions.length, 2, "a fresh prefix arms the next key again");
  });

  it("configured shortcuts override the defaults", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const { shortcuts } = makeShortcuts(ctx, {
      gitUiOptions: () => ({ gitShortcuts: { refresh: "F5" } }),
      getGitUi() {
        return { refresh: () => actions.push("refresh") };
      },
    });
    shortcuts.handleKeydown(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, target: { closest: () => null } }));
    shortcuts.handleKeydown(keyEvent({ key: "F5", code: "F5", target: { closest: () => null } }));
    equal(actions.length, 1, "F5 refreshes after the configured override");
  });

  it("help renders the configured prefix label and friendly key names", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const alerts = [];
    const { shortcuts } = makeShortcuts(ctx, {
      gitUiOptions: () => ({ globalShortcutPrefix: "Cmd+Shift+B" }),
      alertFn(text) { alerts.push(text); },
      getGitUi() { return {}; },
    });
    shortcuts.handleKeydown(keyEvent({ key: "B", code: "KeyB", metaKey: true, shiftKey: true, target: { closest: () => null } }));
    shortcuts.handleKeydown(keyEvent({ key: "0", code: "Digit0", target: { closest: () => null } }));
    equal(alerts.length, 1, "help fires once");
    ok(alerts[0].startsWith("Shift+Meta+B then:"), "the configured prefix labels the help");
    ok(alerts[0].includes("1 Changes list"), "Digit1 renders without the Digit prefix");
    ok(alerts[0].includes("2 Commit modal"), "the commit key renders without the Digit prefix");
    ok(alerts[0].endsWith("Esc Back / hide"), "the help closes with the Esc contract");
  });

  it("focusFirstGitFile focuses the first tree row", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const focused = [];
    ctx.document.querySelector = (selector) => (
      selector.includes(".git-ui-file") ? { focus: () => focused.push(selector) } : null
    );
    const { shortcuts } = makeShortcuts(ctx);
    shortcuts.handleKeydown(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, target: { closest: () => null } }));
    shortcuts.handleKeydown(keyEvent({ key: "i", code: "KeyI", target: { closest: () => null } }));
    equal(focused.length, 1, "KeyI focuses the first file row");
  });

  it("the hint toast echoes the fired shortcut when the global helper exists", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const hints = [];
    ctx.globalThis.showShortcutHintToast = (kind, action) => hints.push({ kind, action });
    const { shortcuts } = makeShortcuts(ctx, { getGitUi() { return { refresh: () => {} }; } });
    shortcuts.handleKeydown(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, target: { closest: () => null } }));
    shortcuts.handleKeydown(keyEvent({ key: "r", code: "KeyR", target: { closest: () => null } }));
    equal(hints.length, 1, "the dispatch echoes one hint");
    equal(hints[0].action, "refresh", "the hint names the fired action");
  });

  it("shift-aware keys keep their Shift prefix in the lookup", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const { shortcuts } = makeShortcuts(ctx, {
      gitUiOptions: () => ({ gitShortcuts: { refresh: "Shift+KeyR" } }),
      getGitUi() { return { refresh: () => actions.push("refresh") }; },
    });
    shortcuts.handleKeydown(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, target: { closest: () => null } }));
    shortcuts.handleKeydown(keyEvent({ key: "R", code: "KeyR", shiftKey: true, target: { closest: () => null } }));
    equal(actions.length, 1, "Shift+R maps through shortcutKey");
  });

  it("titleWithGitShortcut appends the armed label to titles", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);
    const label = shortcuts.titleWithGitShortcut("Commit", "commit");
    equal(label, "Commit (Ctrl+B then 2)", "the title carries the prefix and key");
    equal(shortcuts.titleWithGitShortcut("Commit", "missing"), "Commit", "unknown actions keep the bare title");
  });
});

describe("git_ui shortcuts: webui chord delegation", () => {
  it("handleChordActionKey runs a git action without a prior arm", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const { shortcuts, state } = makeShortcuts(ctx, {
      getGitUi() { return { showChangesList: () => actions.push("changes") }; },
    });
    equal(state.shortcutPrefixUntil, 0, "no arming before the call");
    const consumed = shortcuts.handleChordActionKey(keyEvent({
      key: "1", code: "Digit1", target: { closest: () => null },
    }));
    equal(consumed, true, "the delegated key dispatches");
    equal(actions.length, 1, "the changes action ran");
    equal(state.shortcutPrefixUntil, 0, "the arm restores after the call");
  });

  it("handleChordActionKey returns false for unmatched keys so webui keeps them", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const { shortcuts } = makeShortcuts(ctx);
    const consumed = shortcuts.handleChordActionKey(keyEvent({
      key: "9", code: "Digit9", target: { closest: () => null },
    }));
    equal(consumed, false, "unmapped keys are not consumed");
  });

  it("handleChordActionKey returns false while hidden or in overlays", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const hiddenState = Object.assign(Object.create(null), {
      visible: false, shortcutPrefixUntil: 0,
    });
    const made = makeShortcuts(ctx, {
      state: hiddenState,
      getGitUi() { return { showChangesList: () => actions.push("changes") }; },
    });
    equal(made.shortcuts.handleChordActionKey(keyEvent({
      key: "1", code: "Digit1", target: { closest: () => null },
    })), false, "hidden drawer declines the key");
    equal(actions.length, 0, "nothing ran while hidden");

    const ctx2 = makeContext();
    loadShortcuts(ctx2);
    const visible = makeShortcuts(ctx2, {
      getGitUi() { return { showChangesList: () => actions.push("changes") }; },
    });
    ctx2.document.querySelectorAll = (sel) => (
      sel === ".modal-backdrop" ? [{ style: { display: "block" } }] : []
    );
    equal(visible.shortcuts.handleChordActionKey(keyEvent({
      key: "1", code: "Digit1", target: { closest: () => null },
    })), false, "an open app modal declines the key");
    equal(actions.length, 0, "nothing ran behind the modal");
  });

  it("handleChordActionKey respects configured remaps", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const { shortcuts } = makeShortcuts(ctx, {
      gitUiOptions: () => ({ gitShortcuts: { changes: "F9" } }),
      getGitUi() { return { showChangesList: () => actions.push("changes") }; },
    });
    equal(shortcuts.handleChordActionKey(keyEvent({
      key: "1", code: "Digit1", target: { closest: () => null },
    })), false, "the default key no longer dispatches after remap");
    equal(shortcuts.handleChordActionKey(keyEvent({
      key: "F9", code: "F9", target: { closest: () => null },
    })), true, "the remapped key dispatches");
    equal(actions.length, 1, "the changes action ran once");
  });
});

describe("git_ui shortcuts: new git actions", () => {
  function actionHarness(overrides = {}) {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const actions = [];
    const gitUi = {
      showChangesList: () => actions.push("changes"),
      tab: (name) => actions.push(`tab:${name}`),
      pullUpdateFromUpstream: () => actions.push("pull"),
      pushNow: () => actions.push("push"),
      fetchOrigin: () => actions.push("fetch"),
      pullWithRebase: () => actions.push("pullRebase"),
      stash: () => actions.push("stashPush"),
      applyStash: (name, pop) => actions.push(`applyStash:${name}:${pop}`),
      dropStash: (name) => actions.push(`dropStash:${name}`),
      resolve: (path, mode) => actions.push(`resolve:${path}:${mode}`),
      goBack() {},
    };
    const view = {
      tab: "changes",
      navigationStack: [],
      file: "src/a.js",
      sideEditor: null,
      selectedStash: "stash@{0}",
      stashData: { stashes: ["stash@{0}", "stash@{1}"] },
      status: { conflicted: ["src/conflict.js", "other.txt"] },
    };
    const made = makeShortcuts(ctx, {
      active: () => view,
      getGitUi: () => gitUi,
      ...overrides,
    });
    const fire = (key, code, extra = {}) => shortcuts2Fire(made.shortcuts, key, code, extra);
    return { ...made, actions, fire, view, gitUi, ctx };
  }
  function shortcuts2Fire(shortcuts, key, code, extra = {}) {
    return shortcuts.handleChordActionKey(keyEvent({
      key, code, target: { closest: () => null }, ...extra,
    }));
  }

  it("maps the sync actions to their default keys", () => {
    const d = actionHarness();
    equal(d.fire("5", "Digit5"), true);
    equal(d.actions.pop(), "tab:cleanup", "Digit5 opens the cleanup tab");
    equal(d.fire("F2", "F2"), true);
    equal(d.actions.pop(), "pull", "F2 pulls");
    equal(d.fire("F3", "F3"), true);
    equal(d.actions.pop(), "push", "F3 pushes");
    equal(d.fire("F4", "F4"), true);
    equal(d.actions.pop(), "fetch", "F4 fetches");
    equal(d.fire("T", "KeyT", { shiftKey: true }), true);
    equal(d.actions.pop(), "pullRebase", "Shift+T pulls with rebase");
  });

  it("maps the stash entry actions to the selected stash", () => {
    const d = actionHarness();
    equal(d.fire("K", "KeyK", { shiftKey: true }), true);
    equal(d.actions.pop(), "stashPush", "Shift+K stashes");
    equal(d.fire("F5", "F5"), true);
    equal(d.actions.pop(), "applyStash:stash%40%7B0%7D:false", "F5 applies the selected stash");
    equal(d.fire("F6", "F6"), true);
    equal(d.actions.pop(), "applyStash:stash%40%7B0%7D:true", "F6 pops the selected stash");
    equal(d.fire("Q", "KeyQ", { shiftKey: true }), true);
    equal(d.actions.pop(), "dropStash:stash%40%7B0%7D", "Shift+Q drops the selected stash");
  });

  it("stash actions fall back to the first stash without a selection", () => {
    const d = actionHarness();
    d.view.selectedStash = "";
    equal(d.fire("F5", "F5"), true);
    equal(d.actions.pop(), "applyStash:stash%40%7B0%7D:false", "the first stash applies");
    const none = actionHarness();
    none.view.selectedStash = "";
    none.view.stashData = { stashes: [] };
    equal(none.fire("F5", "F5"), true);
    equal(none.actions.length, 0, "no stashes means no action target");
  });

  it("maps conflict resolution to the selected conflict file", () => {
    const d = actionHarness();
    d.view.file = "src/conflict.js";
    equal(d.fire("F7", "F7"), true);
    equal(d.actions.pop(), "resolve:src%2Fconflict.js:ours", "F7 resolves with HEAD");
    equal(d.fire("F8", "F8"), true);
    equal(d.actions.pop(), "resolve:src%2Fconflict.js:base", "F8 resolves with parent");
    equal(d.fire("Shift+F9", "F9", { shiftKey: true }), true);
    equal(d.actions.pop(), "resolve:src%2Fconflict.js:theirs", "Shift+F9 resolves with remote");
    equal(d.fire("N", "KeyN", { shiftKey: true }), true);
    equal(d.actions.pop(), "resolve:src%2Fconflict.js:mark", "Shift+N marks resolved");
  });

  it("conflict resolution falls back to the first conflicted file", () => {
    const d = actionHarness();
    d.view.file = "";
    equal(d.fire("F7", "F7"), true);
    equal(d.actions.pop(), "resolve:src%2Fconflict.js:ours", "the first conflicted file resolves");
    const none = actionHarness();
    none.view.status = { conflicted: [] };
    equal(none.fire("F7", "F7"), true);
    equal(none.actions.length, 0, "no conflicts means no action target");
  });

  it("the help alert lists every new action", () => {
    const ctx = makeContext();
    loadShortcuts(ctx);
    const alerts = [];
    const { shortcuts } = makeShortcuts(ctx, {
      alertFn(text) { alerts.push(text); },
      getGitUi() { return {}; },
    });
    shortcuts.handleChordActionKey(keyEvent({ key: "0", code: "Digit0", target: { closest: () => null } }));
    equal(alerts.length, 1, "help fires once");
    for (const line of [
      "5 Cleanup tab", "F2 Pull update", "F3 Push", "F4 Fetch origin",
      "Shift+T Pull with rebase", "Shift+K Stash push", "F5 Apply selected stash",
      "F6 Pop selected stash", "Shift+Q Drop selected stash",
      "F7 Conflict: use HEAD", "F8 Conflict: use parent",
      "Shift+F9 Conflict: use remote", "Shift+N Conflict: mark resolved",
    ]) {
      ok(alerts[0].includes(line), `help lists "${line}"`);
    }
  });
});
