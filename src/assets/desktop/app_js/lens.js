// Chat lens over the terminal (ux overhaul backlog 2/3).
//
// Renders the pane transcript as a centered column over the STILL-ATTACHED
// terminal surface: no second connection is created when switching lens
// (the reference pattern's core invariant). The transcript is read from the
// live wterm bridge in the page — the same source the selection capture
// uses — so it stays live while the terminal socket keeps receiving frames.
//
// Turn heuristics (protocol 22 has no structured transcript): a line that
// starts with a shell prompt marker (`❯`, `›`, `$`, or the pane's cwd tail
// followed by one) renders as a right-aligned user card containing just
// that prompt line; every following line is plain output. Wrapped typed
// input degrades to a plain output line — better to under-card than to
// swallow command output into the user's card.
//
// Auto-follow: scrolled-to-bottom sticks to the tail; scrolling up stops
// follow and shows a "New output" pill that resumes on click.
(function () {
  let lensActive = false;
  let follow = true;
  let unread = false;
  let lastRenderedLineCount = -1;

  const PROMPT_LINE = /(?:❯|›|➜)\s+|\$\s+/;

  function shellElement() {
    return document.getElementById("terminalShell");
  }

  function bridge() {
    // `term` is the shared adapter instance (core.js scope). The bridge is
    // the live VT core with scrollback access.
    if (typeof term === "undefined" || !term || !term.wterm || !term.wterm.bridge)
      return null;
    return term.wterm.bridge;
  }

  function readLine(core, index, cols) {
    // Scrollback rows come before the live grid: index < count is
    // scrollback, then the visible grid.
    const count = core.getScrollbackCount();
    const len = index < count ? core.getScrollbackLineLen(index) : cols;
    let text = "";
    for (let col = 0; col < len; col++) {
      const cell = index < count ? core.getScrollbackCell(index, col) : core.getCell(index - count, col);
      if (!cell || cell.width === 0 || cell.spacerHead) continue;
      text += cell.chars || String.fromCodePoint(cell.char || 32);
    }
    return text.replace(/\s+$/, "");
  }

  function readTranscript() {
    const core = bridge();
    if (!core) return [];
    try {
      if (core.usingAltScreen && core.usingAltScreen()) return [];
      const cols = core.getCols();
      const count = core.getScrollbackCount();
      const rows = core.getRows();
      const lines = [];
      // Bound the read to the last 400 lines: the lens is a reading surface,
      // not an export tool, and this keeps the re-read cheap on refresh.
      const total = count + rows;
      const start = Math.max(0, total - 400);
      for (let i = start; i < total; i++) lines.push(readLine(core, i, cols));
      // Drop leading blank lines so the transcript starts at content.
      while (lines.length && !lines[0].trim()) lines.shift();
      // Drop trailing blank grid rows: the prompt sits mid-grid and the
      // rows below it are empty padding.
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines;
    } catch (_) {
      return [];
    }
  }

  function transcriptHtml(lines) {
    const out = [];
    for (const line of lines) {
      if (PROMPT_LINE.test(line)) {
        out.push({ kind: "user", text: line });
      } else if (!line.trim()) {
        if (out.length && out[out.length - 1].kind !== "gap")
          out.push({ kind: "gap", text: "" });
      } else {
        out.push({ kind: "out", text: line });
      }
    }
    return out
      .map((entry) => {
        if (entry.kind === "gap") return `<div class="lens-gap"></div>`;
        if (entry.kind === "user")
          return `<div class="lens-turn lens-turn-user"><span>${escapeHtml(entry.text)}</span></div>`;
        return `<div class="lens-line">${escapeHtml(entry.text)}</div>`;
      })
      .join("");
  }

  function overlay() {
    let node = document.getElementById("terminalLens");
    if (!node) {
      const shell = shellElement();
      if (!shell) return null;
      node = document.createElement("div");
      node.id = "terminalLens";
      node.className = "terminal-lens";
      node.setAttribute("role", "region");
      node.setAttribute("aria-label", "Chat transcript view of this panel");
      node.innerHTML =
        '<div class="terminal-lens-scroller" id="terminalLensScroller" tabindex="0">' +
        '<div class="terminal-lens-content"></div></div>' +
        '<div class="terminal-lens-alt" id="terminalLensAlt" hidden ' +
        'role="status">An interactive app is using this panel \u2014 switch to Terminal to use it</div>' +
        '<button type="button" class="terminal-lens-new pill" id="terminalLensNew" hidden ' +
        'aria-label="Resume following latest output">New output</button>';
      shell.appendChild(node);
      const scroller = node.querySelector("#terminalLensScroller");
      if (scroller) {
        scroller.addEventListener("scroll", () => {
          const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
          if (atBottom) {
            follow = true;
            unread = false;
            const pill = node.querySelector("#terminalLensNew");
            if (pill) pill.hidden = true;
          } else {
            follow = false;
          }
        });
      }
      const pill = node.querySelector("#terminalLensNew");
      if (pill) {
        pill.onclick = () => {
          follow = true;
          unread = false;
          pill.hidden = true;
          render();
          const sc = node.querySelector("#terminalLensScroller");
          if (sc) sc.scrollTop = sc.scrollHeight;
        };
      }
    }
    return node;
  }

  function render() {
    const node = overlay();
    if (!node || !lensActive) return;
    const lines = readTranscript();
    const content = node.querySelector(".terminal-lens-content");
    if (!content) return;
    // Skip the DOM write when the transcript did not change since the last
    // render: the lens re-reads on every refresh tick and most ticks are
    // idle (no new output). `dirty` is set by onTerminalFrame when bytes
    // landed, so same-length rewrites (spinner redraws) still refresh.
    const changed = content.dataset.dirty === "1" || lines.length !== lastRenderedLineCount;
    if (changed) {
      // New tail while the reader scrolled up: surface the resume pill.
      if (!follow && lines.length > lastRenderedLineCount) unread = true;
      content.innerHTML = transcriptHtml(lines);
      content.dataset.dirty = "0";
      lastRenderedLineCount = lines.length;
      // Scroll only when the transcript actually moved: setting scrollTop
      // on every tick forced a layout read even with no new output.
      const scroller = node.querySelector("#terminalLensScroller");
      if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    const pill = node.querySelector("#terminalLensNew");
    if (pill) pill.hidden = !(unread && !follow);
    // Alt-screen app running (vim, less, htop): the transcript is not the
    // live surface anymore. Say so instead of showing a frozen pane.
    // Skip while the attach overlay is up: a dead/unattached pane reports
    // alt-screen true and would flash a wrong hint over the skeleton.
    const altHint = node.querySelector("#terminalLensAlt");
    if (altHint) {
      const loading = document.getElementById("terminalLoading");
      const loadingUp = !!(loading && loading.classList.contains("show"));
      altHint.hidden = loadingUp || !usingAltScreen();
    }
  }

  function usingAltScreen() {
    const core = bridge();
    try {
      return !!(core && core.usingAltScreen && core.usingAltScreen());
    } catch (_) {
      return false;
    }
  }

  function setLens(active) {
    lensActive = !!active;
    const node = overlay();
    if (!node) return;
    node.hidden = !lensActive;
    const shell = shellElement();
    if (shell) shell.classList.toggle("lens-active", lensActive);
    if (lensActive) {
      follow = true;
      unread = false;
      lastRenderedLineCount = -1;
      contentDirty();
      render();
      // The lens fully covers the terminal while open: pause wterm's
      // paints so the covered grid does not double-render under the
      // overlay. Re-enabled on close; wterm re-checks visibility on its
      // own for background tabs.
      setCoveredRendering(true);
      const scroller = node.querySelector("#terminalLensScroller");
      if (scroller) scroller.focus({ preventScroll: true });
      // The terminal keeps its socket; refit is unnecessary because the
      // terminal element stays at its geometry (the lens overlays it).
    } else {
      setCoveredRendering(false);
      // Returning to the terminal view must restore typing: the lens
      // scroller held focus while open, so hand it back explicitly.
      if (typeof focusTerminal === "function") {
        try { focusTerminal(true); } catch (_) {}
      }
    }
    // The composer rides with the lens: same surface, same visibility,
    // and it swaps its per-pane draft when the pane changes.
    if (globalThis.HerdrComposer) globalThis.HerdrComposer.sync();
    syncLensToggleUi();
  }

  // wterm exposes setRenderingPaused(bool): while the opaque lens covers the
  // terminal its paints are wasted main-thread work under heavy streaming.
  // Best effort: older bundles without the API keep rendering as before.
  function setCoveredRendering(paused) {
    try {
      const adapter = typeof term !== "undefined" && term ? term : null;
      const renderer = adapter && adapter.wterm ? adapter.wterm : null;
      if (renderer && typeof renderer.setRenderingPaused === "function")
        renderer.setRenderingPaused(paused);
    } catch (_) {}
  }

  function onPaneChanged() {
    // Called from connectTerminal on every pane/terminal switch: reading
    // state is per-pane. Without the reset, follow/unread and the change
    // detection baseline leaked from the previous pane.
    follow = true;
    unread = false;
    lastRenderedLineCount = -1;
    if (lensActive) {
      contentDirty();
      render();
    }
  }

  function contentDirty() {
    const node = document.getElementById("terminalLens");
    if (node) {
      const content = node.querySelector(".terminal-lens-content");
      if (content) content.dataset.dirty = "1";
    }
  }

  function toggleLens() {
    setLens(!lensActive);
  }

  function lensState() {
    return { active: lensActive, follow, unread };
  }

  function isActive() {
    return lensActive;
  }

  function onTerminalFrame() {
    // Called from the terminal write path: new bytes landed, so the next
    // lens render must re-read even if the line count is unchanged
    // (rewrites of the same tail, spinner redraws).
    if (!lensActive) return;
    contentDirty();
    render();
  }

  function syncLensToggleUi() {
    const toggle = document.getElementById("lensToggleChat");
    if (toggle) toggle.setAttribute("aria-pressed", lensActive ? "true" : "false");
    const terminalToggle = document.getElementById("lensToggleTerminal");
    if (terminalToggle)
      terminalToggle.setAttribute("aria-pressed", lensActive ? "false" : "true");
  }

  function insertLensSwitch() {
    // The segmented Chat|Terminal control overlays the shell's top-right
    // corner; the terminal surface itself is untouched.
    let node = document.getElementById("terminalLensSwitch");
    if (node) return;
    const shell = shellElement();
    if (!shell) return;
    node = document.createElement("div");
    node.id = "terminalLensSwitch";
    node.className = "terminal-lens-switch segmented";
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Panel view");
    node.innerHTML =
      '<button type="button" id="lensToggleChat" aria-pressed="false" onclick="HerdrLens.toggle()">Chat</button>' +
      '<button type="button" id="lensToggleTerminal" aria-pressed="true" onclick="HerdrLens.toggle()">Terminal</button>';
    shell.appendChild(node);
  }

  globalThis.HerdrLens = {
    insertLensSwitch,
    toggle: toggleLens,
    setLens,
    render,
    readTranscript,
    isActive,
    lensState,
    onTerminalFrame,
    onPaneChanged,
    // Test/diagnostic surface: the turn-shaping heuristics.
    transcriptHtml,
    PROMPT_LINE,
  };
})();
