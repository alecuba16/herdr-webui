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
    refreshTerminalAfterFontLoad(target);
    applyTheme();
    term.onData(sendInputData);
    if (!terminalScrollFollowBound && term.onScroll) {
      term.onScroll(() => {
        terminalFollowPaused = !terminalAtBottom();
        updateTerminalFollowButton();
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
      "wheel",
      (e) => {
        if (wheelOnShellScrollbar(e)) return;
        if (e.altKey) {
          e.preventDefault();
          scrollBrowserOverflow(e.deltaX, e.deltaY);
          return;
        }
        if (terminalUsesNormalBuffer()) {
          requestAnimationFrame(() => {
            terminalFollowPaused = !terminalAtBottom();
            updateTerminalFollowButton();
          });
          return;
        }
        if (!termWs || termWs.readyState !== 1) return;
        e.preventDefault();
        const delta =
          Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const scroll = terminalWheelScrollBatch(
          wheelScrollRemainder,
          delta,
          e.deltaMode,
          options.scrollLines,
          state.termRows || rows,
        );
        wheelScrollRemainder = scroll.remainder;
        if (!scroll.lines) return;
        sendBackendScroll(
          scroll.direction,
          scroll.lines,
          mouseCell(e),
          mouseModifiers(e),
        );
      },
      { passive: false },
    );
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
    writeTerminalFrame(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    clearDismissedWorkingForTerminal(state.terminalId);
    scheduleTerminalFrameWork();
  };
  ws.onclose = () => {
    if (termWs === ws) {
      termWs = null;
      connectedTerminalId = null;
      connectedSize = "";
      setTerminalLoading(false);
      scheduleRefresh();
    }
  };
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
function updateTerminalFollowButton() {
  const button = el("terminalFollowButton");
  if (!button) return;
  button.hidden = !terminalFollowPaused;
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
    terminalFollowPaused = !terminalAtBottom();
    updateTerminalFollowButton();
  };
  try {
    term.write(data, done);
  } catch (e) {
    term.write(data);
    done();
  }
}
function scrollTerminalToBottom() {
  terminalFollowPaused = false;
  try {
    if (term) term.scrollToBottom();
  } catch (e) {}
  updateTerminalFollowButton();
  focusTerminal(true);
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
function refreshTerminalAfterFontLoad(target) {
  if (!document.fonts || !document.fonts.load) return;
  Promise.all([
    document.fonts.load('14px "Herdr JetBrainsMono Nerd Font Mono"'),
    document.fonts.ready,
  ])
    .then(() => {
      if (!term || connectedTerminalId !== target) return;
      applyTerminalFont();
      fitTerminalSurface();
      try {
        term.refresh(0, Math.max(0, (term.rows || 1) - 1));
      } catch (_) {}
    })
    .catch(() => {});
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
function mouseCell(e) {
  const screen = terminal.querySelector(".xterm-screen");
  const rowsEl = terminal.querySelector(".xterm-rows");
  if (!screen || !rowsEl) return null;
  const rect = screen.getBoundingClientRect();
  if (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  )
    return null;
  const colWidth = rect.width / (state.termCols || 100);
  const rowHeight = rect.height / (state.termRows || 30);
  if (!colWidth || !rowHeight) return null;
  return {
    column: Math.max(
      0,
      Math.min(
        (state.termCols || 100) - 1,
        Math.floor((e.clientX - rect.left) / colWidth),
      ),
    ),
    row: Math.max(
      0,
      Math.min(
        (state.termRows || 30) - 1,
        Math.floor((e.clientY - rect.top) / rowHeight),
      ),
    ),
  };
}
function mouseModifiers(e) {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
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
  const chunkSize = 2048;
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
    bytes.length <= 32 * 1024 * 1024 &&
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
  terminal.style.width = width + "px";
  terminal.style.height = height + "px";
  terminal.style.minWidth = width + "px";
  terminal.style.minHeight = height + "px";
  x.style.width = width + "px";
  x.style.height = height + "px";
  x.style.minWidth = width + "px";
  x.style.minHeight = height + "px";
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
  const main = document.querySelector(".main");
  const tabsEl = document.querySelector(".tabs");
  const shell = el("terminalShell");
  if (!main || !tabsEl || !shell) return;
  const m = main.getBoundingClientRect();
  const t = tabsEl.getBoundingClientRect();
  shell.style.width = Math.max(0, Math.floor(m.width)) + "px";
  shell.style.height = Math.max(0, Math.floor(m.height - t.height)) + "px";
}
function browserTerminalSize() {
  fitTerminalShell();
  const shell = el("terminalShell");
  if (!shell) return null;
  const width = Math.max(80, shell.clientWidth - 16);
  const height = Math.max(24, shell.clientHeight - 16);
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
function wheelOnShellScrollbar(e) {
  const shell = el("terminalShell");
  if (!shell) return false;
  const r = shell.getBoundingClientRect();
  const vertical =
    shell.scrollHeight > shell.clientHeight && e.clientX >= r.right - 14;
  const horizontal =
    shell.scrollWidth > shell.clientWidth && e.clientY >= r.bottom - 14;
  return vertical || horizontal;
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
