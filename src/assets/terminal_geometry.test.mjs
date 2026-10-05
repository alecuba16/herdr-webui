import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Regression test for the cross-display terminal geometry bug: moving a
// browser window with an active terminal between monitors (UWQHD@1x ->
// MacBook@2x) left one rendered line overlapping another with follow-scroll
// flicker, because wterm 0.5.4 (autoResize:false) never re-measures its font
// probe on display raster changes and the app's cell-metric caches went
// stale. Minimize+restore healed it by accident (probe teardown ->
// re-attach -> renderer rebuild).
//
// The fix arms a geometry-revalidation flag on display signals (resolution
// media query change, fullscreenchange, focus) and consumes it on the
// existing scheduled resize tick: one wterm.fit() re-measure, snap-back to
// the app-owned grid, cell-cache drop. This suite drives that flow end to
// end in a vm sandbox with a mock DOM/adapter.

function makeStubElement() {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    removeChild: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    getClientRects: () => [{}],
    clientWidth: 800,
    clientHeight: 600,
    offsetWidth: 832,
    offsetHeight: 632,
    scrollTop: 0,
    scrollHeight: 600,
    dataset: {},
    hidden: false,
    textContent: "",
    classList: { add: () => {}, remove: () => {}, contains: () => false },
  };
}

// Mock adapter + wterm. The adapter tracks the app-owned grid; wterm's
// fit() re-measures and can disagree with it (display raster change),
// controlled via sandbox.__measured.
function makeMockTerm(sandbox) {
  const wterm = {
    cols: 100,
    rows: 30,
    fitCalls: 0,
    resizeCalls: [],
    fit() {
      this.fitCalls++;
      const m = sandbox.__measured || { cols: this.cols, rows: this.rows };
      if (m.cols !== this.cols || m.rows !== this.rows)
        this.resize(m.cols, m.rows);
    },
    resize(cols, rows) {
      this.resizeCalls.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
    },
  };
  return {
    element: makeStubElement(),
    wterm,
    cols: 100,
    rows: 30,
    resizeCalls: [],
    resize(cols, rows) {
      this.resizeCalls.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
      this.wterm.resize(cols, rows);
    },
    invalidateCellMetricsCalls: 0,
    invalidateCellMetrics() {
      this.invalidateCellMetricsCalls++;
    },
    cellSize() {
      return sandbox.__cellSize || { width: 9, height: 17 };
    },
  };
}

function loadTerminalModule() {
  const source = readFileSync(
    new URL("./desktop/app_js/terminal.js", import.meta.url),
    "utf8",
  );
  const sandbox = {
    console,
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
    requestAnimationFrame: (fn) => {
      sandbox.__raf = fn;
      return 1;
    },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({
      getPropertyValue: () => sandbox.__cellWidthCss || "9px",
    }),
    navigator: {},
    location: { protocol: "https:", host: "127.0.0.1:8899", href: "https://127.0.0.1:8899/" },
    document: {
      hidden: false,
      visibilityState: "visible",
      getElementById: () => null,
      createElement: () => makeStubElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: makeStubElement(),
      documentElement: makeStubElement(),
      fonts: { load: async () => [], ready: Promise.resolve() },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    state: {},
    options: {},
    el: () => null,
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
      gridSize: () => ({ cols: 100, rows: 30 }),
      invalidateCellSizeCache: () => {
        (sandbox.__fitCacheInvalidations = sandbox.__fitCacheInvalidations || []).push(1);
      },
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
      }
      send() {}
      close() {}
    },
    __now: 0,
    __raf: null,
    __timers: [],
    __measured: null,
    __cellSize: { width: 9, height: 17 },
    __cellWidthCss: "9px",
  };
  sandbox.window = new Proxy(sandbox, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // core.js fragment: declare the bundle-globals terminal.js assigns/reads.
  // terminal.js is a fragment of the concatenated desktop bundle; these
  // declarations normally live in core.js.
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
    const terminal = {
      addEventListener: () => {},
      removeEventListener: () => {},
      style: {},
      innerHTML: "",
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
      clientWidth: 800,
      clientHeight: 600,
    };
    function resetTerminalConnection() {}
    function render() {}
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
  return {
    sandbox,
    run,
    flushTimer: () => {
      const pending = (sandbox.__timers || []).find((t) => t && !t.fired);
      if (!pending) return false;
      pending.fired = true;
      if (typeof pending.ms === "number") sandbox.__now += pending.ms + 1;
      pending.fn();
      return true;
    },
    runRaf: () => {
      const fn = sandbox.__raf;
      sandbox.__raf = null;
      if (typeof fn === "function") fn();
      return !!fn;
    },
  };
}

