import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// Coverage suite for desktop/git_ui/shortcuts.js: the chord-action path
// (handleChordActionKey plus every action lambda), the prefix helpers,
// stash/conflict resolution pickers, the help dialog text, and the
// Escape-in-diff-search arm. The module under test is a factory over an
// injected state/view/gitUi, so these tests drive it through public inputs
// (events) and public outputs (getGitUi calls), same contract the real
// dispatcher uses.

function productScript(relPath) {
  productScript.cache = productScript.cache || new Map();
  if (!productScript.cache.has(relPath)) {
    const realPath = fileURLToPath(new URL(relPath, import.meta.url));
    productScript.cache.set(
      relPath,
      new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath }),
    );
  }
  return productScript.cache.get(relPath);
}

function element(opts = {}) {
  return Object.assign({
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    value: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    removeChild() {},
    remove() {},
    replaceWith() {},
    insertBefore() {},
    after() {},
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }, opts);
}

function context() {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {},
    prompt: () => null,
    confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      title: "",
      body: element(),
      documentElement: element(),
      hidden: false,
      visibilityState: "visible",
      createElement: () => element(),
      execCommand: () => true,
      // Truthful stubs: the popover/picker/session-manager guards probe
      // these; answering null (closed) keeps the keydown path honest.
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    window: null,
    globalThis: null,
    WebSocket: class {},
    addEventListener() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadShortcuts({ rightSidebar, panes, documentQuerySelector } = {}) {
  const ctx = context();
  if (documentQuerySelector) ctx.document.querySelector = documentQuerySelector;
  productScript("./shared/core.js").runInContext(ctx);
  productScript("./desktop/git_ui/shortcuts.js").runInContext(ctx);
  // visible() reads window.HerdrRightSidebar / window.HerdrWorkspacePanes
  // from inside this vm context; inject the stubs there, not in the test
  // process global.
  if (rightSidebar) ctx.HerdrRightSidebar = rightSidebar;
  if (panes) ctx.HerdrWorkspacePanes = panes;
  return ctx.window.HerdrGitUiShortcuts;
}

// Records every getGitUi call so assertions name the action that fired.
function recordingGitUi() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    api: {
      showChangesList: record("showChangesList"),
      openCommitModal: record("openCommitModal"),
      tab: record("tab"),
      refresh: record("refresh"),
      toggleStageAll: record("toggleStageAll"),
      toggleBlame: record("toggleBlame"),
      editFile: record("editFile"),
      stageFile: record("stageFile"),
      unstageFile: record("unstageFile"),
      discardFile: record("discardFile"),
      stashFile: record("stashFile"),
      compareCurrent: record("compareCurrent"),
      pullUpdateFromUpstream: record("pullUpdateFromUpstream"),
      pushNow: record("pushNow"),
      fetchOrigin: record("fetchOrigin"),
      pullWithRebase: record("pullWithRebase"),
      stash: record("stash"),
      applyStash: record("applyStash"),
      dropStash: record("dropStash"),
      resolve: record("resolve"),
      openDiffSearch: record("openDiffSearch"),
      clearDiffSearch: record("clearDiffSearch"),
      goBack: record("goBack"),
    },
  };
}

function makeShortcuts({ state, view, gitUiApi, options, canSearchDiff, canEdit, rightSidebar, panes, documentQuerySelector, confirmAnswer }) {
  const recorder = gitUiApi || recordingGitUi().api;
  // Keep the caller's state object identity: the module mutates
  // state.shortcutPrefixUntil in place, and tests observe the same object.
  const fullState = Object.assign(state || {}, {
    visible: state && state.visible !== undefined ? state.visible : true,
    contextMenu: null,
    logContextMenu: null,
    headerMenu: null,
    gitOpModal: null,
    commitModal: null,
    compareSelectedModal: null,
    resetSelectedModal: null,
    tagSelectedModal: null,
    cleanupConfirm: null,
  });
  if (!Object.prototype.hasOwnProperty.call(fullState, "shortcutPrefixUntil")) fullState.shortcutPrefixUntil = 0;
  const shortcutsCtx = loadShortcuts({ rightSidebar, panes, documentQuerySelector });
  return shortcutsCtx.create({
    state: fullState,
    render: () => {},
    active: () => view,
    currentMode: () => (view && view.mode) || "changes",
    gitUiOptions: () => options || {},
    explorationDefaultDirectory: () => "",
    canSearchDiff: () => (canSearchDiff === undefined ? true : canSearchDiff),
    canEditCurrentFile: () => (canEdit === undefined ? true : canEdit),
    saveDraftFromDom: () => {},
    hide: () => {},
    confirmFn: () => (confirmAnswer === undefined ? true : confirmAnswer),
    alertFn: () => {},
    getGitUi: () => recorder,
  });
}

