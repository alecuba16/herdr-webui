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

  // Parsing (parsePrompt, questionTitle, optionsAtTailOrConfirmed) and the
  // server-prompt payload plumbing live in shared/prompt_cards.js
  // (HerdrPromptParser). This module keeps the layout-specific state,
  // rendering, and key-synthesis.
  const sharedPromptParser = globalThis.HerdrPromptParser;
  const parsePrompt = sharedPromptParser ? sharedPromptParser.parsePrompt : () => null;
  const promptFromServerShared = sharedPromptParser ? sharedPromptParser.promptFromServer : null;

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

  function paneBlocked() {
    try {
      const ws = (typeof state !== "undefined" && state.workspaces) ? state.workspaces.find((w) => w.workspace_id === state.ws) : null;
      if (!ws) return false;
      return (typeof statusClass === "function" ? statusClass(ws.agent_status) : ws.agent_status) === "blocked";
    } catch (_) {
      return false;
    }
  }

  // Server-prompt payload plumbing lives in shared/prompt_cards.js
  // (HerdrPromptParser.createServerPromptStore) when the shared module is
  // loaded; the private state below is boot-order insurance for harnesses
  // that load this module alone.
  const SERVER_PROMPT_FRESH_MS = 15000;
  const SERVER_PROMPT_FETCH_MS = 750;
  let promptApiUsable = true;
  let serverPrompt = null;
  let promptFetchInFlight = false;
  let promptFetchAt = 0;

  function localFetchServerPrompt() {
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
        promptApiUsable = false;
        serverPrompt = null;
      },
    ).then(() => {
      promptFetchInFlight = false;
    });
  }

  function localServerPromptFresh() {
    if (!promptApiUsable || !serverPrompt) return null;
    if (Date.now() - serverPrompt.at > SERVER_PROMPT_FRESH_MS) return null;
    return serverPrompt.payload;
  }

  const serverStore = globalThis.HerdrPromptParser
    ? globalThis.HerdrPromptParser.createServerPromptStore({
        resolveApi: () => (typeof api === "function" ? api : null),
        getPaneId: () => (typeof state !== "undefined" && state && state.pane) || null,
      })
    : null;
  function fetchServerPrompt() {
    if (serverStore) return serverStore.fetchServerPrompt();
    return localFetchServerPrompt();
  }
  function serverPromptFresh() {
    if (serverStore) return serverStore.serverPromptFresh();
    return localServerPromptFresh();
  }
  function promptFromServer(server) {
    if (promptFromServerShared) return promptFromServerShared(server);
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
      if (serverStore) return serverStore.resetServer();
      promptApiUsable = true;
      serverPrompt = null;
      promptFetchInFlight = false;
      promptFetchAt = 0;
    },
    _serverUsable: () => (serverStore ? serverStore.serverUsable() : promptApiUsable),
  };
})();
