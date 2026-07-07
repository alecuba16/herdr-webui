function connectEvents() {
  if (document.hidden || eventWs) return;
  const eventSession = state.session;
  const ws = new WebSocket(wsUrl("/ws/events"));
  eventWs = ws;
  ws.onmessage = (e) => {
    if (eventWs !== ws || eventSession !== state.session) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      scheduleRefresh();
      return;
    }
    if (msg.type === "snapshot") applySnapshot(msg);
    else if (msg.type === "event") {
      const evt = msg.event || {},
        kind = evt.event || evt.type,
        data = evt.data || {};
      if (kind === "pane.agent_status_changed") {
        const d = data;
        if (statusClass(d.agent_status) !== "working") {
          for (const agent of state.agents) {
            if (
              agent.pane_id === d.pane_id &&
              agent.workspace_id === d.workspace_id
            ) {
              const key = agentOverrideKey(agent);
              if (workingDismissals[key]) {
                delete workingDismissals[key];
                saveWorkingDismissals();
              }
            }
          }
        }
      }
      forgetClosedSelection(kind, data);
      if (kind === "layout.updated") {
        applyLayoutUpdated(data.layout || data);
        // layout.updated is handled directly by applyLayoutUpdated which
        // updates terminal sizing without a full refresh. Skip the refresh
        // to avoid flicker and unnecessary re-fetches.
      } else {
        scheduleRefresh(eventNeedsFastRefresh(kind) ? 50 : 500);
      }
    }
  };
  ws.onclose = () => {
    if (eventWs === ws) eventWs = null;
    if (!document.hidden && eventSession === state.session)
      setTimeout(connectEvents, 1500);
  };
}
function connectTerminal() {
  if (document.hidden) return;
  if (!state.terminalId) {
    resetTerminalConnection(true);
    setTerminalLoading(false);
    return;
  }
  fitTerminalShell();
  const target = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}`;
  if (!term) {
    term = new Terminal({
      convertEol: false,
      cursorBlink: false,
      cursorInactiveStyle: "block",
      cursorStyle: "block",
      theme: terminalTheme(),
      fontFamily: terminalFontFamily(),
      scrollback: 10000,
    });
    term.open(terminal);
    refreshTerminalAfterFontLoad(target);
    applyTerminalLinks();
    applyTheme();
    term.onData(sendInputData);
    if (term.attachCustomKeyEventHandler)
      term.attachCustomKeyEventHandler((e) => {
        if (window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible())
          return false;
        if (e.type === "keydown" && handleCloseShortcut(e)) return false;
        if (
          options.shiftEnterNewline !== false &&
          e.type === "keydown" &&
          e.key === "Enter" &&
          e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          sendInputData(shiftEnterSequence());
          return false;
        }
        if (
          e.type === "keydown" &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "PageUp" || e.key === "PageDown")
        ) {
          scrollTerminalLines(
            e.key === "PageUp"
              ? -Math.max(1, (state.termRows || rows) - 1)
              : Math.max(1, (state.termRows || rows) - 1),
          );
          return false;
        }
        return true;
      });
  }
  const fit = browserTerminalSize();
  if (fit && (options.fitToBrowser || shouldFitFocusedWebTerminal())) {
    state.termCols = fit.cols;
    state.termRows = fit.rows;
  }
  const cols = state.termCols || 100,
    rows = state.termRows || 30,
    size = `${cols}x${rows}`;
  if (
    termWs &&
    termWs.readyState === 1 &&
    connectedTerminalId === target &&
    connectedSize === size
  ) {
    setTerminalLoading(false);
    fitTerminalSurface();
    focusTerminal();
    return;
  }
  resetTerminalConnection(true);
  setTerminalLoading(true);
  connectedTerminalId = target;
  connectedSize = size;
  if (!termScrollBound) {
    el("terminalShell").addEventListener(
      "paste",
      (e) => {
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        sendPasteToTerminal(text);
      },
      true,
    );
    el("terminalShell").addEventListener(
      "keydown",
      (e) => {
        if (
          options.shiftEnterNewline !== false &&
          e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "Enter" || e.code === "Enter" || e.keyCode === 13)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendInputData(shiftEnterSequence());
        }
      },
      true,
    );
    const shell = el("terminalShell");
    shell.addEventListener("mousedown", () =>
      setTimeout(focusTerminal, 0),
    );
    terminal.addEventListener("wheel", handleTerminalWheel, { passive: false, capture: true });
    terminal.addEventListener("touchstart", handleTerminalTouchStart, { passive: true, capture: true });
    terminal.addEventListener("touchmove", handleTerminalTouchMove, { passive: false, capture: true });
    terminal.addEventListener("touchend", handleTerminalTouchEnd, { passive: true, capture: true });
    terminal.addEventListener("touchcancel", handleTerminalTouchEnd, { passive: true, capture: true });
    termScrollBound = true;
  }
  try {
    term.resize(cols, rows);
    fitTerminalSurface();
  } catch (e) {}
  const ws = new WebSocket(
    wsUrl(
      `/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${cols}&rows=${rows}`,
    ),
  );
  termWs = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    if (termWs === ws) {
      terminalAttachPending = true;
      scrollTerminalToBottom(false);
      focusTerminal();
    }
  };
  ws.onmessage = (e) => {
    if (termWs !== ws || connectedTerminalId !== target) return;
    // Don't hide loading overlay here for attach frames; the write callback
    // in flushTerminalFrames will reveal the terminal once parsing completes.
    // For normal frames, hide it immediately.
    if (!terminalAttachPending) setTerminalLoading(false);
    enqueueTerminalFrame(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  };
  ws.onclose = () => {
    if (termWs === ws) {
      flushTerminalFramesFor(target);
      termWs = null;
      connectedTerminalId = null;
      connectedSize = "";
      setTerminalLoading(false);
      scheduleRefreshBurst();
    }
  };
}
function refreshTerminalAfterFontLoad(terminalKey) {
  const fonts = globalThis.document && globalThis.document.fonts;
  if (!fonts || !fonts.load) return;
  Promise.all([
    fonts.load('14px "Herdr JetBrainsMono Nerd Font Mono"'),
    fonts.ready,
  ])
    .then(() => {
      if (!term || connectedTerminalId !== terminalKey) return;
      applyTerminalFont();
      const fit = browserTerminalSize();
      if (
        fit &&
        (options.fitToBrowser || shouldFitFocusedWebTerminal()) &&
        (fit.cols !== state.termCols || fit.rows !== state.termRows)
      ) {
        state.termCols = fit.cols;
        state.termRows = fit.rows;
        connectTerminal();
        return;
      }
      fitTerminalSurface();
    })
    .catch(() => {});
}
function applyTerminalLinks() {
  if (terminalLinkProvider && terminalLinkProvider.dispose) {
    try { terminalLinkProvider.dispose(); } catch (e) {}
  }
  terminalLinkProvider = null;
  if (!term || options.terminalLinks === false || !term.registerLinkProvider) return;
  terminalLinkProvider = term.registerLinkProvider({ provideLinks: provideTerminalLinks });
}
function provideTerminalLinks(lineNumber, callback) {
  try {
    const buffer = term && term.buffer && term.buffer.active;
    const y = buffer ? Math.max(0, (buffer.viewportY || 0) + lineNumber - 1) : 0;
    const line = buffer && (buffer.getLine(y) || buffer.getLine(lineNumber - 1) || buffer.getLine(lineNumber));
    const text = line && line.translateToString ? line.translateToString(true) : "";
    const links = [];
    const re = /https?:\/\/[^\s<>"]+/g;
    let match;
    while ((match = re.exec(text))) {
      const url = match[0].replace(/[),.;]+$/g, "");
      if (!url) continue;
      links.push({
        range: { start: { x: match.index + 1, y: lineNumber }, end: { x: match.index + url.length, y: lineNumber } },
        text: url,
        activate: (_event, text) => window.open(text, "_blank", "noopener,noreferrer"),
      });
    }
    callback(links);
  } catch (e) {
    callback([]);
  }
}
// Threshold below which a single frame is written immediately to xterm.js
// instead of waiting for the next requestAnimationFrame. Small frames (a
// few lines of output, a cursor move) have negligible render cost and the
// RAF delay adds ~16ms of latency for no benefit. Above the threshold we
// coalesce bursts to avoid overwhelming the renderer.
const IMMEDIATE_WRITE_THRESHOLD = 8192;
// Frames above this size are likely full-screen repaints from the backend
// (the initial attach frame). xterm.js parses these in 12ms time-slices with
// setTimeout(0) between slices, and each slice triggers a browser paint of
// the partially-parsed screen. Keep the loading overlay for only a short time:
// waiting for the full write callback on a large scrollback can hide input for
// several seconds when switching panels.
const LARGE_FRAME_THRESHOLD = 32768;
const ATTACH_REVEAL_TIMEOUT_MS = 250;
// Set true on WS open, cleared after the first large frame is fully written.
let terminalAttachPending = false;

function enqueueTerminalFrame(data) {
  // Attach frame path: the first frame after connecting is a full-screen
  // repaint from the backend (50KB-425KB depending on terminal size).
  // xterm.js parses it in 12ms time-slices with setTimeout(0) between
  // slices, and each slice triggers a browser paint of the partially-parsed
  // screen -> the "line-by-line refresh" effect.
  // We queue it via RAF and use the write callback to reveal only when done.
  const isAttachFrame = terminalAttachPending && frameSize(data) >= LARGE_FRAME_THRESHOLD;
  if (isAttachFrame) {
    // Don't clear terminalAttachPending here; flushTerminalFrames uses it
    // to decide whether to suppress the loading overlay until write completes.
    terminalWriteQueue.push({ terminalId: connectedTerminalId, data });
    if (terminalWriteFlushPending) return;
    terminalWriteFlushPending = true;
    requestAnimationFrame(flushTerminalFrames);
    return;
  }
  // Clear the attach flag for small initial frames (e.g. empty terminal)
  if (terminalAttachPending) {
    terminalAttachPending = false;
    setTerminalLoading(false);
  }
  // Fast path: when no flush is pending and the frame is small, write it
  // directly. This avoids the requestAnimationFrame round-trip (~16ms) for
  // the common case of a few characters or a cursor move.
  if (
    !terminalWriteFlushPending &&
    terminalWriteQueue.length === 0 &&
    term &&
    frameSize(data) <= IMMEDIATE_WRITE_THRESHOLD
  ) {
    writeTerminalFrame(data);
    clearDismissedWorkingForTerminal(state.terminalId);
    return;
  }
  terminalWriteQueue.push({ terminalId: connectedTerminalId, data });
  if (terminalWriteFlushPending) return;
  terminalWriteFlushPending = true;
  requestAnimationFrame(flushTerminalFrames);
}
function frameSize(data) {
  return typeof data === "string" ? data.length : data.length;
}
function flushTerminalFrames() {
  terminalWriteFlushPending = false;
  if (!terminalWriteQueue.length || !term) return;
  const terminalId = connectedTerminalId;
  const frames = takeTerminalFrames(terminalId);
  if (!frames.length) return;
  const data = coalesceTerminalFrames(frames);
  // Check if any frame in this batch was an attach frame
  const isAttachBatch = terminalAttachPending && frameSize(data) >= LARGE_FRAME_THRESHOLD;
  if (isAttachBatch) {
    terminalAttachPending = false;
    let revealed = false;
    let revealTimer = setTimeout(revealAttachFrame, ATTACH_REVEAL_TIMEOUT_MS);
    function revealAttachFrame() {
      if (revealed) return;
      revealed = true;
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
      clearDismissedWorkingForTerminal(state.terminalId);
      // Wait one RAF so xterm has a chance to paint before revealing.
      requestAnimationFrame(() => {
        setTerminalLoading(false);
        scrollTerminalToBottom(false);
        focusTerminal();
      });
    }
    writeTerminalFrame(data, revealAttachFrame);
    return;
  }
  // Clear attach flag if it was set but the coalesced frame ended up small
  if (terminalAttachPending) {
    terminalAttachPending = false;
    setTerminalLoading(false);
  }
  writeTerminalFrame(data);
  clearDismissedWorkingForTerminal(state.terminalId);
}
function flushTerminalFramesFor(terminalId) {
  if (!terminalWriteQueue.length || !term || !terminalId) return;
  const frames = takeTerminalFrames(terminalId);
  if (!frames.length) return;
  writeTerminalFrame(coalesceTerminalFrames(frames));
  clearDismissedWorkingForTerminal(terminalId);
}
function takeTerminalFrames(terminalId) {
  const frames = [];
  const remaining = [];
  for (const frame of terminalWriteQueue) {
    if (frame.terminalId === terminalId) frames.push(frame.data);
    else remaining.push(frame);
  }
  terminalWriteQueue = remaining;
  return frames;
}
function coalesceTerminalFrames(frames) {
  if (frames.every((frame) => typeof frame === "string")) return frames.join("");
  const bytes = frames.map((frame) => typeof frame === "string" ? inputEncoder.encode(frame) : frame);
  const size = bytes.reduce((sum, frame) => sum + frame.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const frame of bytes) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  return merged;
}

function terminalCellHeight() {
  return HerdrTerminalScroll.cellSize(term).height;
}
function terminalUsesNormalBuffer() {
  return !term || !term.buffer || !term.buffer.active || term.buffer.active.type !== "alternate";
}
function terminalWheelLines(e) {
  const rowHeight = terminalCellHeight();
  const stepLines = Math.max(1, Number(options.scrollLines) || 1);
  if (e.deltaMode === 1) return e.deltaY > 0 ? stepLines : -stepLines;
  if (e.deltaMode === 2) return e.deltaY > 0 ? (state.termRows || 30) : -(state.termRows || 30);
  terminalWheelDeltaPixels += e.deltaY;
  if (Math.abs(terminalWheelDeltaPixels) < rowHeight) return 0;
  const steps = Math.trunc(terminalWheelDeltaPixels / rowHeight);
  terminalWheelDeltaPixels -= steps * rowHeight;
  return steps * stepLines;
}
function scrollTerminalLines(lines) {
  if (!term || !Number.isFinite(lines) || lines === 0) return false;
  if (sendBackendScroll(lines)) {
    updateTerminalScrollbackEstimate(lines);
    return true;
  }
  if (!terminalUsesNormalBuffer()) return false;
  try {
    term.scrollLines(Math.trunc(lines));
    setTerminalFollowPaused(!terminalAtBottom());
    return true;
  } catch (e) {
    return false;
  }
}
function updateTerminalScrollbackEstimate(lines) {
  const count = Math.max(1, Math.abs(Math.trunc(lines)));
  terminalScrollbackOffsetEstimate = Math.max(
    0,
    terminalScrollbackOffsetEstimate + (lines < 0 ? count : -count),
  );
  setTerminalFollowPaused(terminalScrollbackOffsetEstimate > 0);
}
function sendBackendScrollNow(lines) {
  if (!termWs || termWs.readyState !== 1 || !Number.isFinite(lines) || lines === 0) return false;
  const wholeLines = Math.trunc(lines);
  if (wholeLines === 0) return false;
  try {
    const message = JSON.stringify({
      type: "scroll",
      direction: wholeLines < 0 ? "up" : "down",
      lines: Math.max(1, Math.abs(wholeLines)),
    });
    termWs.send(message);
    return true;
  } catch (e) {
    return false;
  }
}
function flushBackendScroll() {
  terminalBackendScrollFramePending = false;
  const lines = terminalBackendScrollLines;
  terminalBackendScrollLines = 0;
  if (lines) sendBackendScrollNow(lines);
}
function sendBackendScroll(lines, immediate = false) {
  if (!termWs || termWs.readyState !== 1 || !Number.isFinite(lines) || lines === 0) return false;
  const wholeLines = Math.trunc(lines);
  if (wholeLines === 0) return false;
  if (immediate) return sendBackendScrollNow(wholeLines);
  terminalBackendScrollLines += wholeLines;
  if (terminalBackendScrollLines === 0) return true;
  if (!terminalBackendScrollFramePending) {
    terminalBackendScrollFramePending = true;
    requestAnimationFrame(flushBackendScroll);
  }
  return true;
}
function sendBackendTail() {
  terminalBackendScrollLines = 0;
  return sendBackendScroll(65535, true);
}
function handleTerminalWheel(e) {
  if (e.ctrlKey || e.metaKey) return;
  const lines = terminalWheelLines(e);
  if (!lines) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  const signedLines = lines > 0 ? Math.max(1, Math.ceil(lines)) : Math.min(-1, Math.floor(lines));
  if (!scrollTerminalLines(signedLines)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
function handleTerminalTouchStart(e) {
  terminalTouchLastY = e.touches && e.touches.length === 1 ? e.touches[0].clientY : null;
}
function handleTerminalTouchMove(e) {
  if (!e.touches || e.touches.length !== 1 || terminalTouchLastY === null) return;
  const y = e.touches[0].clientY;
  const deltaY = terminalTouchLastY - y;
  terminalTouchLastY = y;
  const lines = deltaY / terminalCellHeight();
  const signedLines = lines > 0 ? Math.max(1, Math.ceil(lines)) : Math.min(-1, Math.floor(lines));
  if (!scrollTerminalLines(signedLines)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
function handleTerminalTouchEnd() {
  terminalTouchLastY = null;
}

function terminalAtBottom() {
  try {
    const buffer = term && term.buffer && term.buffer.active;
    if (!buffer) return true;
    return Math.max(0, buffer.baseY - buffer.viewportY) <= 1;
  } catch (e) {
    return true;
  }
}
function setTerminalFollowPaused(paused) {
  terminalScrollbackOffsetEstimate = paused ? terminalScrollbackOffsetEstimate : 0;
  const button = el("terminalFollowButton");
  if (!button) return;
  button.hidden = !paused;
  button.setAttribute("aria-hidden", paused ? "false" : "true");
}

function writeTerminalFrame(data, onDone) {
  // For large frames (the initial attach repaint), use the write callback
  // to know when xterm.js finishes parsing. This avoids the caller
  // revealing the terminal while xterm's WriteBuffer is still in its
  // 12ms time-slice loop, which would show partial renders.
  if (onDone) {
    try { term.write(data, onDone); return; }
    catch (e) { term.write(data); onDone(); return; }
  }
  try {
    term.write(data);
  } catch (e) {
    term.write(data);
  }
}
function scrollTerminalToBottom(focus = true) {
  sendBackendTail();
  setTerminalFollowPaused(false);
  try {
    if (term) term.scrollToBottom();
  } catch (e) {}
  if (focus) focusTerminal(true);
}
function modalOpen() {
  return [
    "settingsModal",
    "workspaceCreateModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "shortcutsModal",
    "searchPalette",
    "tempTerminalModal",
  ].some((id) => {
    const m = el(id);
    return m && m.style.display && m.style.display !== "none";
  });
}
function preserveActiveElementFocus() {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active.isContentEditable) return true;
  return !!active.closest("input, select, textarea, button, [role='button']");
}
function focusTerminal(force = false) {
  if (
    state.editingTab ||
    state.editingWorkspace ||
    modalOpen() ||
    (!force && preserveActiveElementFocus()) ||
    !term
  )
    return;
  try {
    term.focus();
  } catch (e) {}
}
// Called after paste, resize, connect, or layout changes to ensure the
// terminal surface fits its shell. This is the only place layout reads
// should happen -- never on every data frame.
function scheduleTerminalLayoutFit() {
  if (terminalFramePending) return;
  terminalFramePending = true;
  requestAnimationFrame(() => {
    terminalFramePending = false;
    fitTerminalShell();
    fitTerminalSurface();
    focusTerminal();
  });
}
async function copySelection() {
  const text = term && term.getSelection ? term.getSelection() : "";
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  hideClipboardMenu();
  return true;
}
async function pasteClipboard() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    text = prompt("Paste text") || "";
  }
  if (text) sendPasteToTerminal(text);
  hideClipboardMenu();
}
function sendInputData(data, options = {}) {
  if (!termWs || termWs.readyState !== 1 || !data) return;
  const bytes = inputEncoder.encode(data);
  const chunkSize = options.chunkSize || 16 * 1024;
  const maxBufferedAmount = options.maxBufferedAmount || 65536;
  if (
    bytes.length <= chunkSize &&
    inputQueue.length === 0 &&
    termWs.bufferedAmount < maxBufferedAmount
  ) {
    termWs.send(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i += chunkSize)
    inputQueue.push(bytes.slice(i, i + chunkSize));
  inputQueueMaxBufferedAmount = Math.max(inputQueueMaxBufferedAmount, maxBufferedAmount);
  flushInputQueue();
}
function sendPasteToTerminal(text) {
  if (!termWs || termWs.readyState !== 1 || !text) return;
  pasteFrameUntil = Date.now() + 250;
  sendInputData(terminalPasteInput(text, false), {
    chunkSize: 16 * 1024,
    maxBufferedAmount: 64 * 1024,
  });
  finishPasteFrameSoon();
}
function scheduleInputFlush() {
  if (inputFlushTimer) return;
  inputFlushTimer = setTimeout(flushInputQueue, 4);
}
function flushInputQueue() {
  inputFlushTimer = null;
  if (!termWs || termWs.readyState !== 1) {
    inputQueue = [];
    inputQueueMaxBufferedAmount = 65536;
    return;
  }
  while (inputQueue.length && termWs.bufferedAmount < inputQueueMaxBufferedAmount)
    termWs.send(inputQueue.shift());
  if (inputQueue.length) scheduleInputFlush();
  else inputQueueMaxBufferedAmount = 65536;
}
function finishPasteFrameSoon() {
  setTimeout(() => {
    pasteFrameUntil = 0;
    scheduleTerminalLayoutFit();
  }, 250);
}
function showClipboardMenu(x, y) {
  const menu = el("clipboardMenu");
  if (!menu) return;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.display = "block";
}
function hideClipboardMenu() {
  const menu = el("clipboardMenu");
  if (menu) menu.style.display = "none";
}
function fitTerminalSurface() {
  const cols = state.termCols || 100,
    rows = state.termRows || 30;
  const shell = el("terminalShell");
  if (shell) {
    shell.scrollTop = 0;
    shell.scrollLeft = 0;
  }
  const dims =
    HerdrTerminalScroll.cellSize(term);
  const cellWidth = dims.width;
  const rowHeight = dims.height;
  const width = Math.ceil(cellWidth * cols);
  const height = Math.ceil(rowHeight * rows);
  if (options.overflow) {
    terminal.style.width = width + "px";
    terminal.style.height = height + "px";
    terminal.style.minWidth = width + "px";
    terminal.style.minHeight = height + "px";
  } else {
    terminal.style.width = "100%";
    // Do not cap the terminal element height in normal mode. xterm sizes its
    // own viewport from the row count passed to term.resize(); clipping the
    // host element makes xterm believe no scrollback is needed while the last
    // rows are visually outside the shell after tab/pane switches.
    terminal.style.height = "";
    terminal.style.minWidth = "0";
    terminal.style.minHeight = "0";
  }
}
function fitTerminalShell() {
  const shell = el("terminalShell");
  if (!shell) return null;
  const shellStyle =
    typeof getComputedStyle === "function" ? getComputedStyle(shell) : { display: "", visibility: "" };
  const shellRects = typeof shell.getClientRects === "function" ? shell.getClientRects() : null;
  if (
    shellStyle.display === "none" ||
    shellStyle.visibility === "hidden" ||
    (shellRects && shellRects.length === 0)
  )
    return null;
  const rect = shell.getBoundingClientRect();
  return {
    width: Math.max(0, Math.floor(shell.clientWidth || rect.width)),
    height: Math.max(0, Math.floor(shell.clientHeight || rect.height)),
  };
}
function browserTerminalSize() {
  const shell = el("terminalShell");
  if (!shell) return null;
  const shellSize = fitTerminalShell();
  if (!shellSize) return null;
  const fit = HerdrTerminalScroll.fitSize(shell, term, { minCols: 1, minRows: 1 });
  return { cols: fit.cols, rows: fit.rows };
}
function shouldFitFocusedWebTerminal() {
  return !document.hidden && (!document.hasFocus || document.hasFocus());
}
function shouldAutoFitDetachedTerminal() {
  if (options.fitToBrowser) return false;
  const fit = browserTerminalSize();
  if (!fit) return false;
  const singlePane = (state.layoutPaneCount || 1) === 1;
  return (
    singlePane &&
    state.layoutCols === state.termCols &&
    state.layoutRows === state.termRows &&
    (fit.cols > state.termCols || fit.rows > state.termRows)
  );
}
function fitFocusedTerminal() {
  if (!state.terminalId || !shouldFitFocusedWebTerminal()) return;
  const fit = browserTerminalSize();
  if (!fit) return;
  state.termCols = fit.cols;
  state.termRows = fit.rows;
  connectTerminal();
}
window.addEventListener("resize", () => {
  if (resizeFramePending) return;
  resizeFramePending = true;
  requestAnimationFrame(() => {
    resizeFramePending = false;
    fitTerminalShell();
    if (
      options.fitToBrowser ||
      shouldFitFocusedWebTerminal() ||
      shouldAutoFitDetachedTerminal()
    ) {
      const fit = browserTerminalSize();
      if (fit) {
        state.termCols = fit.cols;
        state.termRows = fit.rows;
        connectTerminal();
      }
    }
  });
});
window.addEventListener("focus", () =>
  requestAnimationFrame(fitFocusedTerminal),
);
function wsUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  const session =
    state.session && state.session !== "default"
      ? sep + "session=" + encodeURIComponent(state.session)
      : "";
  return (
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    path +
    session
  );
}
function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