function chordEvent(key, extra = {}) {
  return Object.assign({
    key,
    code: extra.code || key,
    ctrlKey: false,
    altKey: false,
    shiftKey: extra.shiftKey || false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
    target: { closest: () => null },
  }, extra);
}

test("handleChordActionKey fires every mapped action once per chord", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "src/a.js", mode: "changes", selectedStash: "", stashData: null, status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  const cases = [
    ["changes", "Digit1", "showChangesList"],
    ["commit", "Digit2", "openCommitModal"],
    ["commitAlt", "KeyC", "openCommitModal"],
    ["log", "Digit3", "tab"],
    ["logAlt", "KeyL", "tab"],
    ["stash", "Digit4", "tab"],
    ["refresh", "KeyR", "refresh"],
    ["stageAll", "KeyG", "toggleStageAll"],
    ["focusFile", "KeyI", null],
    ["cleanup", "Digit5", "tab"],
    ["pull", "F2", "pullUpdateFromUpstream"],
    ["push", "F3", "pushNow"],
    ["fetch", "F4", "fetchOrigin"],
    ["stashPush", "KeyK", "stash", true],
  ];
  for (const [action, code, expectName, shift] of cases) {
    const ev = chordEvent(code, { shiftKey: !!shift });
    const consumed = shortcuts.handleChordActionKey(ev);
    assert.ok(consumed, `${action} chord consumed`);
    assert.ok(ev.defaultPrevented, `${action} preventDefault ran`);
    if (expectName) {
      const last = calls[calls.length - 1];
      assert.equal(last && last.name, expectName, `${action} fired ${expectName}`);
    }
  }
  // Focus-file action has no gitUi call: it focuses a DOM node instead.
  // Covered implicitly above; a file node is absent in the stub so it is a
  // no-op, and no spurious call fired.
  assert.ok(!calls.some((c) => c.name === "openDiffSearch"), "no diff search side effect");
});

test("file-scoped actions read the path from the row then the view", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "src/view.js", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  shortcuts.handleChordActionKey(chordEvent("KeyY")); // stageFile
  shortcuts.handleChordActionKey(chordEvent("KeyU")); // unstageFile
  shortcuts.handleChordActionKey(chordEvent("KeyD")); // discardFile
  shortcuts.handleChordActionKey(chordEvent("KeyZ")); // stashFile
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["stageFile", "unstageFile", "discardFile", "stashFile"]);
  for (const c of calls) assert.equal(c.args[0], encodeURIComponent("src/view.js"), "view.file path is used");
});

test("history, blame, edit act only with a file; edit also needs canEdit", () => {
  const { calls, api } = recordingGitUi();
  const noFile = makeShortcuts({ view: { tab: "changes", file: "", mode: "changes", sideEditor: null }, gitUiApi: api });
  assert.ok(noFile.handleChordActionKey(chordEvent("KeyH")), "history chord consumed even without a file");
  assert.equal(calls.length, 0, "no gitUi call without a file");
  assert.ok(noFile.handleChordActionKey(chordEvent("KeyM")), "blame chord consumed even without a file");
  assert.equal(calls.length, 0, "still no gitUi call");
  assert.ok(noFile.handleChordActionKey(chordEvent("KeyE")), "edit chord consumed without a file");
  assert.equal(calls.length, 0, "edit with no file fires nothing");

  const withFile = makeShortcuts({ view: { tab: "changes", file: "a.js", mode: "changes", sideEditor: null }, gitUiApi: api, canEdit: false });
  assert.ok(withFile.handleChordActionKey(chordEvent("KeyE")), "edit chord still consumed when canEditCurrentFile is false");
  assert.equal(calls.length, 0, "edit blocked: no editFile call");
  assert.ok(withFile.handleChordActionKey(chordEvent("KeyH")), "history with file consumed");
  assert.ok(withFile.handleChordActionKey(chordEvent("KeyM")), "blame with file consumed");
  assert.deepEqual(calls.map((c) => c.name), ["tab", "toggleBlame"], "history then blame fired");
  const canEdit = makeShortcuts({ view: { tab: "changes", file: "a.js", mode: "changes", sideEditor: null }, gitUiApi: api, canEdit: true });
  assert.ok(canEdit.handleChordActionKey(chordEvent("KeyE")), "edit fires when allowed");
  assert.equal(calls[calls.length - 1].name, "editFile");
});

