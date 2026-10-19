// Prompt cards: interactive answer surface for blocked agents (backlog 3/3).
//
// Chat-mode surface ONLY: the card renders while the Chat lens is open
// (lensOpen gate in evaluate). Over the terminal view the pane's own
// dialog owns the keyboard; the card never appears there.
//
// When the selected pane's agent is blocked on a question dialog, the card
// renders the question title plus clickable options (or a free-text input).
// Two sources: the wrapper's GET /api/panes/{pane_id}/prompt returns a
// structured payload parsed server-side from the pane tail (preferred; see
// fetchServerPrompt), and the local grid parse below covers the fallback
// cases (old server without the route, the frame before the first fetch
// lands). Both shapes match the dialogs the backend's blocked detectors
// already recognize (numbered option lists, ↑↓ select hints, "enter your
// response" free-text prompts), plus the jcode Permissions viewer
// (letter options a/d/A/D), which the numbered branch alone would miss.
//
// Answering synthesizes keypresses through the same sendInputData path the
// terminal uses: option N -> "N\r", free text -> typed text + "\r". No new
// wire frames. The card is derived state only: every status change or
// terminal frame re-evaluates the parse against the CURRENT tail before
// sending, so a stale card can never send stale input.
(function () {
  let dismissedFor = null; // question title+options the user collapsed/answered
  let lastCardKey = "";
  let wasBlocked = false; // blocked-episode tracking

  // Server-side prompt parse (GET /api/panes/{pane_id}/prompt): the backend
  // reads the pane tail and runs the same parser the TUI prompt cards use,
  // returning {blocked, kind, title, options}. Preferred while available;
  // the local grid parse stays as the fallback (old server, the frame
  // before the first fetch lands, and after a failed request sticks the
  // endpoint off for the session: the snapshotBootstrap pattern).
  let promptApiUsable = true;
  let serverPrompt = null; // { at, payload } from the last endpoint hit
  let promptFetchInFlight = false;
  let promptFetchAt = 0;
  const SERVER_PROMPT_FRESH_MS = 15000;
  const SERVER_PROMPT_FETCH_MS = 750;

  const OPTION_LINE = /^[>\s]*([0-9]+)[.)]\s+(.+)$/;
  const NAV_HINT = /↑↓\s*select|↑\/↓/;
  const FREE_TEXT = /enter your response|type your answer|enter send/i;
  // jcode ask_user chooser (ui_inline.rs): hint lines "1-9 or ↑↓ + Enter
  // to choose · type on Your answer · Esc dismisses" and "Enter sends ·
  // Shift/Alt+Enter newline · Esc dismisses", plus the "N. Your answer"
  // row itself. "Enter sends" matches FREE_TEXT and "Type your own
  // answer" nearly matches "type your answer", so without this guard
  // the chooser tail parses as a free-text card with a garbage title.
  const JCODE_CHOOSER = /1-9 or ↑↓ \+ Enter to choose|type on Your answer|\. Your answer/i;
  const QUESTION_LINE = /^\s*(?:❯|›|➜|\$)\s*(.+?)(?:\?+)?\s*$|^\s*\?+\s*(.+)$/;
  // jcode Permissions viewer markers (jcode-tui-permissions), the same
  // lines the backend's jcode_blocked detector scrapes. Both the help row
  // and the waiting line must be present: transcript or docs text quoting
  // one of them is not a live viewer.
  const JCODE_VIEWER_HELP = /a approve.*d deny.*A approve all.*D deny all/i;
  const JCODE_VIEWER_WAITING = /agent is waiting for this decision/i;
  const JCODE_VIEWER_TITLE = /permissions?\s*\((\d+)\s*pending\)/i;
  const CONFIRM_HINT = /enter (?:to )?(?:confirm|select|choose|submit)|press enter|return to (?:confirm|select)/i;

  function shellElement() {
    return document.getElementById("terminalShell");
  }

  // Chat-mode gate: question cards are a chat-mode surface only. While
  // the Chat lens is closed the terminal view owns input, so the card
  // must stay hidden there (the lens's own decision part covers chat
  // mode answering).
  function lensOpen() {
    try {
      return !!(
        globalThis.HerdrLens &&
        globalThis.HerdrLens.isActive &&
        globalThis.HerdrLens.isActive()
      );
    } catch (_) {
      return false;
    }
  }

  function bridge() {
    if (typeof term === "undefined" || !term || !term.wterm || !term.wterm.bridge)
      return null;
    return term.wterm.bridge;
  }

  // Last non-empty lines of the visible tail (grid only; question dialogs
  // paint the bottom of the screen and are not in scrollback).
  function tailLines(max = 16) {
    const core = bridge();
    if (!core) return [];
    try {
      if (core.usingAltScreen && core.usingAltScreen()) return [];
      const cols = core.getCols();
      const rows = core.getRows();
      const lines = [];
      for (let r = 0; r < rows; r++) {
        let text = "";
        for (let c = 0; c < cols; c++) {
          const cell = core.getCell(r, c);
          if (!cell || cell.width === 0 || cell.spacerHead) continue;
          text += cell.chars || String.fromCodePoint(cell.char || 32);
        }
        lines.push(text.replace(/\s+$/, ""));
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.slice(-max);
    } catch (_) {
      return [];
    }
  }

  // Parse a question dialog from the tail. Returns null when the tail does
  // not match any known blocked-question shape.
  function parsePrompt(lines) {
    if (!lines.length) return null;
    // Unicode whitespace parity with the Rust parser: JS `\s` and Rust
    // regex `\s` disagree on BOM and NEL. Normalize the exotic spaces to
    // plain space so both parser copies match identically on terminals
    // that emit NBSP/NEL/U+3000/BOM/LS/PS.
    lines = lines.map((line) =>
      line.replace(/[\u00a0\u0085\u3000\ufeff\u2028\u2029]/g, " "),
    );
    const joined = lines.join("\n");
    // jcode ask_user chooser (ui_inline.rs): its hint lines carry "Enter
    // sends ..." and "Type your own answer", which the generic FREE_TEXT
    // regex mistakes for a free-text dialog, and a shell tail above the
    // chooser then becomes the "title". The chooser renders its own
    // numbered rows plus an "N. Your answer" entry; the chat lens
    // decision part is the answer surface there, so parse nothing here.
    if (JCODE_CHOOSER.test(joined)) return null;
    // Take the LAST contiguous numbered block: an older dialog may still be
    // on screen above; the active one is the newest.
    const blocks = [];
    let current = [];
    for (const line of lines) {
      const m = line.match(OPTION_LINE);
      if (m) current.push({ key: m[1], label: m[2].trim() });
      else if (current.length) {
        blocks.push(current);
        current = [];
      }
    }
    if (current.length) blocks.push(current);
    const options = blocks.length ? blocks[blocks.length - 1] : [];
    let title = "";
    // jcode Permissions viewer: letter options go straight to the viewer
    // (a approve, d deny, A/D bulk). Checked first: its tail also contains
    // "approve"/"deny" words that would otherwise fall through to the
    // weaker numbered branch.
    if (JCODE_VIEWER_HELP.test(joined) && JCODE_VIEWER_WAITING.test(joined)) {
      const pending = (joined.match(JCODE_VIEWER_TITLE) || [])[1] || "?";
      return {
        kind: "options",
        title: `jcode permissions (${pending} pending)`,
        options: [
          { key: "a", label: "Approve" },
          { key: "d", label: "Deny" },
          { key: "A", label: "Approve all" },
          { key: "D", label: "Deny all" },
        ],
      };
    }
    // Free-text prompt: a question line + "enter your response" hint.
    if (FREE_TEXT.test(joined)) {
      title = questionTitle(lines);
      if (title) return { kind: "text", title };
      return null;
    }
    // Navigation dialog: ↑↓ hint + numbered options (Kimi/jcode-style).
    if (NAV_HINT.test(joined) || /esc cancel|esc dismiss/i.test(joined)) {
      if (options.length >= 2) {
        title = questionTitle(lines) || "Select an option";
        return { kind: "options", title, options };
      }
      return null;
    }
    // Numbered confirmation without nav hint (permission dialogs). The
    // option block must sit at the tail end or carry a confirm hint below:
    // a numbered transcript list followed by newer output must not open a
    // card during the sub-second stale-blocked window.
    if (options.length >= 2) {
      const lower = joined.toLowerCase();
      if (/(allow|approve|yes|proceed|deny|reject|no|cancel)/.test(lower) && optionsAtTailOrConfirmed(lines, options)) {
        title = questionTitle(lines) || "Confirm action";
        return { kind: "options", title, options };
      }
    }
    return null;
  }

  // Tightening helper for the no-nav-hint numbered branch: the block must
  // be at the tail end (only blank lines after it) or followed by a
  // confirm-hint line a real dialog prints under its options.
  function optionsAtTailOrConfirmed(lines, options) {
    const lastKey = String(options[options.length - 1].key);
    let lastOptionIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(OPTION_LINE);
      if (m && m[1] === lastKey) { lastOptionIdx = i; break; }
    }
    if (lastOptionIdx < 0) return false;
    for (let i = lastOptionIdx + 1; i < lines.length; i++) {
      if (CONFIRM_HINT.test(lines[i])) return true;
    }
    for (let i = lastOptionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim()) return false;
    }
    return true;
  }

  function questionTitle(lines) {
    // Prefer the LAST line that reads like a question (ends with "?" or
    // starts with "? "): real dialogs ask their question above the
    // options. Prompt-marked captures come next; they can contain shell
    // echo noise, so they are a weaker signal.
    const clean = (s) => s.replace(/^[❯›➜$?]+\s*/, "").replace(/[?]+$/, "").trim();
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || OPTION_LINE.test(t) || NAV_HINT.test(t) || FREE_TEXT.test(t) || /^esc /i.test(t)) continue;
      if (/[?]$/.test(t) || /^\?\s/.test(t)) return clean(t);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(QUESTION_LINE);
      if (m && (m[1] || m[2])) return clean(m[1] || m[2]);
    }
    for (const line of lines) {
      const t = line.trim();
      if (t && !NAV_HINT.test(t) && !FREE_TEXT.test(t) && !OPTION_LINE.test(t) && !/^esc /i.test(t)) {
        if (t.length > 3) return clean(t);
      }
    }
    return "";
  }

  function paneBlocked() {
    try {
      const ws = (typeof state !== "undefined" && state.workspaces) ? state.workspaces.find((w) => w.workspace_id === state.ws) : null;
      if (!ws) return false;
      return (typeof statusClass === "function" ? statusClass(ws.agent_status) : ws.agent_status) === "blocked";
    } catch (_) {
      return false;
    }
  }

  function fetchServerPrompt() {
    if (!promptApiUsable || promptFetchInFlight) return;
    if (Date.now() - promptFetchAt < SERVER_PROMPT_FETCH_MS) return;
    const paneId = (typeof state !== "undefined" && state && state.pane) || null;
    if (!paneId || typeof api !== "function") return;
    promptFetchAt = Date.now();
    promptFetchInFlight = true;
    Promise.resolve(
      api("/api/panes/" + encodeURIComponent(paneId) + "/prompt"),
    ).then(
      (res) => {
        const payload = res && (res.result || res);
        serverPrompt =
          payload && typeof payload === "object"
            ? { at: Date.now(), payload }
            : null;
      },
      () => {
        // Sticky-off: one failure (old server without the route, transport
        // error) disables the endpoint for the session; local parsing only.
        promptApiUsable = false;
        serverPrompt = null;
      },
    ).then(() => {
      promptFetchInFlight = false;
    });
  }

  // Fresh server payload, or null when absent/stale/endpoint disabled.
  function serverPromptFresh() {
    if (!promptApiUsable || !serverPrompt) return null;
    if (Date.now() - serverPrompt.at > SERVER_PROMPT_FRESH_MS) return null;
    return serverPrompt.payload;
  }

  // Prompt object from a server payload, or null when the payload says
  // the pane is not blocked or carries no dialog.
  function promptFromServer(server) {
    if (!server || !server.blocked || !server.kind) return null;
    return {
      kind: server.kind,
      title: server.title || "",
      options: Array.isArray(server.options) ? server.options : [],
    };
  }

  function cardKey(prompt, tailSignature) {
    return (prompt ? prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",") : "") + "@" + tailSignature;
  }

  function evaluate() {
    const node = overlay();
    if (!node) return null;
    // User toggle (Settings > Agents and alerts): off means no card, ever.
    // Also reset episode state so re-enabling starts clean.
    if (typeof options !== "undefined" && options && options.promptCardsEnabled === false) {
      node.hidden = true;
      lastCardKey = "";
      return null;
    }
    // Chat-mode gate: question cards render only while the Chat lens is
    // open (the card is a chat-mode surface). On the terminal view the
    // pane's own dialog owns the keyboard, so hide and stay hidden; the
    // next evaluate after the lens reopens re-parses everything fresh.
    if (!lensOpen()) {
      node.hidden = true;
      lastCardKey = "";
      return null;
    }
    const blocked = paneBlocked();
    // Blocked-episode tracking: a fresh transition INTO blocked means a
    // new question (even with identical text) — clear any dismissal so the
    // card re-opens. Within one episode, dismissal sticks.
    if (blocked && !wasBlocked) {
      dismissedFor = null;
      lastCardKey = "";
    }
    wasBlocked = blocked;
    // Poll on every evaluate (rate-limited): the payload's per-pane
    // blocked flag from agent.list is sharper than the workspace status,
    // so the fetch runs even when the workspace says not blocked.
    fetchServerPrompt();
    const lines = tailLines();
    // Server parse first (its per-pane blocked flag from agent.list is
    // sharper than the workspace status); local grid parse is the
    // fallback. Server "not blocked" also hides the card.
    const prompt = blocked || serverPromptFresh()
      ? promptFromServer(serverPromptFresh()) || (blocked ? parsePrompt(lines) : null)
      : null;
    if (!prompt) {
      node.hidden = true;
      lastCardKey = "";
      return null;
    }
    // Dismissed: the user collapsed THIS question; keep it collapsed until
    // the question (title+options) changes.
    const dismissedKey = prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",");
    if (dismissedFor === dismissedKey) {
      node.hidden = true;
      return prompt;
    }
    const key = cardKey(prompt, lines.join("§").slice(-120));
    if (key !== lastCardKey) {
      renderCard(node, prompt);
      lastCardKey = key;
    }
    node.hidden = false;
    return prompt;
  }

  function renderCard(node, prompt) {
    const optionsHtml = prompt.kind === "options"
      ? prompt.options.map((o) =>
          `<button type="button" class="prompt-card-option" data-option-key="${escapeHtml(o.key)}">${escapeHtml(o.label)}</button>`
        ).join("")
      : `<form id="promptCardForm"><input id="promptCardInput" class="prompt-card-input" placeholder="Type your response"${inputAttrs("send")}><button type="submit" class="prompt-card-send">Send</button></form>`;
    node.innerHTML =
      `<div class="prompt-card" role="dialog" aria-label="${escapeHtml(prompt.title)}">` +
      `<div class="prompt-card-head"><strong>${escapeHtml(prompt.title)}</strong>` +
      `<button type="button" class="prompt-card-dismiss" aria-label="Dismiss question card">×</button></div>` +
      `<div class="prompt-card-body">${optionsHtml}</div>` +
      `<div class="prompt-card-foot"><button type="button" class="prompt-card-show">Show in terminal</button></div>` +
      `</div>`;
    node.querySelector(".prompt-card-dismiss").onclick = () => {
      dismissedFor = prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",");
      node.hidden = true;
    };
    const showBtn = node.querySelector(".prompt-card-show");
    if (showBtn) showBtn.onclick = () => { node.hidden = true; };
    for (const btn of node.querySelectorAll(".prompt-card-option")) {
      btn.onclick = () => answer(node, prompt, btn.getAttribute("data-option-key"));
    }
    const form = node.querySelector("#promptCardForm");
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const input = node.querySelector("#promptCardInput");
        const text = input ? input.value : "";
        if (text) answer(node, prompt, text);
      };
      const input = node.querySelector("#promptCardInput");
      if (input) input.focus({ preventScroll: true });
    }
  }

  // Re-parse the CURRENT tail before sending: if the dialog moved on, do
  // nothing rather than typing into a different prompt. The answered
  // question is marked dismissed so the card stays collapsed while the
  // same dialog text is still on screen (real TUIs repaint it away; a
  // plain shell keeps the text).
  function answer(node, prompt, value) {
    // Prefer the CURRENT local grid when it parses (strictest check);
    // server payloads cover the alt-screen case where the grid is blank.
    const fresh = parsePrompt(tailLines()) || promptFromServer(serverPromptFresh());
    if (!fresh || fresh.title !== prompt.title) return;
    const payload = String(value) + "\r";
    if (typeof sendInputData !== "function") return;
    sendInputData(payload);
    dismissedFor = prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",");
    lastCardKey = "";
    node.hidden = true;
  }

  function overlay() {
    let node = document.getElementById("terminalPromptCard");
    if (!node) {
      const shell = shellElement();
      if (!shell) return null;
      node = document.createElement("div");
      node.id = "terminalPromptCard";
      node.className = "terminal-prompt-card-overlay";
      node.hidden = true;
      shell.appendChild(node);
    }
    return node;
  }

  globalThis.HerdrPromptCards = {
    evaluate,
    parsePrompt,
    tailLines,
    paneBlocked,
    // Test surface.
    _dismissed: () => dismissedFor,
    _reset: () => { dismissedFor = null; lastCardKey = ""; },
    _resetServer: () => {
      promptApiUsable = true;
      serverPrompt = null;
      promptFetchInFlight = false;
      promptFetchAt = 0;
    },
    _serverUsable: () => promptApiUsable,
  };
})();
