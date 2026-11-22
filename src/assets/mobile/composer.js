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
    // Long-press Send (enqueue): same 600ms hold contract as the desktop
    // composer. The button node is re-created per render, so the hold
    // state lives here (module scope of the composer closure), not on
    // the node.
    const SEND_HOLD_MS = 600;
    let holdTimer = 0;
    let holdActive = false;
    let holdPassed = false;

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

    // Prompt parsing lives in shared/prompt_cards.js (HerdrPromptParser).
    // If the shared module is missing (never in production: app_boot.js
    // loads it first) parsing degrades to a no-op rather than guessing:
    // no card is better than a wrong card.
    const sharedPromptParser = globalThis.HerdrPromptParser;
    const parsePrompt = sharedPromptParser
      ? sharedPromptParser.parsePrompt
      : () => null;
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
      // Chat-mode gate (desktop prompt_cards parity): the card is a
      // chat-mode surface. While the mobile lens is open its decision
      // chooser owns blocked answering, so the card must stay hidden;
      // on the terminal view the card owns it.
      try {
        const lens = globalThis.HerdrMobileLens;
        if (lens && lens.isActive && lens.isActive()) {
          dismissedFor = null;
          lastCardKey = "";
          return null;
        }
      } catch (_) {
        // lens probe failure falls through to normal evaluation.
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

    const SERVER_PROMPT_FRESH_MS = 15000;
    const SERVER_PROMPT_FETCH_MS = 750;

    // The fetch/freshness bookkeeping lives in shared/prompt_cards.js
    // (HerdrPromptParser.createServerPromptStore); the private copies
    // below are boot-order insurance for harnesses that load composer.js
    // alone.
    let promptApiUsable = true;
    let serverPrompt = null; // { at, payload } from the last endpoint hit
    let promptFetchInFlight = false;
    let promptFetchAt = 0;

    function localFetchServerPrompt() {
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

    function localServerPromptFresh() {
      if (!promptApiUsable || !serverPrompt) return null;
      if (Date.now() - serverPrompt.at > SERVER_PROMPT_FRESH_MS) return null;
      return serverPrompt.payload;
    }

    function localPromptFromServer(server) {
      if (!server || !server.blocked || !server.kind) return null;
      return {
        kind: server.kind,
        title: server.title || "",
        options: Array.isArray(server.options) ? server.options : [],
      };
    }

    const sharedServerStore = sharedPromptParser
      ? sharedPromptParser.createServerPromptStore({
          resolveApi: () => {
            if (typeof api === "function") return api;
            return globalThis.HerdrMobileApi || null;
          },
          getPaneId: () => (state && state.pane) || null,
        })
      : null;
    function fetchServerPrompt() {
      if (sharedServerStore) return sharedServerStore.fetchServerPrompt();
      return localFetchServerPrompt();
    }
    function serverPromptFresh() {
      if (sharedServerStore) return sharedServerStore.serverPromptFresh();
      return localServerPromptFresh();
    }
    function promptFromServer(server) {
      if (sharedPromptParser) return sharedPromptParser.promptFromServer(server);
      return localPromptFromServer(server);
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

    function clearHold(send) {
      holdActive = false;
      holdPassed = false;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = 0;
      if (send) {
        send.classList.remove("mobile-composer-send-holding");
        send.classList.remove("mobile-composer-send-queued");
        send.setAttribute("aria-busy", "false");
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
            return;
          }
          // Ctrl+P enqueues on a hardware keyboard (iPad folio, Android
          // keyboard): the long-press hold owns the touch path, this owns
          // the chord. Same submit(enqueue) as desktop parity.
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "p"
          ) {
            event.preventDefault();
            submit(true);
          }
        });
        input.addEventListener("input", () => {
          const paneId = activePaneId();
          if (paneId) drafts.set(paneId, input.value);
        });
      }
      if (send) {
        send.title = "Send. Hold or Ctrl+P to queue while the agent is busy.";
        send.setAttribute(
          "aria-label",
          "Send. Hold or Ctrl+P to queue while the agent is busy.",
        );
        if (typeof PointerEvent !== "undefined") {
          send.addEventListener("pointerdown", () => {
            if (send.disabled) return;
            holdActive = true;
            holdPassed = false;
            send.classList.add("mobile-composer-send-holding");
            send.setAttribute("aria-busy", "true");
            holdTimer = setTimeout(() => {
              holdPassed = true;
              send.classList.add("mobile-composer-send-queued");
            }, SEND_HOLD_MS);
          });
          send.addEventListener("pointerup", (event) => {
            if (!holdActive) return;
            const queued = holdPassed;
            clearHold(send);
            if (event && event.type === "pointerup") submit(queued);
          });
          send.addEventListener("pointercancel", () => clearHold(send));
          send.addEventListener("pointerleave", () => {
            // Releasing off the button must not submit: a drag-off would
            // otherwise send an unintended message.
            clearHold(send);
          });
          document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && holdActive) clearHold(send);
          });
          send.onclick = null;
        } else {
          // No pointer events: the click fallback keeps Send working.
          send.onclick = () => submit();
        }
      }
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

    async function submit(enqueue) {
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
      // Pending bubble: the mobile lens shows the sent text immediately,
      // then the next poll carries the real user turn and clears it
      // (desktop composer parity).
      const lens = globalThis.HerdrMobileLens;
      if (lens && typeof lens.setPendingBubble === "function")
        lens.setPendingBubble(message);
      if (lens && typeof lens.refreshConversation === "function")
        lens.refreshConversation();
      syncComposer();
      try {
        await request(`/api/panes/${encodeURIComponent(paneId)}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            enqueue ? { text: message, enqueue: true } : { text: message },
          ),
        });
        input.value = "";
        drafts.delete(paneId);
        // Long-press release: the agent queues the message while it
        // runs. The note (role=status, aria-live=polite) announces the
        // different outcome so the release does not read as a lost send.
        setNote(enqueue ? "Queued for the running agent" : "");
        // Poll carried the turn (or the pane went agent-less): the
        // pending bubble has served its purpose either way.
        const lens = globalThis.HerdrMobileLens;
        if (lens && typeof lens.setPendingBubble === "function")
          lens.setPendingBubble(null);
        if (lens && typeof lens.refreshConversation === "function")
          lens.refreshConversation();
      } catch (error) {
        // The submit failed: the text never lands in the conversation,
        // so the pending bubble would never match a real user turn and
        // would stick until a pane switch. Drop it (desktop parity).
        const lens = globalThis.HerdrMobileLens;
        if (lens && typeof lens.setPendingBubble === "function")
          lens.setPendingBubble(null);
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
      _serverUsable: () =>
        sharedServerStore
          ? sharedServerStore.serverUsable()
          : promptApiUsable,
      _resetServer: () => {
        if (sharedServerStore) return sharedServerStore.resetServer();
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
