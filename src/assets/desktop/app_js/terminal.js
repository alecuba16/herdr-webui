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
      scheduleRefresh(eventNeedsFastRefresh(kind) ? 50 : 500);
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
  const cols = state.termCols || 100,
    rows = state.termRows || 30,
    size = `${cols}x${rows}`;
  const target = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}`;
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
  if (!term) {
    term = new Terminal({
      convertEol: false,
      fontFamily: terminalFontFamily(),
      theme: terminalTheme(),
      scrollback: 10000,
    });
    term.open(terminal);
    if (term.attachCustomWheelEventHandler)
      term.attachCustomWheelEventHandler((e) => {
        if (e.altKey) {
          if (typeof e.preventDefault === "function") e.preventDefault();
          scrollBrowserOverflow(e.deltaX, e.deltaY);
          return false;
        }
        if (e.deltaY && terminalUsesNormalBuffer()) {
          if (typeof e.preventDefault === "function") e.preventDefault();
          scrollLocalTerminal(e.deltaY < 0 ? "up" : "down", terminalWheelLines(e));
          return false;
        }
        return true;
      });
    applyTerminalLinks();
    applyTheme();
    term.onData(sendInputData);
    if (!terminalScrollFollowBound && term.onScroll) {
      term.onScroll(() => {
        setTerminalFollowPaused(!terminalAtBottom());
      });
      terminalScrollFollowBound = true;
    }
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
          pasteToTerminal(shiftEnterSequence());
          return false;
        }
        if (
          e.type === "keydown" &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "PageUp" || e.key === "PageDown")
        ) {
          if (terminalUsesNormalBuffer()) {
            e.preventDefault();
            scrollLocalTerminal(e.key === "PageUp" ? "up" : "down", Math.max(1, (state.termRows || rows) - 1));
            return false;
          }
          sendBackendScroll(
            e.key === "PageUp" ? "up" : "down",
            Math.max(1, (state.termRows || rows) - 1),
          );
          return false;
        }
        return true;
      });
  }
  if (!termScrollBound) {
    el("terminalShell").addEventListener(
      "paste",
      (e) => {
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteToTerminal(text);
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
    el("terminalShell").addEventListener("mousedown", () =>
      setTimeout(focusTerminal, 0),
    );
    el("terminalShell").addEventListener("wheel", handleTerminalWheel, {
      passive: false,
    });
    el("terminalShell").addEventListener("touchstart", handleTerminalTouchStart, {
      passive: true,
    });
    el("terminalShell").addEventListener("touchmove", handleTerminalTouchMove, {
      passive: false,
    });
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
    if (termWs === ws) focusTerminal();
  };
  ws.onmessage = (e) => {
    if (termWs !== ws || connectedTerminalId !== target) return;
    setTerminalLoading(false);
    enqueueTerminalFrame(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  };
  ws.onclose = () => {
    if (termWs === ws) {
      flushTerminalFramesFor(target);
      termWs = null;
      connectedTerminalId = null;
      connectedSize = "";
      setTerminalLoading(false);
      scheduleRefresh();
    }
  };
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
function enqueueTerminalFrame(data) {
  terminalWriteQueue.push({ terminalId: connectedTerminalId, data });
  if (terminalWriteFlushPending) return;
  terminalWriteFlushPending = true;
  requestAnimationFrame(flushTerminalFrames);
}
function flushTerminalFrames() {
  terminalWriteFlushPending = false;
  if (!terminalWriteQueue.length || !term) return;
  const terminalId = connectedTerminalId;
  const frames = takeTerminalFrames(terminalId);
  if (!frames.length) return;
  const data = coalesceTerminalFrames(frames);
  writeTerminalFrame(data);
  clearDismissedWorkingForTerminal(state.terminalId);
  scheduleTerminalFrameWork();
}
function flushTerminalFramesFor(terminalId) {
  if (!terminalWriteQueue.length || !term || !terminalId) return;
  const frames = takeTerminalFrames(terminalId);
  if (!frames.length) return;
  writeTerminalFrame(coalesceTerminalFrames(frames));
  clearDismissedWorkingForTerminal(terminalId);
  scheduleTerminalFrameWork();
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
function terminalUsesNormalBuffer() {
  try {
    return !term || !term.buffer || !term.buffer.active || term.buffer.active.type !== "alternate";
  } catch (e) {
    return true;
  }
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
  terminalFollowPaused = !!paused;
  updateTerminalFollowButton();
}
function updateTerminalFollowButton() {
  const button = el("terminalFollowButton");
  if (!button) return;
  button.hidden = !terminalFollowPaused;
  button.setAttribute("aria-hidden", terminalFollowPaused ? "false" : "true");
}
function writeTerminalFrame(data) {
  const shouldPreserve = terminalFollowPaused && !terminalAtBottom();
  const viewportY = shouldPreserve && term && term.buffer ? term.buffer.active.viewportY : null;
  const done = () => {
    if (shouldPreserve && Number.isFinite(viewportY)) {
      try {
        term.scrollToLine(viewportY);
      } catch (e) {}
    }
    setTerminalFollowPaused(!terminalAtBottom());
  };
  try {
    term.write(data, done);
  } catch (e) {
    term.write(data);
    done();
  }
}
function scrollTerminalToBottom() {
  setTerminalFollowPaused(false);
  try {
    if (term) term.scrollToBottom();
  } catch (e) {}
  focusTerminal(true);
}
function scrollLocalTerminal(direction, lines) {
  let scrolled = false;
  try {
    if (!term) return false;
    if (typeof term.scrollLines === "function") {
      term.scrollLines(direction === "up" ? -lines : lines);
      scrolled = true;
    } else if (typeof term.scrollToLine === "function" && term.buffer && term.buffer.active) {
      const buffer = term.buffer.active;
      const maxLine = Math.max(0, Number(buffer.baseY) || 0);
      const currentLine = Math.max(0, Number(buffer.viewportY) || 0);
      const nextLine = Math.max(
        0,
        Math.min(maxLine, currentLine + (direction === "up" ? -lines : lines)),
      );
      term.scrollToLine(nextLine);
      scrolled = true;
    } else {
      return false;
    }
  } catch (e) {}
  if (!scrolled) return false;
  setTerminalFollowPaused(!terminalAtBottom());
  return true;
}
function terminalWheelLines(event) {
  const rowHeight =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell &&
    term._core._renderService.dimensions.css.cell.height;
  const unit =
    event.deltaMode === 1
      ? 1
      : event.deltaMode === 2
        ? state.termRows || 24
        : Math.max(1, rowHeight || 17);
  return Math.max(1, Math.round(Math.abs(event.deltaY) / unit));
}
function handleTerminalWheel(event) {
  if (!event || event.altKey || !event.deltaY || !terminalUsesNormalBuffer()) return;
  if (scrollLocalTerminal(event.deltaY < 0 ? "up" : "down", terminalWheelLines(event))) {
    event.preventDefault();
    event.stopPropagation();
  }
}
function handleTerminalTouchStart(event) {
  const touch = event && event.touches && event.touches[0];
  handleTerminalTouchStart.lastY = touch ? touch.clientY : null;
}
function handleTerminalTouchMove(event) {
  const touch = event && event.touches && event.touches[0];
  if (!touch || !terminalUsesNormalBuffer()) return;
  const lastY = handleTerminalTouchStart.lastY;
  handleTerminalTouchStart.lastY = touch.clientY;
  if (!Number.isFinite(lastY)) return;
  const dy = lastY - touch.clientY;
  if (Math.abs(dy) < 4) return;
  const rowHeight =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell &&
    term._core._renderService.dimensions.css.cell.height;
  const lines = Math.max(
    1,
    Math.round(Math.abs(dy) / Math.max(1, rowHeight || 17)),
  );
  if (scrollLocalTerminal(dy < 0 ? "up" : "down", lines)) {
    event.preventDefault();
    event.stopPropagation();
  }
}
function modalOpen() {
  return [
    "settingsModal",
    "workspaceCreateModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "shortcutsModal",
    "searchPalette",
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
function scheduleTerminalFrameWork() {
  if (Date.now() < pasteFrameUntil) return;
  if (terminalFramePending) return;
  terminalFramePending = true;
  requestAnimationFrame(() => {
    terminalFramePending = false;
    fitTerminalShell();
    fitTerminalSurface();
    focusTerminal();
  });
}
function sendBackendScroll(direction, lines, cell, modifiers = 0) {
  if (termWs && termWs.readyState === 1)
    termWs.send(
      JSON.stringify({
        type: "scroll",
        direction,
        lines,
        column: cell && cell.column,
        row: cell && cell.row,
        modifiers,
      }),
    );
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
  if (text) pasteToTerminal(text);
  hideClipboardMenu();
}
function sendInputData(data) {
  if (!termWs || termWs.readyState !== 1 || !data) return;
  const bytes = inputEncoder.encode(data);
  const chunkSize = 16 * 1024;
  if (
    bytes.length <= chunkSize &&
    inputQueue.length === 0 &&
    termWs.bufferedAmount < 65536
  ) {
    termWs.send(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i += chunkSize)
    inputQueue.push(bytes.slice(i, i + chunkSize));
  scheduleInputFlush();
}
function scheduleInputFlush() {
  if (inputFlushTimer) return;
  inputFlushTimer = setTimeout(flushInputQueue, 4);
}
function flushInputQueue() {
  inputFlushTimer = null;
  if (!termWs || termWs.readyState !== 1) {
    inputQueue = [];
    return;
  }
  while (inputQueue.length && termWs.bufferedAmount < 65536)
    termWs.send(inputQueue.shift());
  if (inputQueue.length) scheduleInputFlush();
}
function finishPasteFrameSoon() {
  setTimeout(() => {
    pasteFrameUntil = 0;
    scheduleTerminalFrameWork();
  }, 250);
}
function pasteToTerminal(text) {
  if (!termWs || termWs.readyState !== 1 || !text) return;
  const input = terminalPasteInput(
    text,
    !!(term && term.modes && term.modes.bracketedPasteMode),
  );
  const bytes = inputEncoder.encode(input);
  pasteFrameUntil = Date.now() + 250;
  if (
    bytes.length <= 64 * 1024 &&
    inputQueue.length === 0 &&
    termWs.bufferedAmount < 1024 * 1024
  ) {
    termWs.send(bytes);
    finishPasteFrameSoon();
    return;
  }
  sendInputData(input);
  finishPasteFrameSoon();
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
  const x = terminal.querySelector(".xterm");
  const screen = terminal.querySelector(".xterm-screen");
  const viewport = terminal.querySelector(".xterm-viewport");
  const rowsEl = terminal.querySelector(".xterm-rows");
  const helper = terminal.querySelector(".xterm-helper-textarea");
  if (!x || !screen) return;
  const cols = state.termCols || 100,
    rows = state.termRows || 30;
  const dims =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell;
  const firstRow = rowsEl && rowsEl.firstElementChild;
  const cellWidth =
    (dims && dims.width) ||
    (firstRow && firstRow.getBoundingClientRect().width) / cols ||
    9;
  const rowHeight =
    (dims && dims.height) ||
    (firstRow && firstRow.getBoundingClientRect().height) ||
    17;
  const width = Math.ceil(cellWidth * cols);
  const height = Math.ceil(rowHeight * rows);
  if (options.overflow) {
    terminal.style.width = width + "px";
    terminal.style.height = height + "px";
    terminal.style.minWidth = width + "px";
    terminal.style.minHeight = height + "px";
    x.style.width = width + "px";
    x.style.height = height + "px";
    x.style.minWidth = width + "px";
    x.style.minHeight = height + "px";
  } else {
    terminal.style.width = "100%";
    terminal.style.height = "100%";
    terminal.style.minWidth = "0";
    terminal.style.minHeight = "0";
    x.style.width = "100%";
    x.style.height = "100%";
    x.style.minWidth = "0";
    x.style.minHeight = "0";
  }
  screen.style.width = width + "px";
  screen.style.height = height + "px";
  if (viewport) viewport.style.height = height + "px";
  if (rowsEl) {
    rowsEl.style.width = width + "px";
    rowsEl.style.height = height + "px";
  }
  if (helper) {
    helper.style.width = width + "px";
    helper.style.height = height + "px";
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
  const width = Math.max(80, shellSize.width - 16);
  const height = Math.max(24, shellSize.height - 16);
  const dims =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell;
  const cellWidth = (dims && dims.width) || 9;
  const cellHeight = (dims && dims.height) || 17;
  return {
    cols: Math.max(80, Math.floor(width / cellWidth)),
    rows: Math.max(24, Math.floor(height / cellHeight)),
  };
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
function scrollBrowserOverflow(dx, dy) {
  const shell = el("terminalShell");
  if (!shell) return;
  const maxTop = Math.max(0, shell.scrollHeight - shell.clientHeight);
  const maxLeft = Math.max(0, shell.scrollWidth - shell.clientWidth);
  shell.scrollTop = Math.max(0, Math.min(maxTop, shell.scrollTop + dy));
  shell.scrollLeft = Math.max(0, Math.min(maxLeft, shell.scrollLeft + dx));
}
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
