// Mobile composer + prompt cards: the mobile half of the desktop chat
// surfaces (composer.js + prompt_cards.js).
//
// Composer: a message bar under the terminal that submits to
// POST /api/panes/{id}/submit — the same route the desktop composer and
// the backend agent.prompt use. Per-pane drafts, refusal notes, and the
// 20000-char client cap mirror the desktop contract.
//
// Prompt cards: when the selected pane's agent is blocked, parse the
// terminal tail (wterm bridge grid reads) for a question dialog and
// answer it by synthesizing keystrokes through the terminal input path.
// Same parse shapes as desktop prompt_cards.js (frozen protocol 22 has
// no structured prompt payload).
(function () {
  const MAX_COMPOSER_CHARS = 20000;
  const PILL_STATUSES = ["blocked", "done", "idle", "working"];

  function createMobileComposer({ state, api, render, escapeHtml, statusClassFn, getTerminal }) {
    const drafts = new Map();
    let sending = false;

    // ---- Terminal tail reading (wterm bridge grid, same as desktop) ----

    function bridge() {
      const term = getTerminal && getTerminal();
      if (!term || !term.wterm || !term.wterm.bridge) return null;
      return term.wterm.bridge;
    }

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

    // ---- Prompt parsing (ported from desktop prompt_cards.js) ----

    const OPTION_LINE = /^[>\s]*([0-9]+)[.)]\s+(.+)$/;
    const NAV_HINT = /↑↓\s*select|↑\/↓/;
    const FREE_TEXT = /enter your response|type your answer|enter send/i;
    const QUESTION_LINE = /^\s*(?:❯|›|➜|\$)\s*(.+?)(?:\?+)?\s*$|^\s*\?+\s*(.+)$/;

    function questionTitle(lines) {
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

    function parsePrompt(lines) {
      if (!lines.length) return null;
      const joined = lines.join("\n");
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
      if (FREE_TEXT.test(joined)) {
        title = questionTitle(lines);
        if (title) return { kind: "text", title };
        return null;
      }
      if (NAV_HINT.test(joined) || /esc cancel|esc dismiss/i.test(joined)) {
        if (options.length >= 2) {
          title = questionTitle(lines) || "Select an option";
          return { kind: "options", title, options };
        }
        return null;
      }
      if (options.length >= 2) {
        const lower = joined.toLowerCase();
        if (/(allow|approve|yes|proceed|deny|reject|no|cancel)/.test(lower)) {
          title = questionTitle(lines) || "Confirm action";
          return { kind: "options", title, options };
        }
      }
      return null;
    }

    // ---- Blocked detection ----

    function currentAgentStatus() {
      const pane = state.pane;
      const agent = (state.agents || []).find((item) => item.pane_id === pane) ||
        (state.agents || []).find((item) =>
          item.workspace_id === state.ws && item.tab_id === state.tab);
      return agent ? statusClassFn(agent.agent_status) : "";
    }

    // ---- Prompt card state ----

    let dismissedFor = null;
    let lastCardKey = "";

    function promptDismissKey(prompt) {
      return prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",");
    }

    function evaluatePrompt() {
      const status = currentAgentStatus();
      if (status !== "blocked") {
        dismissedFor = null;
        lastCardKey = "";
        return null;
      }
      const lines = tailLines();
      const prompt = parsePrompt(lines);
      if (!prompt) {
        lastCardKey = "";
        return null;
      }
      if (dismissedFor === promptDismissKey(prompt)) return null;
      return prompt;
    }

    function dismissPrompt(prompt) {
      dismissedFor = promptDismissKey(prompt);
      render();
    }

    function answerPrompt(prompt, value) {
      // Re-parse the CURRENT tail before sending: if the dialog moved on,
      // do nothing rather than typing into a different prompt.
      const fresh = parsePrompt(tailLines());
      if (!fresh || fresh.title !== prompt.title) return;
      const term = getTerminal && getTerminal();
      if (!term || !term.sendPasteToTerminal) return;
      term.sendPasteToTerminal(String(value) + "\r");
      dismissedFor = promptDismissKey(prompt);
      lastCardKey = "";
      render();
    }

    // ---- Composer ----

    function composerVisible() {
      return !!(state.pane && state.screen === "terminal");
    }

    function draftFor(paneId) {
      return drafts.get(paneId) || "";
    }

    function setDraft(value) {
      if (!state.pane) return;
      drafts.set(state.pane, String(value || ""));
    }

    function note() {
      return state.composerNote || "";
    }

    async function submit() {
      const paneId = state.pane;
      if (!paneId || sending) return;
      const message = draftFor(paneId).replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
      if (!message.trim()) return;
      if (message.length > MAX_COMPOSER_CHARS) {
        state.composerNote = "Not sent: message is too long (20000 characters max).";
        render();
        return;
      }
      sending = true;
      state.composerNote = "";
      render();
      try {
        await api(`/api/panes/${encodeURIComponent(paneId)}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
        drafts.delete(paneId);
        state.composerNote = "";
      } catch (error) {
        const details = error && error.details;
        const refusal = details && details.note;
        state.composerNote = refusal || error.message || String(error);
      } finally {
        sending = false;
        render();
      }
    }

    // ---- Rendering ----

    function renderComposerBar() {
      if (!composerVisible()) return "";
      const disabled = sending || !state.pane;
      const value = state.pane ? draftFor(state.pane) : "";
      return `<div class="mobile-composer" id="mobileComposer"><textarea id="mobileComposerInput" rows="1" placeholder="${disabled ? "Sending…" : "Message this panel"}" ${disabled ? "disabled" : ""} oninput="HerdrMobile.composerInput(this.value)" onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); HerdrMobile.composerSubmit(); }">${escapeHtml(value)}</textarea><button class="mobile-btn primary" id="mobileComposerSend" ${disabled ? "disabled" : ""} onclick="HerdrMobile.composerSubmit()">${sending ? "…" : "Send"}</button></div>`;
    }

    function renderComposerNote() {
      if (!composerVisible() || !state.composerNote) return "";
      return `<div class="mobile-composer-note" id="mobileComposerNote" role="status">${escapeHtml(state.composerNote)}</div>`;
    }

    function draftValue() {
      return state.pane ? draftFor(state.pane) : "";
    }

    function renderPromptCard() {
      if (state.screen !== "terminal") return "";
      const prompt = evaluatePrompt();
      if (!prompt) return "";
      const body = prompt.kind === "options"
        ? prompt.options.map((o) => `<button type="button" class="mobile-prompt-option" onclick="HerdrMobile.promptAnswer(${JSON.stringify(prompt.title.replace(/"/g, '\\"'))}, '${escapeHtml(o.key)}')">${escapeHtml(o.label)}</button>`).join("")
        : `<div class="mobile-prompt-text-row"><input id="mobilePromptInput" class="mobile-sheet-input" type="text" placeholder="Type your response" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.promptAnswerText(${JSON.stringify(prompt.title.replace(/"/g, '\\"'))}, this.value); }"></div>`;
      return `<div class="mobile-prompt-card" id="mobilePromptCard" role="dialog" aria-label="${escapeHtml(prompt.title)}"><div class="mobile-prompt-head"><strong>${escapeHtml(prompt.title)}</strong><button type="button" class="mobile-btn mini" aria-label="Dismiss question" onclick="HerdrMobile.promptDismiss(${JSON.stringify(prompt.title.replace(/"/g, '\\"'))})">✕</button></div><div class="mobile-prompt-body">${body}</div></div>`;
    }

    // Prompt answers need the prompt object; resolve by title at call time
    // so a stale card can never answer a stale question.
    function findPromptByTitle(title) {
      const lines = tailLines();
      const prompt = parsePrompt(lines);
      return prompt && prompt.title === title ? prompt : null;
    }

    function promptAnswer(title, key) {
      const prompt = findPromptByTitle(title);
      if (prompt) answerPrompt(prompt, key);
    }

    function promptAnswerText(title, value) {
      if (!value) return;
      const prompt = findPromptByTitle(title);
      if (prompt) answerPrompt(prompt, value);
    }

    function promptDismiss(title) {
      const prompt = findPromptByTitle(title);
      if (prompt) dismissPrompt(prompt);
      else render();
    }

    return {
      // composer
      submit,
      setDraft,
      draftFor,
      draftValue,
      renderComposerBar,
      renderComposerNote,
      composerVisible,
      // prompt cards
      evaluatePrompt,
      renderPromptCard,
      promptAnswer,
      promptAnswerText,
      promptDismiss,
      // test surface
      parsePrompt,
      tailLines,
      currentAgentStatus,
      _reset() { drafts.clear(); dismissedFor = null; lastCardKey = ""; state.composerNote = ""; },
    };
  }

  globalThis.HerdrMobileComposerModule = { create: createMobileComposer };
})();