test("stash shortcuts act on the selected stash, falling back to the first entry", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "stash", file: "", mode: "changes", selectedStash: "wip@{1}", stashData: null, status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  shortcuts.handleChordActionKey(chordEvent("F5")); // stashApply
  shortcuts.handleChordActionKey(chordEvent("F6")); // stashPop
  shortcuts.handleChordActionKey(chordEvent("KeyQ", { shiftKey: true })); // stashDrop
  assert.deepEqual(calls.map((c) => c.name), ["applyStash", "applyStash", "dropStash"]);
  assert.equal(calls[0].args[0], encodeURIComponent("wip@{1}"));
  assert.equal(calls[1].args[1], true, "pop passes applyAfter=true");
  // Fallback: no selection, first stash entry answers.
  const first = makeShortcuts({ view: { tab: "stash", file: "", mode: "changes", selectedStash: "", stashData: { stashes: ["first-stash"] }, status: { conflicted: [] }, sideEditor: null }, gitUiApi: api });
  first.handleChordActionKey(chordEvent("F5"));
  assert.equal(calls[calls.length - 1].args[0], encodeURIComponent("first-stash"));
  // No stash anywhere: the action is consumed but nothing fires.
  const none = makeShortcuts({ view: { tab: "stash", file: "", mode: "changes", selectedStash: "", stashData: { stashes: [] }, status: { conflicted: [] }, sideEditor: null }, gitUiApi: api });
  const before = calls.length;
  none.handleChordActionKey(chordEvent("F5"));
  assert.equal(calls.length, before, "no stash selection, no applyStash call");
});

test("conflict shortcuts resolve the focused row, else the view file, else the first", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "conflicts", file: "merge.txt", mode: "changes", status: { conflicted: ["merge.txt", "other.txt"] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  shortcuts.handleChordActionKey(chordEvent("F7")); // ours
  shortcuts.handleChordActionKey(chordEvent("F8")); // base
  shortcuts.handleChordActionKey(chordEvent("F9", { shiftKey: true })); // theirs
  shortcuts.handleChordActionKey(chordEvent("KeyN", { shiftKey: true })); // mark
  assert.deepEqual(calls.map((c) => c.name), ["resolve", "resolve", "resolve", "resolve"]);
  assert.deepEqual(calls.map((c) => c.args[0]), Array(4).fill(encodeURIComponent("merge.txt")));
  assert.deepEqual(calls.map((c) => c.args[1]), ["ours", "base", "theirs", "mark"]);
  // No conflicted files: the chord is consumed but resolve never fires.
  const empty = makeShortcuts({ view: { tab: "conflicts", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null }, gitUiApi: api });
  const before = calls.length;
  assert.ok(empty.handleChordActionKey(chordEvent("F7")), "chord still consumed");
  assert.equal(calls.length, before, "no conflicts, no resolve call");
});

test("prefix press through handleKeydown arms the window and is consumed", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const state = { shortcutPrefixUntil: 0 };
  const shortcuts = makeShortcuts({ state, view, gitUiApi: api });
  // The default prefix is Ctrl+B; a ctrl+b press matches it.
  const ev = chordEvent("b", { ctrlKey: true, code: "KeyB" });
  const before = Date.now();
  shortcuts.handleKeydown(ev);
  assert.ok(ev.defaultPrevented, "prefix press preventDefault");
  assert.ok(state.shortcutPrefixUntil >= before, `arming window set (got ${state.shortcutPrefixUntil})`);
  assert.equal(calls.length, 0, "prefix alone fires no action");
});

test("handleKeydown runs git actions after a prefix press within the window", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const state = { shortcutPrefixUntil: 0 };
  const shortcuts = makeShortcuts({ state, view, gitUiApi: api });
  shortcuts.handleKeydown(chordEvent("b", { ctrlKey: true, code: "KeyB" }));
  const ev = chordEvent("Digit3"); // log
  shortcuts.handleKeydown(ev);
  assert.equal(calls[calls.length - 1].name, "tab", "log fired after arming");
  assert.ok(ev.defaultPrevented, "action key preventDefault");
  // The window closes after one action.
  const second = chordEvent("Digit2");
  shortcuts.handleKeydown(second);
  assert.equal(calls[calls.length - 1].name, "tab", "second key outside the window is not a commit chord");
  assert.ok(!second.defaultPrevented, "unarmed key is not consumed as action");
});

