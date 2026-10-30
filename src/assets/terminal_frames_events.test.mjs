import { describe, it } from "node:test";
import { equal, ok, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Coverage batch for desktop/app_js/terminal.js regions the reconnect and
// paste suites do not reach: the /ws/events message dispatch (settings
// adoption, notes relay, agent status transitions, layout updates), the
// connection chip state machine, cycleEventsSocket, the frame queue
// (attach frames, fast-path writes, coalescing), the input queue, and the
// paste progress surface. Same sandbox contract as
// terminal_reconnect_backoff.test.mjs: terminal.js is a bundle fragment,
// so the module-scoped `let`s are pre-declared here.

let terminalScript = null;
function getTerminalScript() {
  if (!terminalScript) {
    const terminalPath = fileURLToPath(new URL("./desktop/app_js/terminal.js", import.meta.url));
    terminalScript = new vm.Script(readFileSync(terminalPath, "utf8"), { filename: terminalPath });
  }
  return terminalScript;
}

function stubElement(id = "") {
  const classes = new Set();
  const children = [];
  const styleProps = {};
  return {
    id,
    hidden: false,
    title: "",
    textContent: "",
    dataset: {},
    style: {
      setProperty(name, value) { styleProps[name] = String(value); },
      getPropertyValue(name) { return styleProps[name] || ""; },
    },
    classList: {
      add(n) { classes.add(n); },
      remove(n) { classes.delete(n); },
      contains(n) { return classes.has(n); },
      toggle(n, f) { const nx = f === undefined ? !classes.has(n) : !!f; if (nx) classes.add(n); else classes.delete(n); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { children.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    setAttribute() {},
    getAttribute() { return null; },
    clientWidth: 800,
    clientHeight: 600,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 600,
    offsetWidth: 800,
    offsetHeight: 600,
    focus() {},
  };
}

function loadTerminalModule() {
  const script = getTerminalScript();
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  };
  const timers = [];
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Date,
    URLSearchParams,
    WebSocket: class {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.binaryType = "";
        this.sent = [];
        this.bufferedAmount = 0;
        sandbox.sockets.push(this);
      }
      send(data) { this.sent.push(data); }
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1000 });
      }
      __open() {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }
    },
    setTimeout(fn, ms) { timers.push({ fn, ms: ms || 0, fired: false }); return timers.length; },
    clearTimeout(id) { if (id) timers[id - 1].fired = true; },
    setInterval() { return 1; },
    requestAnimationFrame(fn) { sandbox.__rafCallbacks.push(fn); return sandbox.__rafCallbacks.length; },
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    navigator: {},
    location: { protocol: "https:", host: "127.0.0.1:8899", href: "https://127.0.0.1:8899/" },
    document: {
      hidden: false,
      visibilityState: "visible",
      getElementById: getElement,
      createElement: () => stubElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body: stubElement("body"),
      documentElement: stubElement("html"),
      fonts: { load: async () => [], ready: Promise.resolve() },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    state: {
      session: "default",
      agents: [],
      workspaces: [],
      backendsEnabled: { builtin: null, "external-herdr": null },
    },
    options: {},
    el: getElement,
    api: async () => ({}),
    wsUrl: (path) => "ws://test" + path,
    currentSessionBackend: () => "builtin",
    sessionBackendLabel: (b) => b,
    backendEnabled: () => true,
    rememberWorkspaceShellMode: () => {},
    scheduleRefresh: () => {},
    scheduleRefreshBurst: () => {},
    statusClass: (status) => (status === "done" ? "done" : status || "unknown"),
    agentOverrideKey: (a) => [a.workspace_id, a.tab_id, a.pane_id, a.terminal_id].join("|"),
    forgetClosedSelection: () => {},
    eventNeedsFastRefresh: () => false,
    applyLayoutUpdated: () => {},
    syncSessionBackendFromServer: () => {},
    saveWorkingDismissals: () => {},
    wsUrlHost: () => "127.0.0.1:8899",
    HerdrAlertCard: { show: () => {} },
    HerdrGitUi: { hide: () => {}, isVisible: () => false },
    workingDismissals: {},
    __rafCallbacks: [],
    sockets: [],
  };
  sandbox.window = new Proxy(sandbox, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // core.js owns these module-scoped bindings in the real bundle.
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
    let pasteFrameUntil = 0;
    let terminalWriteQueue = [];
    let terminalWriteFlushPending = false;
    let terminalFramePending = false;
    let herdrErrorOfferPending = false;
    const inputEncoder = new TextEncoder();
    const terminal = { addEventListener: () => {}, style: {} };
    function resetTerminalConnection() {}
    function setTerminalLoading() {}
    function render() {}
    function fitTerminalShell() {}
    function fitTerminalSurface() {}
    function focusTerminal() {}
    function setTerminalFollowPaused() {}
    function scrollTerminalToBottom() {}
    function sendBackendTail() {}
    function shiftEnterSequence() { return ""; }
    function handleCloseShortcut() { return false; }
    function clearDismissedWorkingForTerminal() {}
    function showTerminalWorking() {}
    function hideTerminalWorking() {}
    function scheduleOverlayNotify() {}
    function handleHerdrErrorFrame() { return false; }
    function scheduleTerminalPoke() {}
    function updateTerminalZoomBadge() {}
    function bindTerminalViewportScroll() {}
    function browserTerminalSize() { return null; }
    function shouldFitFocusedWebTerminal() { return false; }
    function shouldAutoFitDetachedTerminal() { return false; }
    function applyBrowserTerminalSize() { return false; }
    function applyTerminalFont() {}
    function terminalTheme() { return {}; }
    function terminalFontFamily() { return "monospace"; }
    function refreshTerminalAfterFontLoad() {}
    function applyTerminalLinks() {}
    function applyTheme() {}
    function sendPasteToTerminal() {}
    `,
    sandbox,
    { filename: "core-fragment.js" },
  );
  script.runInContext(sandbox);
  const run = (expr) => vm.runInContext(expr, sandbox);
  const fireTimers = () => {
    let fired = 0;
    for (const t of timers) {
      if (t && !t.fired) { t.fired = true; t.fn(); fired++; }
    }
    return fired;
  };
  const fireRaf = () => {
    const cbs = sandbox.__rafCallbacks.splice(0);
    for (const cb of cbs) cb();
    return cbs.length;
  };
  return { sandbox, run, runAsync: (expr) => vm.runInContext(expr, sandbox).then(() => {}), fireTimers, fireRaf, getElement };
}

describe("events socket dispatch (terminal.js)", () => {
  it("connectEvents opens one socket and marks the chip live on open", () => {
    const { sandbox, run, getElement } = loadTerminalModule();
    run("connectEvents()");
    equal(sandbox.sockets.length, 1);
    // terminal.js owns wsUrl(): default session is omitted, the backend is
    // appended as a query param.
    equal(sandbox.sockets[0].url, "wss://127.0.0.1:8899/ws/events?backend=builtin");
    const chip = getElement("connectionChip");
    equal(chip.dataset.state, "connecting", "connect sets the chip to connecting");
    sandbox.sockets[0].__open();
    equal(chip.dataset.state, "live", "onopen flips the chip to live");
    equal(chip.title, "Live: events stream connected");
    equal(chip.querySelector(".connection-label"), null);
  });

  it("hidden document never opens the events socket", () => {
    const { sandbox, run } = loadTerminalModule();
    run("document.hidden = true; connectEvents()");
    equal(sandbox.sockets.length, 0);
  });

  it("server_settings_changed adopts enabled backends and default backend", () => {
    const { sandbox, run } = loadTerminalModule();
    let synced = 0;
    sandbox.syncSessionBackendFromServer = () => { synced++; };
    let refreshes = 0;
    sandbox.scheduleRefresh = () => { refreshes++; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.__open();
    ws.onmessage({
      data: JSON.stringify({
        type: "server_settings_changed",
        enabled_backends: { builtin: false, "external-herdr": true },
        default_backend: "external-herdr",
      }),
    });
    equal(synced, 1, "backend sync runs once after adoption");
    equal(refreshes, 1, "settings change schedules one refresh");
    equal(run("state.backendsEnabled.builtin"), false);
    equal(run("state.serverDefaultBackend"), "external-herdr");
  });

  it("a frame with a different session is dropped silently", () => {
    const { sandbox, run } = loadTerminalModule();
    let refreshed = 0;
    sandbox.scheduleRefresh = () => { refreshed++; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    run("state.session = 'other'");
    ws.onmessage({ data: JSON.stringify({ type: "event", event: { event: "workspace.listed" } }) });
    equal(refreshed, 0, "stale-session frames never reach dispatch");
  });

  it("garbage frames only schedule a refresh", () => {
    const { sandbox, run } = loadTerminalModule();
    let refreshed = 0;
    sandbox.scheduleRefresh = () => { refreshed++; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.onmessage({ data: "{not json" });
    equal(refreshed, 1, "unparseable frames schedule a refresh");
  });

  it("pane.agent_status_changed clears working dismissals when the pane stops working", () => {
    const { sandbox, run } = loadTerminalModule();
    let saved = 0;
    sandbox.saveWorkingDismissals = () => { saved++; };
    run(`
      workingDismissals = { "ws1|t1|p1|x": { dismissedAt: 1 } };
      state.agents = [{ workspace_id: "ws1", tab_id: "t1", pane_id: "p1", terminal_id: "x" }];
    `);
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.onmessage({
      data: JSON.stringify({
        type: "event",
        event: {
          event: "pane.agent_status_changed",
          data: { pane_id: "p1", workspace_id: "ws1", agent_status: "done" },
        },
      }),
    });
    equal(run("Object.keys(workingDismissals).length"), 0, "the dismissal entry is cleared");
    equal(saved, 1, "the dismissal store persists once");
    // A working-status frame keeps the dismissal in place.
    run(`workingDismissals = { "ws1|t1|p1|x": { dismissedAt: 1 } };`);
    sandbox.sockets[0].onmessage({
      data: JSON.stringify({
        type: "event",
        event: {
          event: "pane.agent_status_changed",
          data: { pane_id: "p1", workspace_id: "ws1", agent_status: "working" },
        },
      }),
    });
    equal(run("Object.keys(workingDismissals).length"), 1, "working frames keep dismissals");
    equal(saved, 1, "no extra save for the working frame");
  });

  it("layout.updated routes through applyLayoutUpdated without a refresh", () => {
    const { sandbox, run } = loadTerminalModule();
    let applied = null;
    let refreshed = 0;
    sandbox.applyLayoutUpdated = (layout) => { applied = layout; };
    sandbox.scheduleRefresh = () => { refreshed++; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    const layout = { panes: [{ pane_id: "p1" }] };
    ws.onmessage({
      data: JSON.stringify({
        type: "event",
        event: { event: "layout.updated", data: { layout } },
      }),
    });
    equal(JSON.stringify(applied), JSON.stringify(layout), "layout lands in applyLayoutUpdated");
    equal(refreshed, 0, "layout.updated skips the refresh path");
  });

  it("notes_changed relays to the notes panel without any refresh", () => {
    const { sandbox, run } = loadTerminalModule();
    let applied = null;
    let refreshed = 0;
    sandbox.HerdrNotesPanel = { applyRemote: (msg) => { applied = msg; } };
    sandbox.scheduleRefresh = () => { refreshed++; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.onmessage({ data: JSON.stringify({ type: "notes_changed", note: "x" }) });
    equal(applied && applied.note, "x", "the notes panel sees the remote frame");
    equal(refreshed, 0, "notes frames never refresh the tree");
  });

  it("onclose clears the socket, marks the chip, and schedules reconnect", () => {
    const { sandbox, run, fireTimers, getElement } = loadTerminalModule();
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.onclose();
    equal(run("eventWs === null"), true);
    equal(getElement("connectionChip").dataset.state, "offline", "onclose explicitly marks the chip offline");
    const fired = fireTimers();
    ok(fired >= 1, "the 1500ms reconnect timer is scheduled and runnable");
    equal(sandbox.sockets.length, 2, "reconnect opens a fresh events socket");
  });

  it("cycleEventsSocket drops a live socket and reconnects once", () => {
    const { sandbox, run } = loadTerminalModule();
    run("connectEvents()");
    const first = sandbox.sockets[0];
    first.__open();
    run("cycleEventsSocket()");
    equal(sandbox.sockets.length, 2, "the zombie socket is replaced");
    equal(sandbox.sockets[0], first);
    ok(sandbox.sockets[0].readyState === 3, "the old socket was closed");
    equal(sandbox.sockets[1].readyState, 0, "the fresh socket is still connecting");
  });

  it("event frames still schedule a plain refresh for unknown kinds", () => {
    const { sandbox, run } = loadTerminalModule();
    let refreshMs = null;
    sandbox.scheduleRefresh = (ms) => { refreshMs = ms; };
    run("connectEvents()");
    const ws = sandbox.sockets[0];
    ws.onmessage({
      data: JSON.stringify({ type: "event", event: { event: "workspace.created", data: {} } }),
    });
    equal(refreshMs, 500, "unknown event kinds use the slow refresh");
  });
});

describe("terminal frame queue (terminal.js)", () => {
  it("small frames with a live term take the immediate write path", () => {
    const { sandbox, run } = loadTerminalModule();
    const writes = [];
    run(`term = { write: (d) => { writes.push(String(d)); } , element: {} }`);
    vm.runInContext("writes = []", sandbox);
    run(`term.write = (d) => { writes.push(String(d)); }`);
    run(`enqueueTerminalFrame("abc")`);
    const seen = run("writes.join(',')");
    equal(seen, "abc", "small frame written directly");
    equal(run("terminalWriteQueue.length"), 0, "queue stays empty on the fast path");
  });

  it("large attach frames queue and flush as one coalesced write", () => {
    const { sandbox, run, fireRaf } = loadTerminalModule();
    vm.runInContext(
      `writes = [];
       loadingCalls = [];
       setTerminalLoading = (show) => { loadingCalls.push(show); };
       term = { write: (d, done) => { writes.push(typeof d === "string" ? d.length : d.length); if (done) done(); } };
       connectedTerminalId = "tgt";
       terminalAttachPending = true;
       enqueueTerminalFrame("x".repeat(40000));`,
      sandbox,
    );
    equal(run("terminalWriteQueue.length"), 1, "attach frame parked in the queue");
    equal(run("writes.length"), 0, "nothing written before the RAF flush");
    equal(run("loadingCalls.join(',')"), "", "the loading overlay stays up until the write completes");
    fireRaf();
    equal(run("writes.join(',')"), "40000", "the coalesced attach frame lands as one write");
    equal(run("terminalAttachPending"), false, "attach flag cleared by the flush");
    equal(run("terminalWriteQueue.length"), 0);
    // The reveal rides a second RAF generation: the write callback hides
    // the loading overlay only after wterm finishes parsing.
    fireRaf();
    ok(run("loadingCalls.indexOf(false) !== -1"), "the reveal lands only after the attach write");
  });

  it("mixed string and binary frames coalesce into one merged Uint8Array", () => {
    const { sandbox, run, fireRaf } = loadTerminalModule();
    vm.runInContext(
      `writes = [];
       term = { write: (d) => { writes.push(d instanceof Uint8Array ? "bytes:" + d.length : "str:" + d.length); } };
       connectedTerminalId = "tgt";
       terminalAttachPending = false;
       terminalWriteQueue = [
         { terminalId: "tgt", data: "ab" },
         { terminalId: "tgt", data: new Uint8Array([99, 100]) },
       ];
       terminalWriteFlushPending = true;
       requestAnimationFrame(flushTerminalFrames);`,
      sandbox,
    );
    fireRaf();
    equal(run("writes.join(',')"), "bytes:4", "flush merges string + bytes into one Uint8Array");
  });

  it("takeTerminalFrames only drains frames for the asked terminal", () => {
    const { sandbox, run } = loadTerminalModule();
    vm.runInContext(
      `terminalWriteQueue = [
        { terminalId: "a", data: "1" },
        { terminalId: "b", data: "2" },
        { terminalId: "a", data: "3" },
      ];`,
      sandbox,
    );
    equal(run("takeTerminalFrames('a').join('')"), "13");
    equal(run("terminalWriteQueue.map((f) => f.terminalId).join('')"), "b", "the other terminal keeps its frame");
  });

  it("flushTerminalFramesFor writes and clears dismissals for that terminal", () => {
    const { sandbox, run } = loadTerminalModule();
    vm.runInContext(
      `writes = [];
       term = { write: (d) => { writes.push(String(d)); } };
       connectedTerminalId = "x";
       terminalWriteQueue = [{ terminalId: "x", data: "q" }, { terminalId: "y", data: "r" }];`,
      sandbox,
    );
    run(`flushTerminalFramesFor("x")`);
    equal(run("writes.join(',')"), "q");
    equal(run("terminalWriteQueue.map((f) => f.data).join(',')"), "r");
  });
});

describe("terminal input queue (terminal.js)", () => {
  it("small input on an open socket is sent immediately without queueing", () => {
    const { sandbox, run } = loadTerminalModule();
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 0;
       sendInputData("hi");`,
      sandbox,
    );
    const ws = sandbox.sockets[sandbox.sockets.length - 1];
    equal(ws.sent.length, 1, "one immediate send");
    equal(run("inputQueue.length"), 0);
  });

  it("oversize input is chunked into the queue and drains while the socket accepts bytes", () => {
    const { sandbox, run, fireTimers } = loadTerminalModule();
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 0;
       sendInputData("z".repeat(40 * 1024), { chunkSize: 16 * 1024, maxBufferedAmount: 65536 });`,
      sandbox,
    );
    const ws = sandbox.sockets[sandbox.sockets.length - 1];
    // sendInputData flushes synchronously when the socket is open and the
    // buffer is empty: all three 16KB chunks leave in one call.
    equal(ws.sent.length, 3, "the three 16KB chunks drain on the open socket");
    equal(run("inputQueue.length"), 0);
    equal(run("inputFlushTimer === null"), true, "no flush timer left pending");
    // A saturated socket parks the chunks behind a timer instead.
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 70000;
       sendInputData("y".repeat(40 * 1024), { chunkSize: 16 * 1024, maxBufferedAmount: 65536 });`,
      sandbox,
    );
    const full = sandbox.sockets[sandbox.sockets.length - 1];
    equal(run("inputQueue.length"), 3, "a full buffer parks the chunks in the queue");
    equal(full.sent.length, 0, "nothing moves while bufferedAmount is over the ceiling");
    full.bufferedAmount = 0;
    fireTimers();
    equal(full.sent.length, 3, "the pending flush timer drains the queue once the buffer clears");
  });

  it("input under the default 16KB chunk ceiling sends as one immediate frame", () => {
    const { sandbox, run } = loadTerminalModule();
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 0;
       sendInputData("m".repeat(5 * 1024));`,
      sandbox,
    );
    const ws = sandbox.sockets[sandbox.sockets.length - 1];
    equal(ws.sent.length, 1, "no explicit chunkSize: 5KB fits one default chunk");
    equal(run("inputQueue.length"), 0, "nothing parks in the queue");
  });

  it("a dead socket drops the queue wholesale", () => {
    const { sandbox, run, fireTimers } = loadTerminalModule();
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 3;
       inputQueue = [new Uint8Array(1), new Uint8Array(2)];
       inputFlushTimer = setTimeout(flushInputQueue, 4);`,
      sandbox,
    );
    fireTimers();
    equal(run("inputQueue.length"), 0, "closed socket empties the queue");
    equal(run("inputQueueMaxBufferedAmount"), 65536, "buffer ceiling resets");
  });

  it("sendInputData strips mouse reports unless explicitly allowed", () => {
    const { sandbox, run } = loadTerminalModule();
    vm.runInContext(
      `globalThis.HerdrAppHelpers = {
         stripTerminalMouseReports: (d) => d.replace(/\\x1b\\[M../g, ""),
       };
       termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 0;
       sendInputData("k\\u001b[M!!");`,
      sandbox,
    );
    const ws = sandbox.sockets[sandbox.sockets.length - 1];
    equal(ws.sent.length, 1);
    const bytes = new TextDecoder().decode(ws.sent[0]);
    equal(bytes, "k", "the mouse report is stripped by default");
    vm.runInContext(
      `sendInputData("\\u001b[M!!", { allowMouseReports: true });`,
      sandbox,
    );
    const kept = new TextDecoder().decode(ws.sent[1]);
    equal(kept, "\u001b[M!!", "allowed mouse reports pass through untouched");
  });
});

