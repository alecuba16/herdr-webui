// Mobile chat and prompt cards: the mobile half of the desktop chat surfaces
// (prompt_cards.js). Chat messages use the server-side submit route, so the
// browser does not synthesize agent input or compete with wterm's textarea.
// Terminal typing remains owned by wterm, with the guarded textarea and the
// on-screen key bar for control keys. Blocked agent questions still use the
// terminal input path because they are prompt answers, not chat messages.
(function () {
  const PILL_STATUSES = ["blocked", "done", "idle", "working"];

  function createMobileComposer({ state, render, escapeHtml, inputAttrs, statusClassFn, getTerminal, api }) {
    // `api` is optional: the live app injects it; older callers fall
    // back to the global HerdrMobileApi that app.js publishes.

    const drafts = new Map();
    const MAX_COMPOSER_CHARS = 20000;
    let sending = false;
    let noteText = "";
    let lastSyncedPane = null;

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
    // jcode ask_user chooser (ui_inline.rs), same guard as desktop
    // prompt_cards.js: its hint lines carry "Enter sends ..." which
    // matches FREE_TEXT, so the chooser tail would otherwise parse as
    // a free-text card with a scraped shell-prompt title. The chooser
    // is its own answer surface, never a prompt card.
    const JCODE_CHOOSER = /1-9 or ↑↓ \+ Enter to choose|type on Your answer|\. Your answer/i;
    // jcode Permissions viewer markers, same as desktop prompt_cards.js.
    // Help row AND waiting line must both be present.
    const JCODE_VIEWER_HELP = /a approve.*d deny.*A approve all.*D deny all/i;
    const JCODE_VIEWER_WAITING = /agent is waiting for this decision/i;
    const JCODE_VIEWER_TITLE = /permissions?\s*\((\d+)\s*pending\)/i;
    const CONFIRM_HINT = /enter (?:to )?(?:confirm|select|choose|submit)|press enter|return to (?:confirm|select)/i;

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
      // Unicode whitespace parity with the Rust parser: JS `\s` and Rust
      // regex `\s` disagree on BOM and NEL. Normalize the exotic spaces
      // to plain space so both parser copies match identically on
      // terminals that emit NBSP/NEL/U+3000/BOM/LS/PS.
      lines = lines.map((line) =>
        line.replace(/[\u00a0\u0085\u3000\ufeff\u2028\u2029]/g, " "),
      );
      const joined = lines.join("\n");
      // jcode ask_user chooser: not a prompt card (its own answer
      // surface exists), so bail before any branch can scrape a
      // title from its hint lines.
      if (JCODE_CHOOSER.test(joined)) return null;
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
      // jcode Permissions viewer: letter options go straight to the
      // viewer (a approve, d deny, A/D bulk). Checked first: its tail
      // also contains "approve"/"deny" words that would otherwise fall
      // through to the weaker numbered branch.
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
        if (/(allow|approve|yes|proceed|deny|reject|no|cancel)/.test(lower) && optionsAtTailOrConfirmed(lines, options)) {
          title = questionTitle(lines) || "Confirm action";
          return { kind: "options", title, options };
        }
      }
      return null;
    }

    // Tightening helper: the block must sit at the tail end or carry a
    // confirm hint below (same rule as desktop prompt_cards.js).
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

    // Shared options store (same as desktop settings; HerdrOptions is
    // the shared reader, localStorage fallback for old sessions).
    function readOptions() {
      try {
        if (globalThis.HerdrOptions) return globalThis.HerdrOptions.read();
        return JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      } catch (_) {
        return {};
      }
    }

    function promptDismissKey(prompt) {
      return prompt.title + "|" + (prompt.options || []).map((o) => o.key).join(",");
    }

    function evaluatePrompt() {
      // User toggle (Settings > Agents): off means no card, ever.
      try {
        if (readOptions().promptCardsEnabled === false) {
          dismissedFor = null;
          lastCardKey = "";
          return null;
        }
      } catch (_) {
        // readOptions failure falls through to normal evaluation.
      }
      const status = currentAgentStatus();
      if (status !== "blocked") {
        dismissedFor = null;
        lastCardKey = "";
        return null;
      }
      // Poll on every evaluate (rate-limited): the payload's per-pane
      // blocked flag from agent.list is sharper than the agent pill.
      fetchServerPrompt();
      const server = serverPromptFresh();
      const prompt = promptFromServer(server) || parsePrompt(tailLines());
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

    // ---- Server prompt payload (desktop fetchServerPrompt parity) ----

    let promptApiUsable = true;
    let serverPrompt = null; // { at, payload } from the last endpoint hit
    let promptFetchInFlight = false;
    let promptFetchAt = 0;
    const SERVER_PROMPT_FRESH_MS = 15000;
    const SERVER_PROMPT_FETCH_MS = 750;

    function fetchServerPrompt() {
      if (!promptApiUsable || promptFetchInFlight) return;
      if (Date.now() - promptFetchAt < SERVER_PROMPT_FETCH_MS) return;
      const paneId = state && state.pane;
      const request = typeof api === "function" ? api : globalThis.HerdrMobileApi;
      if (!paneId || typeof request !== "function") return;
      promptFetchAt = Date.now();
      promptFetchInFlight = true;
      Promise.resolve(
        request("/api/panes/" + encodeURIComponent(paneId) + "/prompt"),
      ).then(
        (res) => {
          const payload = res && (res.result || res);
          serverPrompt =
            payload && typeof payload === "object"
              ? { at: Date.now(), payload }
              : null;
        },
        () => {
          // Sticky-off: one failure (old server without the route,
          // transport error) disables the endpoint for the session.
          promptApiUsable = false;
          serverPrompt = null;
        },
      ).then(() => {
        promptFetchInFlight = false;
      });
    }

    function serverPromptFresh() {
      if (!promptApiUsable || !serverPrompt) return null;
      if (Date.now() - serverPrompt.at > SERVER_PROMPT_FRESH_MS) return null;
      return serverPrompt.payload;
    }

    function promptFromServer(server) {
      if (!server || !server.blocked || !server.kind) return null;
      return {
        kind: server.kind,
        title: server.title || "",
        options: Array.isArray(server.options) ? server.options : [],
      };
    }

    function answerPrompt(prompt, value) {
      // Re-parse the CURRENT tail (or the fresh server payload for the
      // alt-screen case) before sending: if the dialog moved on, do
      // nothing rather than typing into a different prompt.
      const fresh = parsePrompt(tailLines()) || promptFromServer(serverPromptFresh());
      if (!fresh || fresh.title !== prompt.title) return;
      const term = getTerminal && getTerminal();
      if (!term || !term.sendPasteToTerminal) return;
      term.sendPasteToTerminal(String(value) + "\r");
      dismissedFor = promptDismissKey(prompt);
      lastCardKey = "";
      render();
    }

    // ---- Chat composer ----

    function composerVisible() {
      return !!(state.pane && state.screen === "terminal");
    }

    function activePaneId() {
      return state && state.pane ? state.pane : null;
    }

    function composerNode() {
      return typeof document !== "undefined" ? document.getElementById("mobileComposer") : null;
    }

    function composerInput() {
      const node = composerNode();
      return node && node.querySelector ? node.querySelector("#mobileComposerInput") : null;
    }

    function composerNote() {
      const node = composerNode();
      return node && node.querySelector ? node.querySelector("#mobileComposerNote") : null;
    }

    function setNote(text) {
      noteText = String(text || "");
      const note = composerNote();
      if (note) {
        note.textContent = noteText;
        note.hidden = !noteText;
      }
    }

    function bindComposer(node) {
      if (!node || node.__herdrMobileComposerBound) return;
      const input = node.querySelector && node.querySelector("#mobileComposerInput");
      const send = node.querySelector && node.querySelector("#mobileComposerSend");
      if (input && input.addEventListener) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        });
        input.addEventListener("input", () => {
          const paneId = activePaneId();
          if (paneId) drafts.set(paneId, input.value);
        });
      }
      if (send) send.onclick = () => submit();
      node.__herdrMobileComposerBound = true;
    }

    function syncComposer() {
      const node = composerNode();
      if (!node) return;
      bindComposer(node);
      const paneId = activePaneId();
      if (paneId !== lastSyncedPane) {
        noteText = "";
        lastSyncedPane = paneId;
      }
      const input = node.querySelector && node.querySelector("#mobileComposerInput");
      const send = node.querySelector && node.querySelector("#mobileComposerSend");
      const note = node.querySelector && node.querySelector("#mobileComposerNote");
      if (input) {
        input.disabled = !paneId || sending;
        input.placeholder = paneId ? "Message this agent" : "Selecting panel...";
        const activeElement = typeof document !== "undefined" ? document.activeElement : null;
        const draft = paneId ? drafts.get(paneId) || "" : "";
        if (activeElement !== input && input.value !== draft) input.value = draft;
      }
      if (send) {
        send.disabled = !paneId || sending;
        send.setAttribute("aria-busy", sending ? "true" : "false");
      }
      if (note) {
        note.textContent = noteText;
        note.hidden = !noteText;
      }
    }

    function renderComposerBar() {
      if (!composerVisible()) return "";
      const paneId = activePaneId();
      const draft = paneId ? drafts.get(paneId) || "" : "";
      return (
        `<div class="mobile-composer" id="mobileComposer" role="region" aria-label="Chat message">` +
        `<div class="mobile-composer-note" id="mobileComposerNote" role="status" aria-live="polite" hidden></div>` +
        `<div class="mobile-composer-row">` +
        `<textarea id="mobileComposerInput" rows="2" placeholder="Message this agent" aria-label="Message this agent"${inputAttrs("send")}>${escapeHtml(draft)}</textarea>` +
        `<button type="button" class="mobile-btn primary mobile-composer-send" id="mobileComposerSend">Send</button>` +
        `</div></div>`
      );
    }

    function renderComposerNote() {
      return noteText;
    }

    async function submit() {
      const input = composerInput();
      const paneId = activePaneId();
      const request = typeof api === "function" ? api : globalThis.HerdrMobileApi;
      if (!input || !paneId || sending || typeof request !== "function") return;
      const message = String(input.value || "").replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
      if (!message.trim()) return;
      if (message.length > MAX_COMPOSER_CHARS) {
        setNote("Not sent: message is too long (20000 characters max).");
        return;
      }
      sending = true;
      setNote("");
      syncComposer();
      try {
        await request(`/api/panes/${encodeURIComponent(paneId)}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
        input.value = "";
        drafts.delete(paneId);
        setNote("");
      } catch (error) {
        const details = error && error.details;
        const text = String((error && error.message) || error);
        setNote((details && details.note) || text);
      } finally {
        sending = false;
        syncComposer();
        if (typeof render === "function") render();
      }
    }

    function renderPromptCard() {
      if (state.screen !== "terminal") return "";
      const prompt = evaluatePrompt();
      if (!prompt) return "";
      // Bottom-sheet question surface: handle + title row with the dismiss
      // (Cancel) button, then the options list or the free-text input. Same
      // .mobile-sheet chrome the rename/confirm sheets use, so it reads as a
      // native sheet instead of a floating card stuck to the composer bar.
      const body = prompt.kind === "options"
        ? prompt.options.map((o) => `<button type="button" class="mobile-sheet-action mobile-prompt-option" onclick="HerdrMobile.promptAnswer(${escapeHtml(JSON.stringify(prompt.title))}, '${escapeHtml(o.key)}')"><strong>${escapeHtml(o.key)}.</strong> ${escapeHtml(o.label)}</button>`).join("")
        : `<div class="mobile-prompt-text-row"><input id="mobilePromptInput" class="mobile-sheet-input" type="text"${inputAttrs("send")} placeholder="Type your response" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.promptAnswerText(${escapeHtml(JSON.stringify(prompt.title))}, this.value); }"></div>`;
      return `<div class="mobile-sheet-backdrop mobile-prompt-backdrop" onclick="HerdrMobile.promptDismiss(${escapeHtml(JSON.stringify(prompt.title))})"></div><div class="mobile-sheet mobile-prompt-card" id="mobilePromptCard" role="dialog" aria-modal="true" aria-label="${escapeHtml(prompt.title)}"><div class="mobile-sheet-handle"></div><div class="mobile-prompt-head"><strong class="mobile-prompt-title">${escapeHtml(prompt.title)}</strong><button type="button" class="mobile-btn mini" aria-label="Cancel and close question" onclick="HerdrMobile.promptDismiss(${escapeHtml(JSON.stringify(prompt.title))})">Cancel</button></div><div class="mobile-prompt-body">${body}</div></div>`;
    }

    // Prompt answers need the prompt object; resolve by title at call time
    // so a stale card can never answer a stale question.
    function findPromptByTitle(title) {
      const prompt = parsePrompt(tailLines()) || promptFromServer(serverPromptFresh());
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
      // chat composer
      renderComposerBar,
      renderComposerNote,
      composerVisible,
      syncComposer,
      submit,
      drafts,
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
      fetchServerPrompt,
      _serverUsable: () => promptApiUsable,
      _resetServer: () => {
        promptApiUsable = true;
        serverPrompt = null;
        promptFetchInFlight = false;
        promptFetchAt = 0;
      },
      _reset() {
        dismissedFor = null;
        lastCardKey = "";
        noteText = "";
        lastSyncedPane = null;
        state.composerNote = "";
      },
    };
  }

  globalThis.HerdrMobileComposerModule = { create: createMobileComposer };
})();
