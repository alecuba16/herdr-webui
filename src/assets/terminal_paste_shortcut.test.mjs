import { describe, it } from "node:test";
import { equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Compiled once so coverage attributes bindings.js lines to the real file.
let bindingsScript = null;
function getBindingsScript() {
  if (!bindingsScript) {
    const bindingsPath = fileURLToPath(new URL("./desktop/app_js/bindings.js", import.meta.url));
    bindingsScript = new vm.Script(readFileSync(bindingsPath, "utf8"), { filename: bindingsPath });
  }
  return bindingsScript;
}

// Behavioral test for the document-level paste shortcut in bindings.js.
// The Cmd/Ctrl+V handler used to call pasteClipboard() even while the
// chat lens was open, reading the clipboard and pushing it into the
// hidden terminal pty (bug_chat_terminal_paste_inputfocus, surface 3).
// The lens-open guard must stop that read before any clipboard access.
//
// bindings.js is the last module of the concatenated DESKTOP_JS bundle:
// it runs against the whole shared scope (term, pasteClipboard, ...),
// so the sandbox here declares the module-scope bindings the fragment
// references, in the same style as terminal_focus_paste.test.mjs.

async function loadBindingsModule() {
  const bindingsScript = getBindingsScript();
  const makeNode = (id) => {
    const node = {
      id,
      listeners: {},
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      hidden: false,
      checked: false,
      value: "",
      disabled: false,
      textContent: "",
      innerHTML: "",
      classList: {
        contains: () => false,
        add() {},
        remove() {},
        toggle() {},
      },
      addEventListener(type, handler, capture) {
        (node.listeners[type] = node.listeners[type] || []).push({
          handler,
          capture: !!capture,
        });
      },
      removeEventListener() {},
      appendChild(child) {
        node.children.push(child);
        child.parentNode = node;
        return child;
      },
      contains(candidate) {
        if (candidate === node) return true;
        return node.children.some((child) => child.contains(candidate));
      },
      closest() {
        return null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      focus() {},
      click() {},
      setAttribute() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }),
      clientWidth: 800,
      clientHeight: 600,
      offsetWidth: 800,
      offsetHeight: 600,
      offsetParent: null,
      scrollTop: 0,
      scrollHeight: 600,
    };
    return node;
  };
  const nodes = {};
  const nodeFor = (id) => (nodes[id] = nodes[id] || makeNode(id));
  // Element ids bindings.js dereferences at load time (el("x").onclick = ...)
  // must exist before the module runs.
  [
    "settingsToggle", "shortcutsToggle", "settingsClose", "settingsModal",
    "worktreeOpenRefresh", "worktreeOpenInput", "worktreeOpenSubmit",
    "worktreeOpenBrowse", "worktreeCreateName", "worktreeCreateCwd",
    "worktreeCreateBrowse", "worktreeCreateSubmit", "worktreeCreateCancel",
    "terminalFollowButton", "optTerminalCore", "optSidebarWorkspacePercent",
    "sidebarSplitHandle", "optNotificationVolume", "versions", "workspaces",
    "agents", "questionModal", "workspaceCreateModal", "worktreeOpenModal",
    "worktreeCreateModal", "searchPalette", "workspaceCreateName",
    "workspaceCreateBrowse", "workspaceCreateSubmit", "workspaceCreateCancel",
    "workspaceCreateDismiss", "workspaceCreateInit",
  ].forEach(nodeFor);
  const keydownListeners = [];
  const sandbox = {
    console,
    TextEncoder,
    setTimeout: (fn) => {
      sandbox.__timers = sandbox.__timers || [];
      sandbox.__timers.push(fn);
      return sandbox.__timers.length;
    },
    clearTimeout: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance: { now: () => (sandbox.__now = (sandbox.__now || 0) + 1) },
    navigator: { clipboard: { readText: async () => "clipboard text" } },
    location: {
      protocol: "https:",
      host: "127.0.0.1:8899",
      pathname: "/session/default",
      search: "",
      hash: "",
    },
    history: { pushState() {}, replaceState() {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      hidden: false,
      activeElement: null,
      title: "",
      getElementById: (id) => nodeFor(id),
      createElement: () => makeNode("anon"),
      createTextNode: () => makeNode("anon"),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(type, handler) {
        if (type === "keydown") keydownListeners.push(handler);
      },
      removeEventListener() {},
      body: makeNode("body"),
      documentElement: makeNode("html"),
      fonts: { load: async () => [], ready: Promise.resolve() },
      visibilityState: "visible",
    },
    window: {},
    state: {
      editingTab: null,
      editingWorkspace: null,
      session: "default",
      ws: "w1",
      tab: "w1:t1",
      pane: "w1:t1:p1",
      terminalId: "term_1",
      panes: [],
      layout: "desktop",
    },
    options: { shiftEnterNewline: true },
    el: (id) => nodeFor(id),
    api: async () => ({}),
    wsUrl: (path) => "ws://test" + path,
    currentSessionBackend: () => "builtin",
    backendEnabled: () => true,
    // Track pasteClipboard calls: the bug is the clipboard read firing at
    // all with the lens open, not what it sends afterwards.
    __pasteCalls: 0,
    HerdrLens: null,
    HerdrSkeleton: null,
    HerdrSettingsSections: null,
    HerdrDirectoryPicker: { attach: () => {} },
    HerdrGitUi: { hide: () => {}, isVisible: () => false },
    __now: 0,
    __timers: [],
  };
  // window proxies to the sandbox so globalThis lookups resolve; the
  // addEventListener on window (closeShortcutKeydown, handleGlobalShortcut)
  // must not throw during load.
  sandbox.window = new Proxy(sandbox, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      if (prop === "matchMedia") return () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      if (prop === "HerdrLens") return target.HerdrLens;
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  sandbox.globalThis = sandbox;
  // The core fragment reads __el for the workspaces/agents top-level
  // consts; expose it before the fragment runs (same injection pattern
  // as __sandboxTerminal in terminal_focus_paste.test.mjs).
  sandbox.__el = sandbox.el;
  // Auto-stub fallback: bindings.js touches dozens of settings/UI
  // helpers from earlier bundle modules at load time (registerSettingsCommit,
  // discoverWorktrees, HerdrSkeleton...). None matter to the paste
  // shortcut; a Proxy global with a has() trap turns every unknown
  // identifier into a no-op function so the load pass succeeds without
  // maintaining a 90-entry stub list. The core fragment MUST run in this
  // same context: script-level const/function declarations live in the
  // context's lexical scope, and a second context (even proxying the same
  // object) would not see them.
  const realHas = Reflect.has;
  const autoStub = new Proxy(sandbox, {
    has(target, prop) {
      if (realHas(target, prop)) return true;
      if (typeof prop === "string") return true; // unknown ids "exist" as stubs
      return false;
    },
    get(target, prop) {
      if (realHas(target, prop)) return target[prop];
      if (typeof prop === "string") {
        const stub = function stub() { return undefined; };
        sandbox[prop] = stub;
        return stub;
      }
      return undefined;
    },
  });
  vm.createContext(autoStub);
  vm.runInContext(
    `
    // Module-scope bindings from the bundle's earlier modules that the
    // paste-shortcut handler closes over. bindings.js runs last in the
    // bundle, so every identifier it references resolves in this shared
    // scope; anything NOT stubbed here falls through to the proxy
    // fallback above (auto-stub), which keeps this list to what the
    // handler under test actually observes.
    let term = null;
    function pasteClipboard() { __pasteCalls += 1; }
    // Iterated at load (for..of): the auto-stub's function default is
    // not iterable, so the settings module list starts empty here.
    const settingsModules = [];
    const workspaces = __el("workspaces");
    const agents = __el("agents");
    `,
    autoStub,
    { filename: "core-fragment.js" },
  );
  bindingsScript.runInContext(autoStub);
  const firePasteShortcut = ({ lensActive, editableTarget, hasSelection = false }) => {
    sandbox.HerdrLens = lensActive ? { isActive: () => true } : null;
    sandbox.__pasteCalls = 0;
    let prevented = false;
    // term.getSelection gates the copy branch; with a null term the
    // paste branch is the one under test.
    const event = {
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: editableTarget || { tagName: "BODY", isContentEditable: false },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    };
    for (const handler of keydownListeners) handler(event);
    return { prevented, pasteCalls: sandbox.__pasteCalls };
  };
  return { sandbox, firePasteShortcut };
}

describe("document paste shortcut vs the chat lens (bug_chat_terminal_paste_inputfocus)", () => {
  it("Cmd+V with the lens open never reaches the terminal clipboard read", async () => {
    const { firePasteShortcut } = await loadBindingsModule();
    const result = firePasteShortcut({ lensActive: true });
    equal(result.prevented, false, "lens-open Cmd+V is not hijacked by the terminal handler");
    equal(result.pasteCalls, 0, "pasteClipboard never fires while the lens is open");
  });

  it("Cmd+V with the lens closed still routes to the terminal clipboard", async () => {
    const { firePasteShortcut } = await loadBindingsModule();
    const result = firePasteShortcut({ lensActive: false });
    equal(result.prevented, true, "lens-closed Cmd+V is claimed by the terminal handler");
    equal(result.pasteCalls, 1, "pasteClipboard fires once with the lens closed");
  });

  it("Cmd+V aimed at an editable surface is ignored by the terminal handler", async () => {
    const { firePasteShortcut } = await loadBindingsModule();
    const composer = { tagName: "TEXTAREA", isContentEditable: false };
    const result = firePasteShortcut({ lensActive: false, editableTarget: composer });
    equal(result.pasteCalls, 0, "editable-target paste never reaches the terminal handler");
  });
});