describe("paste progress surface (terminal.js)", () => {
  it("updateTerminalPasteProgress paints percent, label, and the scaleX bar", () => {
    const { sandbox, run, getElement } = loadTerminalModule();
    run(`updateTerminalPasteProgress(5, 20)`);
    equal(getElement("terminalPasteProgressLabel").textContent, "Pasting… 25%");
    equal(getElement("terminalPasteProgressBar").style.getPropertyValue("--paste-progress"), "0.25");
    run(`updateTerminalPasteProgress(20, 20)`);
    equal(getElement("terminalPasteProgressLabel").textContent, "Paste sent");
    equal(getElement("terminalPasteProgressBar").style.getPropertyValue("--paste-progress"), "1");
  });

  it("show and hide toggle the progress overlay and the pasting class", () => {
    const { sandbox, run, getElement } = loadTerminalModule();
    run(`showTerminalPasteProgress(9)`);
    equal(getElement("terminalPasteProgress").hidden, false);
    ok(getElement("terminalShell").classList.contains("pasting"));
    run(`hideTerminalPasteProgress()`);
    equal(getElement("terminalPasteProgress").hidden, true);
    equal(getElement("terminalShell").classList.contains("pasting"), false);
  });

  it("sendPasteToTerminal merges concurrent pastes into one job and chunk-flushes", () => {
    const { sandbox, run, fireTimers, getElement } = loadTerminalModule();
    vm.runInContext(
      `termWs = new WebSocket("ws://t"); termWs.readyState = 1; termWs.bufferedAmount = 0;
       Date.now = () => 1000;`,
      sandbox,
    );
    run(`sendPasteToTerminal("${"a".repeat(100)}")`);
    run(`sendPasteToTerminal("${"b".repeat(50)}")`);
    equal(run("pasteJob.total"), 150, "the second paste extends the same job");
    equal(getElement("terminalPasteProgress").hidden, false, "progress visible during the paste");
    fireTimers();
    equal(run("pasteJob === null"), true, "the job finishes after the chunk flush");
    const ws = sandbox.sockets[sandbox.sockets.length - 1];
    ok(ws.sent.length >= 1, "paste bytes reached the socket");
  });

  it("paste chunks normalize CRLF and lone CR across chunk seams", () => {
    const { sandbox, run } = loadTerminalModule();
    const out = run(`JSON.stringify((() => {
      const job = { pendingCR: false };
      const first = normalizeTerminalPasteChunk(job, "a\\r", false);
      const second = normalizeTerminalPasteChunk(job, "b\\n", true);
      return { first, second, pending: job.pendingCR };
    })())`);
    equal(JSON.parse(out).first, "a", "the trailing CR is held back at the seam");
    equal(JSON.parse(out).second, "\nb\n", "the held CR normalizes to a newline when it rejoins");
    equal(JSON.parse(out).pending, false);
  });
});

describe("connection chip state (terminal.js)", () => {
  it("eventsConnectionState reports live only for an open socket", () => {
    const { sandbox, run } = loadTerminalModule();
    equal(run("eventsConnectionState()"), "reconnecting", "no socket and visible tab reconnects");
    run("connectEvents()");
    equal(run("eventsConnectionState()"), "reconnecting", "connecting socket is not live yet");
    sandbox.sockets[0].__open();
    equal(run("eventsConnectionState()"), "live");
    run("state.backendOnline = false; eventWs = null;");
    equal(run("eventsConnectionState()"), "offline", "offline flag beats everything");
  });

  it("the chip keeps its state when the new value equals the old one", () => {
    const { sandbox, run, getElement } = loadTerminalModule();
    getElement("connectionChip").dataset.state = "live";
    const titleBefore = getElement("connectionChip").title;
    run(`setEventsConnectionState("live")`);
    equal(getElement("connectionChip").title, titleBefore, "no rewrite for the same state");
  });
});