describe("terminal display-geometry revalidation", () => {
  it("loads terminal.js in the sandbox without throwing", () => {
    const { sandbox } = loadTerminalModule();
    ok(sandbox, "sandbox created");
    equal(
      typeof sandbox.invalidateTerminalGeometry,
      "function",
      "invalidateTerminalGeometry is a global from terminal.js",
    );
  });

  it("arming the flag schedules the existing resize tick, not a new loop", () => {
    const { sandbox, run, flushTimer, runRaf } = loadTerminalModule();
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`invalidateTerminalGeometry()`);
    ok(
      sandbox.__timers.length > 0 || sandbox.__raf !== null,
      "scheduleTerminalResize queued work through the existing path",
    );
    flushTimer();
    ok(runRaf(), "raf frame scheduled and consumed");
    // Nothing re-armed the scheduler during the tick: no trailing work.
    equal(sandbox.__raf, null, "no extra raf queued after the tick");
  });

  it("consumes the flag on the tick: wterm.fit + snap-back + cache drop", () => {
    const { sandbox, run, flushTimer, runRaf } = loadTerminalModule();
    const mockTerm = makeMockTerm(sandbox);
    sandbox.__mockTerm = mockTerm;
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`term = __mockTerm`);
    // Display change: wterm's own re-measure disagrees with the app grid.
    sandbox.__measured = { cols: 99, rows: 29 };
    run(`invalidateTerminalGeometry()`);
    flushTimer();
    runRaf();
    equal(mockTerm.wterm.fitCalls, 1, "wterm.fit ran once");
    equal(mockTerm.wterm.cols, 100, "wterm snapped back to the app grid cols");
    equal(mockTerm.wterm.rows, 30, "wterm snapped back to the app grid rows");
    equal(
      mockTerm.wterm.resizeCalls.length,
      2,
      "wterm resized to its own measurement then snapped back",
    );
    ok(
      mockTerm.invalidateCellMetricsCalls >= 1,
      "adapter cell-metric cache dropped",
    );
    ok(
      (sandbox.__fitCacheInvalidations || []).length >= 1,
      "HerdrTerminalFit cache dropped",
    );
    equal(run(`terminalGeometryInvalidated`), false, "flag consumed exactly once");
  });

  it("no snap-back resize when wterm.fit() agrees with the app grid", () => {
    const { sandbox, run, flushTimer, runRaf } = loadTerminalModule();
    const mockTerm = makeMockTerm(sandbox);
    sandbox.__mockTerm = mockTerm;
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`term = __mockTerm`);
    sandbox.__measured = { cols: 100, rows: 30 };
    run(`invalidateTerminalGeometry()`);
    flushTimer();
    runRaf();
    equal(mockTerm.wterm.fitCalls, 1, "wterm.fit still re-measured");
    equal(mockTerm.wterm.resizeCalls.length, 0, "wterm did not re-grid");
    equal(mockTerm.resizeCalls.length, 0, "adapter did not resize");
    ok(
      mockTerm.invalidateCellMetricsCalls >= 1,
      "caches still dropped (raster may have changed)",
    );
  });

  it("keeps the flag armed when no terminal is attached", () => {
    const { sandbox, run, flushTimer, runRaf } = loadTerminalModule();
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`invalidateTerminalGeometry()`);
    flushTimer();
    runRaf();
    equal(run(`terminalGeometryInvalidated`), true, "flag stays armed with no term");
  });

  it("drift detection arms revalidation when --term-cell-width moves", () => {
    const { sandbox, run, flushTimer, runRaf } = loadTerminalModule();
    const mockTerm = makeMockTerm(sandbox);
    sandbox.__mockTerm = mockTerm;
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`term = __mockTerm`);
    // Cached cell width 9; live probe reports 9.5px: > 0.25px drift.
    sandbox.__cellWidthCss = "9.5px";
    run(`detectTerminalGeometryDrift()`);
    equal(run(`terminalGeometryInvalidated`), true, "drift armed revalidation");
    sandbox.__measured = { cols: 100, rows: 30 };
    flushTimer();
    runRaf();
    equal(mockTerm.wterm.fitCalls, 1, "wterm.fit ran on the drift tick");
    equal(run(`terminalGeometryInvalidated`), false, "flag consumed");
  });

  it("drift detection ignores sub-threshold noise", () => {
    const { sandbox, run } = loadTerminalModule();
    const mockTerm = makeMockTerm(sandbox);
    sandbox.__mockTerm = mockTerm;
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`term = __mockTerm`);
    sandbox.__cellWidthCss = "9.1px";
    run(`detectTerminalGeometryDrift()`);
    equal(run(`terminalGeometryInvalidated`), false, "0.1px drift is noise");
  });

  it("drift detection is quiet while a revalidation is already armed", () => {
    const { sandbox, run } = loadTerminalModule();
    const mockTerm = makeMockTerm(sandbox);
    sandbox.__mockTerm = mockTerm;
    run(`state.terminalId = "term_1"; state.termCols = 100; state.termRows = 30;`);
    run(`term = __mockTerm`);
    sandbox.__cellWidthCss = "9.5px";
    run(`invalidateTerminalGeometry()`);
    run(`detectTerminalGeometryDrift()`);
    // Already armed; drift detection must not double-schedule.
    equal(sandbox.__timers.length, 1, "only the original schedule is queued");
  });
});