import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Behavioral test for the terminal reconnect backoff (resize-storm fix).
// Loads desktop/app_js/terminal.js in a sandbox with stubbed DOM/WS/state
// and drives connectTerminal through: healthy attach -> backend death ->
// frame-cadence reconnect attempts must be suppressed by the backoff.

function loadTerminalModule() {
  const source = readFileSync(
    new URL("./desktop/app_js/terminal.js", import.meta.url),
    "utf8",
  );
  const __stubEl = () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
    innerHTML: "",
    querySelectorAll: () => [],
    appendChild: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    setAttribute: () => {},
    getAttribute: () => null,
    clientWidth: 800,
    clientHeight: 600,
    offsetWidth: 800,
    offsetHeight: 600,
    scrollTop: 0,
    scrollHeight: 600,
    dataset: {},
    hidden: false,
    textContent: "",
  });
  const sandbox = {
    console,
    // Controllable timers: capture schedules without running them; tests
    // advance time explicitly via __flushTimer.
    setTimeout: (fn, ms) => {
      sandbox.__timers = sandbox.__timers || [];
      sandbox.__timers.push({ fn, ms });
      return sandbox.__timers.length;
    },
    clearTimeout: (id) => {
      sandbox.__timers = sandbox.__timers || [];
      if (id) sandbox.__timers[id - 1] = null;
    },
    performance: { now: () => sandbox.__now },
    requestAnimationFrame: (fn) => { sandbox.__raf = fn; return 1; },
    cancelAnimationFrame: () => {},
    navigator: {},
    location: { protocol: "https:", host: "127.0.0.1:8899", href: "https://127.0.0.1:8899/" },
    document: {
      hidden: false,
      visibilityState: "visible",
      getElementById: () => null,
      createElement: () => __stubEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: __stubEl(),
      documentElement: __stubEl(),
      fonts: { load: async () => [], ready: Promise.resolve() },
    },
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    state: {},
    options: {},
    el: __stubEl,
    api: async () => ({}),
    wsUrl: (path) => "ws://test" + path,
    currentSessionBackend: () => "external-herdr",
    sessionBackendLabel: (b) => b,
    backendEnabled: () => true,
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
    focusTerminal: () => {},
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
    HerdrGitUi: { hide: () => {}, isVisible: () => false },
    HerdrTerminalRenderer: {
      create: async () => ({
        clear: () => {},
        dispose: () => {},
        resize: () => {},
        write: () => {},
        element: { addEventListener: () => {}, removeEventListener: () => {} },
      }),
    },
    HerdrTerminalFit: {
      cellSize: () => ({ width: 9, height: 17 }),
      gridSize: () => ({ cols: 80, rows: 24 }),
    },
    __now: 0,
    __raf: null,
    sockets: [],
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.binaryType = "";
        this.sent = [];
        sandbox.sockets.push(this);
        if (typeof sandbox.__wsOnConstruct === "function") {
          sandbox.__wsOnConstruct(this);
        }
      }
      send(data) { this.sent.push(data); }
      close() {
        if (this.onclose) this.onclose();
        this.readyState = 3;
      }
      __open() {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }
    },
  };
  sandbox.window = sandbox;
  sandbox.window = new Proxy(sandbox, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
  sandbox.globalThis = sandbox;
  // terminal.js is a fragment of the concatenated desktop bundle: its
  // module-scoped `let` variables (termWs, term, connectedTerminalId, ...)
  // are declared in core.js, which is NOT loaded here. Declare them in the
  // sandbox so terminal.js's assignments and reads resolve.
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
    const terminal = { addEventListener: () => {}, style: {} };
    function resetTerminalConnection() {}
    function setTerminalLoading() {}
    function render() {}
    function fitTerminalShell() {}
    function fitTerminalSurface() {}
    function focusTerminal() {}
    function setTerminalFollowPaused() {}
    function hideTerminalPasteProgress() {}
    function scrollTerminalToBottom() {}
    function sendInputData() {}
    function sendPasteToTerminal() {}
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
  vm.runInContext(source, sandbox, { filename: "terminal.js" });
  const run = (expr) => vm.runInContext(expr, sandbox);
  // Run the oldest pending timer and advance the fake clock past its ms.
  const flushTimer = () => {
    const timers = sandbox.__timers || [];
    const pending = timers.find((t) => t && !t.fired);
    if (!pending) return false;
    pending.fired = true;
    if (typeof pending.ms === "number") sandbox.__now += pending.ms + 1;
    pending.fn();
    return true;
  };
  return {
    sandbox,
    run,
    runAsync: (expr) => vm.runInContext(expr, sandbox).then(() => {}),
    flushTimer,
  };
}