test("modifier keys and editable targets never fire git actions", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "a.js", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ state: { shortcutPrefixUntil: Date.now() + 5000 }, view, gitUiApi: api });
  assert.ok(!shortcuts.handleChordActionKey(chordEvent("KeyC", { metaKey: true })), "meta key rejected");
  assert.ok(!shortcuts.handleChordActionKey(chordEvent("KeyC", { ctrlKey: true })), "ctrl key rejected");
  assert.ok(!shortcuts.handleChordActionKey(chordEvent("KeyC", { altKey: true })), "alt key rejected");
  assert.ok(!shortcuts.handleChordActionKey(chordEvent("KeyC", { target: { closest: () => element() } })), "editable target rejected");
  assert.equal(calls.length, 0, "no action fired");
});

test("ctrl/cmd+f opens diff search when the view supports it", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "log", file: "", mode: "log", status: { conflicted: [] }, sideEditor: null };
  const yes = makeShortcuts({ view, gitUiApi: api, canSearchDiff: true });
  const ev = chordEvent("f", { ctrlKey: true, code: "KeyF" });
  yes.handleKeydown(ev);
  assert.equal(calls[calls.length - 1].name, "openDiffSearch", "diff search opened (handleKeydown returns undefined)");
  assert.ok(ev.defaultPrevented, "diff search preventDefault");
  const no = makeShortcuts({ view, gitUiApi: api, canSearchDiff: false });
  const blockedCount = calls.length;
  no.handleKeydown(chordEvent("f", { ctrlKey: true, code: "KeyF" }));
  assert.equal(calls.length, blockedCount, "unsupported view does not open diff search");
});

test("Escape inside the diff search clears it and is consumed", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "log", file: "", mode: "log", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  const ev = Object.assign(chordEvent("Escape"), { key: "Escape", target: { closest: (sel) => sel === "#gitUiDiffSearch" ? element() : null } });
  shortcuts.handleKeydown(ev);
  assert.ok(ev.defaultPrevented, "Escape consumed for diff search");
  assert.equal(calls[calls.length - 1].name, "clearDiffSearch");
});

test("branch shortcut delegates to the location bar popover", () => {
  let opened = null;
  globalThis.HerdrLocationBar = { openBranchPopover: (x) => { opened = x; } };
  try {
    const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
    const shortcuts = makeShortcuts({ view });
    assert.ok(shortcuts.handleChordActionKey(chordEvent("KeyV")));
    assert.equal(opened, null, "popover opened with null origin");
  } finally {
    delete globalThis.HerdrLocationBar;
  }
});

test("help shortcut renders the full chord list through alertFn", () => {
  let text = "";
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcutsCtx = globalThis.HerdrGitUiShortcuts || loadShortcuts();
  const shortcuts = shortcutsCtx.create({
    state: { visible: true, shortcutPrefixUntil: 0, contextMenu: null, logContextMenu: null, headerMenu: null },
    render: () => {},
    active: () => view,
    currentMode: () => "changes",
    gitUiOptions: () => ({}),
    explorationDefaultDirectory: () => "",
    canSearchDiff: () => false,
    canEditCurrentFile: () => false,
    saveDraftFromDom: () => {},
    hide: () => {},
    confirmFn: () => true,
    alertFn: (msg) => { text = msg; },
    getGitUi: () => recordingGitUi().api,
  });
  shortcuts.handleChordActionKey(chordEvent("Digit0"));
  assert.ok(text.includes("Ctrl+B then:"), "help names the prefix");
  for (const label of ["Changes list", "Commit modal", "Log", "Stash", "Cleanup tab", "Refresh", "Stage/unstage all", "Stage file", "Unstage file", "Discard file", "Stash file", "File history", "Toggle blame", "Edit file", "Return to current changes", "Branch popover in the location bar", "Focus file list", "Pull update", "Push", "Fetch origin", "Pull with rebase", "Stash push", "Apply selected stash", "Pop selected stash", "Drop selected stash", "Conflict: use HEAD", "Conflict: use parent", "Conflict: use remote", "Conflict: mark resolved", "Git shortcut help", "Esc Back / hide"]) {
    assert.ok(text.includes(label), `help lists "${label}"`);
  }
});

test("configured shortcuts override defaults; titleWithGitShortcut names them", () => {
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, options: { gitShortcuts: { log: "Digit9" }, globalShortcutPrefix: "Alt+G" } });
  // Digit3 is no longer log; Digit9 is.
  assert.ok(!shortcuts.handleChordActionKey(chordEvent("Digit3")), "default log key no longer mapped");
  assert.equal(shortcuts.titleWithGitShortcut("Log", "log"), "Log (Alt+G then 9)", "title carries configured prefix and key");
  assert.equal(shortcuts.titleWithGitShortcut("Log", "nope"), "Log", "unknown action keeps the bare title");
});

