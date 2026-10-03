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
(function () {
  const drafts = new Map();
  let sending = false;

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
        '<div class="terminal-composer-row">' +
        '<textarea id="terminalComposerInput" rows="2" placeholder="Send a message" ' +
        'aria-label="Message to this panel"></textarea>' +
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
    const compose = globalThis.HerdrCompose;
    if (!compose) return note("Composer unavailable.");
    const raw = input.value;
    const message = compose.composerMessage(raw);
    if (!message.trim()) return; // nothing to send; the box keeps the draft
    if (message.length > compose.MAX_COMPOSER_CHARS)
      return note(compose.submitNote("message_too_long"));
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
      if (response && (response.error || response.code)) {
        note(compose.submitNote(response.code, response.error));
      } else {
        input.value = "";
        drafts.delete(paneId);
        note("");
      }
    } catch (error) {
      // api() throws on !ok with the server's error string; refusal
      // bodies are "<code>: <message>" so the machine code can be
      // recovered from the prefix and mapped to composer copy.
      const text = String(error && error.message ? error.message : error);
      const code = text.split(":")[0];
      note(compose.submitNote(code, text));
    } finally {
      sending = false;
    }
  }

  function sync() {
    const node = overlay();
    if (!node) return;
    const lensOn = globalThis.HerdrLens && globalThis.HerdrLens.isActive();
    node.hidden = !lensOn;
    if (!lensOn) return;
    const paneId = activePaneId();
    const input = inputEl();
    if (!input || !paneId) return;
    // Restore the draft of the pane now in view (per-pane, not per-view).
    const draft = drafts.get(paneId);
    if (input.value !== (draft || "")) input.value = draft || "";
  }

  globalThis.HerdrComposer = { sync, submit, note, overlay, drafts };
})();