describe("terminal reconnect backoff", () => {
  it("healthy attach wires the success/failure notes", async () => {
    const { sandbox, run, runAsync } = loadTerminalModule();
    // Select a pane so state.terminalId is set and connectTerminal runs.
    run(`state.ws = "w1"; state.tab = "w1:t1"; state.pane = "w1:t1:p1"; state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    await runAsync(`connectTerminal()`);
    equal(sandbox.sockets.length, 1, "first connect creates one WS");
    const ws = sandbox.sockets[0];
    ws.__open();
    sandbox.__wsRef = ws;
    ok(run(`termWs === __wsRef`), "termWs is the opened socket");
    // First data frame resets the backoff.
    ws.onmessage({ data: new Uint8Array([104, 105]) });
    equal(run(`terminalReconnectDelay`), 500, "backoff reset to base after data frame");
  });

  it("backend death suppresses frame-cadence reconnect attempts", async () => {
    const { sandbox, run, runAsync } = loadTerminalModule();
    run(`state.ws = "w1"; state.tab = "w1:t1"; state.pane = "w1:t1:p1"; state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    await runAsync(`connectTerminal()`);
    const ws = sandbox.sockets[0];
    ws.__open();
    // Backend dies: socket closes without any data frame (onclose fires).
    ws.readyState = 3;
    ws.onclose();
    equal(run(`terminalReconnectDelay`), 1000, "failure doubles the base delay");
    equal(run(`terminalReconnectTarget !== null`), true, "failure pins the target");
    // Frame-cadence resize attempts: 20 reconnects in a row must all be
    // gated (no new sockets) while the backoff window is active.
    sandbox.__now = sandbox.__now + 50;
    for (let i = 0; i < 20; i++) {
      run(`connectTerminal()`);
    }
    equal(sandbox.sockets.length, 1, "no reconnect attempts during backoff window");
  });

  it("backoff only gates the failed target", async () => {
    const { sandbox, run, runAsync } = loadTerminalModule();
    run(`state.ws = "w1"; state.tab = "w1:t1"; state.pane = "w1:t1:p1"; state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    await runAsync(`connectTerminal()`);
    const ws = sandbox.sockets[0];
    ws.__open();
    ws.readyState = 3;
    ws.onclose();
    // Navigate to a different pane: must attach immediately despite backoff.
    sandbox.__now = sandbox.__now + 50;
    run(`state.pane = "w1:t1:p2";`);
    await runAsync(`connectTerminal()`);
    equal(sandbox.sockets.length, 2, "different target bypasses the backoff gate");
  });

  it("recovery attempt in flight blocks resize frames (no connecting-window churn)", async () => {
    const { sandbox, run, runAsync, flushTimer } = loadTerminalModule();
    run(`state.ws = "w1"; state.tab = "w1:t1"; state.pane = "w1:t1:p1"; state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    await runAsync(`connectTerminal()`);
    const first = sandbox.sockets[0];
    first.__open();
    // Backend dies.
    first.readyState = 3;
    first.onclose();
    // Backoff window elapses: scheduled reconnect fires a recovery attempt
    // that stays CONNECTING (backend dead, no open, no close yet).
    flushTimer();
    equal(sandbox.sockets.length, 2, "timer fired one recovery attempt");
    sandbox.__now = sandbox.__now + 50;
    // Resize frames during the connecting window must all be gated.
    for (let i = 0; i < 20; i++) {
      run(`connectTerminal()`);
    }
    equal(sandbox.sockets.length, 2, "connecting-window resize frames did not churn sockets");
    // Attempt settles with failure: next backoff window opens, then a new
    // attempt is allowed.
    const attempt = sandbox.sockets[1];
    attempt.readyState = 3;
    attempt.onclose();
    flushTimer();
    equal(sandbox.sockets.length, 3, "after settle, next window allows one attempt");
  });
});