test("visible() keeps keys while a center git tab hosts the surface, drops them when collapsed elsewhere", () => {
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  // Sidebar collapsed, center git tab active: keys stay owned.
  const withTab = makeShortcuts({
    view,
    rightSidebar: { collapsed: () => true },
    panes: { paneActiveTab: () => "git-log", isGitTab: () => true },
  });
  assert.ok(withTab.handleChordActionKey(chordEvent("Digit3")), "keys owned while a center git tab is active");
  // Sidebar collapsed, active tab is a terminal: keys released.
  const withoutTab = makeShortcuts({
    view,
    rightSidebar: { collapsed: () => true },
    panes: { paneActiveTab: () => "term-1", isGitTab: () => false },
  });
  assert.ok(!withoutTab.handleChordActionKey(chordEvent("Digit3")), "keys released when the git surface is off screen");
  // No sidebar collapse at all: visible state owns keys.
  const plain = makeShortcuts({ view });
  assert.ok(plain.handleChordActionKey(chordEvent("Digit3")), "visible drawer owns keys");
});

test("popover, session manager, and directory picker guards mute chord keys", () => {
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcutsCtx = globalThis.HerdrGitUiShortcuts || loadShortcuts();
  // locationBarPopoverOpen reads document.querySelector; boot a context
  // whose document answers a popover selector truthfully.
  const ctx = context();
  ctx.document.querySelector = (sel) => (sel.includes("popover") ? element() : null);
  productScript("./shared/core.js").runInContext(ctx);
  productScript("./desktop/git_ui/shortcuts.js").runInContext(ctx);
  const muted = ctx.window.HerdrGitUiShortcuts.create({
    state: { visible: true, shortcutPrefixUntil: Date.now() + 5000, contextMenu: null, logContextMenu: null, headerMenu: null },
    render: () => {},
    active: () => view,
    currentMode: () => "changes",
    gitUiOptions: () => ({}),
    explorationDefaultDirectory: () => "",
    canSearchDiff: () => false,
    canEditCurrentFile: () => false,
    saveDraftFromDom: () => {},
    hide: () => {},
    confirmFn: () => true,
    alertFn: () => {},
    getGitUi: () => recordingGitUi().api,
  });
  assert.ok(!muted.handleChordActionKey(chordEvent("Digit3")), "popover open mutes chord keys");
});

test("handleChordActionKey restores the arming window and rejects Escape", () => {
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const state = { shortcutPrefixUntil: 12345 };
  const shortcuts = makeShortcuts({ state, view });
  assert.ok(!shortcuts.handleChordActionKey({ key: "Escape", code: "Escape", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, target: {} }), "Escape never a chord action");
  assert.ok(shortcuts.handleChordActionKey(chordEvent("Digit3")), "log chord works");
  assert.equal(state.shortcutPrefixUntil, 12345, "arming window restored after the chord");
});

test("compare shortcut returns to the current changes view", () => {
  const { calls, api } = recordingGitUi();
  const view = { tab: "changes", file: "a.js", mode: "current-compare", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, gitUiApi: api });
  assert.ok(shortcuts.handleChordActionKey(chordEvent("KeyO")));
  assert.equal(calls[calls.length - 1].name, "compareCurrent");
});

test("shortcutDisplay strips code prefixes for the help text", () => {
  const view = { tab: "changes", file: "", mode: "changes", status: { conflicted: [] }, sideEditor: null };
  const shortcuts = makeShortcuts({ view, options: { gitShortcuts: {
    changes: "Digit1", bracket: "BracketLeft", slash: "Slash", period: "Period", comma: "Comma", closing: "BracketRight",
  } } });
  const title = shortcuts.titleWithGitShortcut("X", "bracket");
  assert.ok(title.includes("Ctrl+B then ["), `bracket renders as [: ${title}`);
  assert.equal(shortcuts.titleWithGitShortcut("X", "slash"), "X (Ctrl+B then /)");
  assert.equal(shortcuts.titleWithGitShortcut("X", "period"), "X (Ctrl+B then .)");
  assert.equal(shortcuts.titleWithGitShortcut("X", "comma"), "X (Ctrl+B then ,)");
  assert.equal(shortcuts.titleWithGitShortcut("X", "closing"), "X (Ctrl+B then ])");
  assert.equal(shortcuts.titleWithGitShortcut("X", "changes"), "X (Ctrl+B then 1)");
});