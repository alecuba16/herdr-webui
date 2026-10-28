import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Behavioral tests for the chat/terminal focus + paste routing fix.
// Loads desktop/app_js/terminal.js in the same sandbox style as
// terminal_reconnect_backoff.test.mjs and drives the two surfaces the
// bug interleaves: the terminal paste takeover on #terminalShell and
// focusTerminal's gate while the chat lens is open.
//
// Bug being pinned (bug_chat_terminal_paste_inputfocus):
// 1. focusTerminal() ran on every poll-driven connectTerminal() even
//    while the chat lens covered the terminal, parking the caret on
//    the hidden wterm textarea: typing meant for chat landed in the
//    pane's pty, and paste went with it.
// 2. The capture-phase paste listener on #terminalShell claimed every
//    paste event bubbling inside the shell regardless of focus, so a
//    paste with the composer focused still went to the terminal.
// 3. The document-level Cmd/Ctrl+V fallback did the same from outside
//    the shell.

async function loadTerminalModule() {
  const source = readFileSync(
    new URL("./desktop/app_js/terminal.js", import.meta.url),
    "utf8",
  );
  const listenersByNode = new Map();
  const makeNode = (id) => {
    const node = {
      id,
      listeners: {},
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      classList: {
        contains: () => false,
        add() {},
        remove() {},
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
      querySelector() {
        return null;
      },
      focus() {},
      setAttribute() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }),
      clientWidth: 800,
      clientHeight: 600,
      offsetWidth: 800,
      offsetHeight: 600,
      scrollTop: 0,
      scrollHeight: 600,
      textContent: "",
    };
    // updateTerminalPasteProgress drives the bar through
    // style.setProperty("--paste-progress", ...); plain objects lack it.
    node.style.setProperty = (name, value) => {
      node.style.__props = node.style.__props || {};
      node.style.__props[name] = value;
    };
    listenersByNode.set(node, node.listeners);
    return node;
  };
  const nodes = {
    terminalShell: makeNode("terminalShell"),
    terminal: makeNode("terminal"),
    terminalLoading: makeNode("terminalLoading"),
    terminalFollowButton: makeNode("terminalFollowButton"),
    terminalPasteProgress: makeNode("terminalPasteProgress"),
    terminalPasteProgressLabel: makeNode("terminalPasteProgressLabel"),
    terminalPasteProgressBar: makeNode("terminalPasteProgressBar"),
  };
  const sandbox = {
    console,
    TextEncoder,
    setTimeout: (fn) => {
      sandbox.__timers = sandbox.__timers || [];
      sandbox.__timers.push(fn);
      return sandbox.__timers.length;
    },
    clearTimeout: () => {},
    clearTimeoutNoop: true,
    requestAnimationFrame: (fn) => {
      sandbox.__raf = fn;
      return 1;
    },
    cancelAnimationFrame: () => {},
    performance: { now: () => (sandbox.__now = (sandbox.__now || 0) + 1) },
    navigator: {},
    location: { protocol: "https:", host: "127.0.0.1:8899" },
    document: {
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      createElement: () => makeNode("anon"),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: makeNode("body"),
      documentElement: makeNode("html"),
      fonts: { load: async () => [], ready: Promise.resolve() },
      activeElement: null,
    },
    IntersectionObserver: undefined,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    state: {
      editingTab: null,
      editingWorkspace: null,
      session: "default",
      ws: "w1",
      tab: "w1:t1",
      pane: "w1:t1:p1",
      terminalId: "term_1",
      termCols: 100,
      termRows: 30,
      panes: [],
    },
    options: { shiftEnterNewline: true },
    el: (id) => nodes[id] || null,
    api: async () => ({}),
    wsUrl: (path) => "ws://test" + path,
    currentSessionBackend: () => "builtin",
    backendEnabled: () => true,
    globalThis: null,
    HerdrLens: null,
    HerdrComposer: null,
    HerdrPromptCards: null,
    HerdrGitUi: { hide: () => {}, isVisible: () => false },
    // The renderer stub hands back the term stub so connectTerminal's
    // !term branch completes and the shell listeners register.
    HerdrTerminalRenderer: { create: async () => sandbox.__termStub },
    HerdrTerminalFit: { cellSize: () => ({ width: 9, height: 17 }) },
    handleHerdrErrorFrame: async () => false,
    rememberWorkspaceShellMode: () => {},
    scheduleRefresh: () => {},
    scheduleRefreshBurst: () => {},
    flushTerminalFrames: () => {},
    flushTerminalFramesFor: () => {},
    setTerminalLoading: () => {},
    setTerminalFollowPaused: () => {},
    hideTerminalPasteProgress: () => {},
    scrollTerminalToBottom: () => {},
    sendInputData: () => {},
    sendPasteToTerminal: () => {},
    shiftEnterSequence: () => "",
    handleCloseShortcut: () => false,
    handleTerminalWheel: () => {},
    handleTerminalTouchStart: () => {},
    handleTerminalTouchMove: () => {},
    handleTerminalTouchEnd: () => {},
    browserTerminalSize: () => null,
    shouldFitFocusedWebTerminal: () => false,
    shouldAutoFitDetachedTerminal: () => false,
    applyBrowserTerminalSize: () => false,
    fitTerminalShell: () => {},
    fitTerminalSurface: () => {},
    applyTerminalFont: () => {},
    terminalTheme: () => ({}),
    terminalFontFamily: () => "monospace",
    refreshTerminalAfterFontLoad: () => {},
    applyTerminalLinks: () => {},
    applyTheme: () => {},
    enqueueTerminalFrame: () => {},
    render: () => {},
    go: () => {},
    applyLayoutUpdated: () => {},
    __now: 0,
    __raf: null,
    __focusCalls: 0,
    __sockets: [],
    __timers: [],
    // Sockets auto-open: the real sendPasteToTerminal early-returns unless
    // termWs.readyState === 1, so tests that assert the paste actually
    // reached the wire need an OPEN stub from the start. onopen fires on
    // the next microtask so connectTerminal's await can finish first.
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.bufferedAmount = 0;
        sandbox.__sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          if (this.onopen) this.onopen();
        });
      }
      send(data) { this.sent.push(data); }
      close() { this.readyState = 3; }
    },
  };
  sandbox.window = new Proxy(sandbox, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
  sandbox.globalThis = sandbox;
  // term stub: focus() records calls; element = the terminal container
  // node so the paste guard's contains() check mirrors the real adapter.
  const termStub = {
    clear: () => {},
    dispose: () => {},
    resize: () => {},
    write: () => {},
    scrollToBottom: () => {},
    getSelection: () => "",
    focus: () => { sandbox.__focusCalls += 1; },
    element: nodes.terminal,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.__sandboxTerminal = nodes.terminal;
  sandbox.__termStub = termStub;
  sandbox.__pasteSent = [];
  vm.createContext(sandbox);
  vm.runInContext(
    `
    let term = null;
    let termWs = null;
    let eventWs = null;
    let terminalLinkProvider = null;
    let hiddenTimer = null;
    let refreshTimer = null;
    let connectedTerminalId = null;
    let connectedSize = "";
    let termScrollBound = false;
    let terminalViewportScrollElement = null;
    let inputFlushTimer = null;
    let inputQueue = [];
    let inputQueueMaxBufferedAmount = 65536;
    let terminalQueryReplyState = {};
    let pasteChunkTimer = null;
    let pasteProgressHideTimer = null;
    let pasteJob = null;
    let terminalWriteQueue = [];
    let terminalWriteFlushPending = false;
    let terminalFramePending = false;
    let herdrErrorOfferPending = false;
    // core.js owns inputEncoder in the real bundle; the sandbox runs
    // terminal.js alone, so the paste chunk pipeline needs it here.
    const inputEncoder = new TextEncoder();
    const terminal = __sandboxTerminal;
    function resetTerminalConnection() {}
    function setTerminalLoading() {}
    function render() {}
    function fitTerminalShell() {}
    function fitTerminalSurface() {}
    function setTerminalFollowPaused() {}
    function hideTerminalPasteProgress() {}
    function scrollTerminalToBottom() {}
    function sendInputData() {}
    // terminal.js declares its own sendPasteToTerminal; any stub here is
    // shadowed by hoisting. Tests observe the real chunked pipeline via
    // the stub socket's sent buffer instead of __pasteSent.
    function shiftEnterSequence() { return ""; }
    function handleCloseShortcut() { return false; }
    function flushTerminalFrames() {}
    function flushTerminalFramesFor() {}
    function enqueueTerminalFrame() {}
    function clearDismissedWorkingForTerminal() {}
    function showTerminalWorking() {}
    function hideTerminalWorking() {}
    function terminalViewportForTarget() { return null; }
    function handleHerdrErrorFrame() { return false; }
    function scheduleTerminalPoke() {}
    function updateTerminalZoomBadge() {}
    function bindTerminalViewportScroll() {}
    `,
    sandbox,
    { filename: "core-fragment.js" },
  );
  // term stub inject and source load: the context fragment declared the
  // module-scoped bindings; assign the stub through the sandbox so
  // terminal.js's `term` variable picks it up.
  vm.runInContext(`term = __termStub;`, sandbox);
  vm.runInContext(source, sandbox, { filename: "terminal.js" });
  // One connect pass registers the shell listeners (paste/keydown live
  // inside connectTerminal's !termScrollBound block) and opens the stub
  // socket without needing the renderer.
  await vm.runInContext("connectTerminal()", sandbox);
  // The stub socket opens on a microtask; let onopen settle so termWs is
  // OPEN and the paste chunk pipeline can actually flush.
  await new Promise((resolve) => setImmediate(resolve));
  const run = (expr) => vm.runInContext(expr, sandbox);
  const attachSocket = () =>
    sandbox.__sockets.find(
      (socket) => socket.url && socket.url.includes("/ws/terminal"),
    );
  const flushStubTimers = () => {
    const timers = sandbox.__timers.splice(0);
    for (const timer of timers) timer();
  };
  // Drives the real chunked paste pipeline to completion: each flush
  // chunk run may re-arm a setTimeout (buffer-limit/flush-delay pacing);
  // draining until the queue empties mimics the event loop.
  const drainPastePipeline = () => {
    for (let i = 0; i < 20 && sandbox.__timers.length; i++) flushStubTimers();
  };
  const pastedText = () => {
    const socket = attachSocket();
    if (!socket) return "";
    // scroll-to-bottom sync (sendBackendTail) also writes to the socket;
    // only paste chunks are Uint8Array payloads.
    return socket.sent
      .filter((chunk) => chunk instanceof Uint8Array)
      .map((chunk) => Buffer.from(chunk).toString("utf8"))
      .join("");
  };
  const firePaste = (target, clipboardText, activeElement) => {
    sandbox.document.activeElement = activeElement || null;
    let defaultPrevented = false;
    let immediateStopped = false;
    const event = {
      target,
      currentTarget: nodes.terminalShell,
      clipboardData: { getData: () => clipboardText },
      preventDefault: () => { defaultPrevented = true; },
      stopImmediatePropagation: () => { immediateStopped = true; },
    };
    for (const { handler } of nodes.terminalShell.listeners.paste || []) {
      handler(event);
    }
    return { defaultPrevented, immediateStopped };
  };
  return {
    sandbox,
    nodes,
    termStub,
    run,
    firePaste,
    attachSocket,
    drainPastePipeline,
    pastedText,
    setLensActive(active) {
      sandbox.HerdrLens = active
        ? { isActive: () => true }
        : null;
    },
  };
}

describe("chat/terminal focus + paste routing (bug_chat_terminal_paste_inputfocus)", () => {
  it("focusTerminal is a no-op while the chat lens is open, even forced", async () => {
    const { sandbox, run, setLensActive } = await loadTerminalModule();
    setLensActive(true);
    sandbox.__focusCalls = 0;
    run(`focusTerminal()`);
    equal(sandbox.__focusCalls, 0, "poll-driven focus must not steal the caret in chat mode");
    run(`focusTerminal(true)`);
    equal(sandbox.__focusCalls, 0, "forced focus must not steal the caret in chat mode either");
    setLensActive(false);
    run(`focusTerminal(true)`);
    equal(sandbox.__focusCalls, 1, "with the lens closed, forced focus returns typing to the terminal");
  });

  it("paste takeover stays silent while the chat lens is open", async () => {
    const { nodes, firePaste, setLensActive, sandbox, pastedText, drainPastePipeline } = await loadTerminalModule();
    setLensActive(true);
    const result = firePaste(nodes.terminalShell, "hello from chat");
    equal(result.defaultPrevented, false, "no preventDefault in chat mode");
    equal(result.immediateStopped, false, "no stopImmediatePropagation in chat mode");
    drainPastePipeline();
    equal(pastedText(), "", "clipboard never reaches the pty in chat mode");
  });

  it("paste takeover stays silent when the composer input owns focus", async () => {
    const { nodes, firePaste, setLensActive, pastedText, drainPastePipeline } = await loadTerminalModule();
    setLensActive(false);
    const composerInput = { tagName: "TEXTAREA", isContentEditable: false };
    const result = firePaste(nodes.terminalShell, "message text", composerInput);
    equal(result.defaultPrevented, false, "composer-focused paste is not hijacked");
    drainPastePipeline();
    equal(pastedText(), "", "composer-focused paste never reaches the pty");
  });

  it("paste takeover still claims terminal-owned focus (wterm textarea)", async () => {
    const { nodes, firePaste, setLensActive, termStub, pastedText, drainPastePipeline } = await loadTerminalModule();
    setLensActive(false);
    // The wterm textarea lives inside term.element: the chunked-paste
    // pipeline must keep claiming it. Mirror DOM contains semantics
    // (node.contains(node) === true) so the container check walks the
    // fake tree like the real one.
    const wtermTextarea = {
      tagName: "TEXTAREA",
      isContentEditable: false,
      children: [],
      contains(candidate) {
        return candidate === wtermTextarea;
      },
    };
    termStub.element.children.push(wtermTextarea);
    const result = firePaste(nodes.terminalShell, "big payload", wtermTextarea);
    equal(result.defaultPrevented, true, "terminal-surface paste is still claimed");
    drainPastePipeline();
    equal(pastedText(), "big payload", "terminal-surface paste still routes to the pty");
  });

  it("paste takeover still works with no focused element (terminal visible)", async () => {
    const { nodes, firePaste, setLensActive, pastedText, drainPastePipeline } = await loadTerminalModule();
    setLensActive(false);
    const result = firePaste(nodes.terminalShell, "shell paste", null);
    equal(result.defaultPrevented, true, "body-level paste on the terminal surface is claimed");
    drainPastePipeline();
    equal(pastedText(), "shell paste");
  });
});