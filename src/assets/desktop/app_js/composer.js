// Chat composer over the terminal (ux overhaul: server-side submit).
//
// A textarea anchored under the lens column sends ONE message through the
// server's agent.prompt route (POST /api/panes/{id}/submit). The server
// pastes it bracketed and sends its Enter after a gap, so the submit
// survives a locked phone and a dropped connection — the browser never
// types into the pane itself. A blocked pane is refused server-side
// (agent_blocked); the composer shows the refusal and keeps the text.
//
// Per-pane draft: the box keeps its content per pane (not per view), so
// switching panes mid-thought loses nothing.
//
// Thin on purpose: validation, error classification, and the human copy
// all live server-side (the submit route returns {error, code, note});
// this module only owns UI state (visibility, drafts, key handling).
(function () {
  const drafts = new Map();
  let sending = false;
  let lastSyncedPane = null;
  // Session metadata (model / reasoning effort) published by the lens
  // from each conversation poll. Rendered in the status line above the
  // box, reference parity ("the composer status line displays the model
  // and Reasoning <level>"). null = unknown: show nothing.
  let sessionMeta = null;
  // Matches the server's MAX_COMPOSER_CHARS; the server re-checks, this is
  // just the early out so a fat draft never leaves the browser.
  const MAX_COMPOSER_CHARS = 20000;

  function shellElement() {
    return document.getElementById("terminalShell");
  }

  function overlay() {
    let node = document.getElementById("terminalComposer");
    if (!node) {
      const shell = shellElement();
      if (!shell) return null;
      node = document.createElement("div");
      node.id = "terminalComposer";
      node.className = "terminal-composer";
      // Hidden until the lens opens (sync() owns visibility); the element
      // exists from the first terminal render so drafts never re-create
      // listeners mid-session.
      node.hidden = true;
      node.innerHTML =
        '<div class="terminal-composer-note" id="terminalComposerNote" role="status" hidden></div>' +
        '<div class="terminal-composer-session" id="terminalComposerSession" hidden></div>' +
        '<div class="terminal-composer-row">' +
        `<textarea id="terminalComposerInput" rows="2" placeholder="Send a message" aria-label="Message to this panel"${inputAttrs("send")}></textarea>` +
        '<button type="button" class="btn btn-primary" id="terminalComposerSend">Send</button>' +
        "</div>";
      shell.appendChild(node);
      const input = node.querySelector("#terminalComposerInput");
      const send = node.querySelector("#terminalComposerSend");
      if (input) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        });
        input.addEventListener("input", () => {
          if (typeof state !== "undefined" && state && state.pane) {
            drafts.set(state.pane, input.value);
          }
        });
      }
      if (send) send.onclick = () => submit();
    }
    return node;
  }

  function el(sel, root) {
    const node = root || overlay();
    return node ? node.querySelector(sel) : null;
  }

  function note(text) {
    const noteEl = el("#terminalComposerNote");
    if (!noteEl) return;
    noteEl.textContent = text || "";
    noteEl.hidden = !text;
  }

  function inputEl() {
    return el("#terminalComposerInput");
  }

  function activePaneId() {
    // `state` lives in core.js scope.
    if (typeof state === "undefined" || !state) return null;
    return state.pane || null;
  }

  async function submit() {
    const input = inputEl();
    const paneId = activePaneId();
    if (!input || !paneId || sending) return;
    // Trailing newlines are the composer's Enter, not the text's; CRLF
    // reads as one newline. The server shapes again, this only avoids
    // sending the composer's own line-break residue.
    const message = input.value.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
    if (!message.trim()) return; // nothing to send; the box keeps the draft
    if (message.length > MAX_COMPOSER_CHARS)
      return note("Not sent: message is too long (20000 characters max).");
    sending = true;
    note("");
    try {
      const response = await api(
        `/api/panes/${encodeURIComponent(paneId)}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        },
      );
      input.value = "";
      drafts.delete(paneId);
      note("");
      // Optimistic pending bubble (design section 5): the lens renders
      // it until a poll carries the real user turn with the same text.
      // Cap at one per pane: a new submit replaces the previous text.
      if (globalThis.HerdrLens && globalThis.HerdrLens.setPendingBubble)
        globalThis.HerdrLens.setPendingBubble(message);
      // Forced re-poll outside the cadence so the turn appears now.
      if (globalThis.HerdrLens && globalThis.HerdrLens.refreshConversation)
        globalThis.HerdrLens.refreshConversation();
    } catch (error) {
      // api() throws on !ok with error.details carrying the refusal body
      // {error, code, note}. The server wrote the note; display it and
      // keep the draft. Older/unknown refusals fall back to the error
      // string. 401 is handled by api() (redirects to the login).
      // agent_blocked (409): the text never reached the conversation,
      // so NO pending bubble (round 11 parity).
      const details = error && error.details;
      const text = String((error && error.message) || error);
      note((details && details.note) || text);
      if (globalThis.HerdrLens && globalThis.HerdrLens.setPendingBubble)
        globalThis.HerdrLens.setPendingBubble(null);
    } finally {
      sending = false;
    }
  }

  function forgetPanes(paneIds) {
    // Called when panes/tabs close: drafts are keyed by pane id, so dead
    // panes must release theirs or the map grows for the whole session.
    const ids = Array.isArray(paneIds) ? paneIds : [paneIds];
    for (const id of ids) {
      if (id) drafts.delete(id);
    }
  }

  // The lens pushes {model, reasoning_effort} after every poll and null
  // on pane change / failed poll. The status line is per-pane metadata:
  // it renders ABOVE the note, muted, and never blocks the composer.
  function setSessionMeta(meta) {
    sessionMeta = meta || null;
    renderSessionMeta();
  }

  // A token count the way a status line reads it (reference
  // compose.ts formatTokens parity): 950, 68k, 1.2M.
  function formatTokens(tokens) {
    const value = Number(tokens);
    if (!Number.isFinite(value)) return "";
    if (value < 1000) return String(Math.round(value));
    if (value < 1000000) return `${Math.round(value / 1000)}k`;
    return `${(value / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  }

  function sessionMetaText(meta) {
    // Optional argument so callers (and tests) can render arbitrary
    // shapes; default reflects whatever the last poll published.
    const source = meta === undefined ? sessionMeta : meta;
    if (!source) return "";
    const segments = [];
    // The conversation's title first, the way the pane names itself
    // (reference document.title/displayPaneTitle role): muted but
    // leading, because it says WHAT the reader is looking at.
    const title = (source.title || "").trim();
    if (title) segments.push(title);
    const model = source.model || "";
    const effort = source.reasoning_effort || "";
    // The reference keeps a "Reasoning —" placeholder when effort is
    // unknown; we drop the segment instead and only ever render known
    // values, so the line never carries a dangling dash.
    if (model && effort) segments.push(`${model} · Reasoning ${effort}`);
    else if (model) segments.push(model);
    else if (effort) segments.push(`Reasoning ${effort}`);
    // Context tokens of the LAST request (reference ContextRing's
    // tooltip text). A bare count without the window is what the
    // journal honestly carries, so no percent is invented.
    if (Number.isFinite(source.context_used) && source.context_used > 0) {
      segments.push(`${formatTokens(source.context_used)} tokens`);
    }
    return segments.join(" · ");
  }

  function renderSessionMeta() {
    const line = el("#terminalComposerSession");
    if (!line) return;
    const text = sessionMetaText();
    line.textContent = text;
    line.title = text;
    line.hidden = !text;
  }

  function sync() {
    const node = overlay();
    if (!node) return;
    const lensOn = globalThis.HerdrLens && globalThis.HerdrLens.isActive();
    node.hidden = !lensOn;
    if (!lensOn) return;
    const paneId = activePaneId();
    const input = inputEl();
    if (!input) return;
    // A pane switch must not show the previous pane's refusal note, and the
    // box must not accept text while state.pane is still resolving (the
    // switch window): drafts and submit are keyed by pane id, so typing
    // then would silently drop. Same-pane reconnects keep their note.
    if (paneId !== lastSyncedPane) {
      note("");
      lastSyncedPane = paneId;
    }
    input.disabled = !paneId;
    input.placeholder = paneId
      ? "Send a message"
      : "Switching panel\u2026";
    if (!paneId) return;
    // Restore the draft of the pane now in view (per-pane, not per-view).
    const draft = drafts.get(paneId);
    if (input.value !== (draft || "")) input.value = draft || "";
  }

  globalThis.HerdrComposer = { sync, submit, note, overlay, drafts, forgetPanes, setSessionMeta, sessionMetaText };
})();
