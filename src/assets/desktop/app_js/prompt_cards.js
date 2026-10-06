// Prompt cards: interactive answer surface for blocked agents (backlog 3/3).
//
// When the selected pane's agent is blocked on a question dialog, the card
// renders the question title plus clickable options (or a free-text input)
// parsed from the terminal tail — the same bridge source the chat lens
// reads. Protocol 22 is frozen, so there is no structured prompt payload:
// the shapes match the dialogs the backend's blocked detectors already
// recognize (numbered option lists, ↑↓ select hints, "enter your
// response" free-text prompts).
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

  const OPTION_LINE = /^[>\s]*([0-9]+)[.)]\s+(.+)$/;
  const NAV_HINT = /↑↓\s*select|↑\/↓/;
  const FREE_TEXT = /enter your response|type your answer|enter send/i;
  const QUESTION_LINE = /^\s*(?:❯|›|➜|\$)\s*(.+?)(?:\?+)?\s*$|^\s*\?+\s*(.+)$/;

  function shellElement() {
    return document.getElementById("terminalShell");
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
    const joined = lines.join("\n");
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
    // Numbered confirmation without nav hint (permission dialogs).
    if (options.length >= 2) {
      const lower = joined.toLowerCase();
      if (/(allow|approve|yes|proceed|deny|reject|no|cancel)/.test(lower)) {
        title = questionTitle(lines) || "Confirm action";
        return { kind: "options", title, options };
      }
    }
    return null;
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

  function cardKey(prompt, tailSignature) {
    return (prompt ? prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",") : "") + "@" + tailSignature;
  }

  function evaluate() {
    const node = overlay();
    if (!node) return null;
    const blocked = paneBlocked();
    // Blocked-episode tracking: a fresh transition INTO blocked means a
    // new question (even with identical text) — clear any dismissal so the
    // card re-opens. Within one episode, dismissal sticks.
    if (blocked && !wasBlocked) {
      dismissedFor = null;
      lastCardKey = "";
    }
    wasBlocked = blocked;
    const lines = tailLines();
    const prompt = blocked ? parsePrompt(lines) : null;
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
    const lines = tailLines();
    const fresh = parsePrompt(lines);
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
  };
})();