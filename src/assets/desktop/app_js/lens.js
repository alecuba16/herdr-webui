// Chat lens over the terminal (ux overhaul backlog 2/3).
//
// Two modes share one overlay:
//
// - Structured mode (jcode panes with a resolvable session): polls
//   /api/panes/{id}/conversation every 2s while the lens is open and
//   renders server-shaped turns — user bubbles, plain assistant text,
//   collapsed thinking, one-line tool summaries expandable to their
//   output, `running …` for in-flight tools, a compact summary widget.
//   Rendering is append-only while the response `version` is unchanged
//   so text selection and collapsed/expanded state survive every poll.
//
// - Scrollback mode (the original lens): renders the terminal's own
//   scrollback through the live wterm bridge. Fallback for shell panes
//   and any structured-mode failure — the terminal surface never goes
//   blank.
//
// The terminal socket stays attached in both modes; switching lens
// never reconnects (the reference pattern's core invariant).
//
// Auto-follow: scrolled-to-bottom sticks to the tail; scrolling up stops
// follow and shows a "New output" pill that resumes on click.
(function () {
  let lensActive = false;
  let follow = true;
  let unread = false;
  let lastRenderedLineCount = -1;

  // ---- structured mode state (all keyed by pane id) ----
  // One poll loop, one rendered conversation, one pending bubble: the
  // state moves with the active pane and a pane switch drops it (the
  // old pane's poll must never leak onto the new pane).
  const POLL_MS = 2000;
  const SUPPORTED_CHAT_AGENTS = new Set(["jcode"]);
  let chatPane = null; // pane id the structured state belongs to
  let pollTimer = null; // setTimeout handle, null when stopped
  let pollInFlight = false; // single-flight: a slow poll blocks the next
  let pollQueued = false; // a tick fired while in flight: run one after
  let conversation = null; // last successful {turns, version, ...}
  let convError = null; // {code} of the last failed poll
  let loadingChat = true; // true until the first response lands
  let pendingBubble = null; // {text} of the optimistic user bubble
  // Expansion state survives polls: key = tool part identity, value =
  // true when the output body is shown. Collapsed thinking is the
  // default so the map only stores the expanded ones.
  const expandedTools = new Set();
  const expandedThinking = new Set();
  // Fetched whole tool outputs ("Show full output"): key -> {ref, output}.
  // The payload keeps the trimmed copy, so the map is the only source
  // of the full text once fetched; without it every poll's in-place
  // sync would swap the row back to trimmed. The ref guards against a
  // rotation reusing a part key for a different tool.
  const fetchedOutputs = new Map();

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

  // ---- pane metadata (agents list carries agent_session per pane) ----

  function activePaneId() {
    if (typeof state === "undefined" || !state) return null;
    return state.pane || null;
  }

  function activeAgentRow() {
    if (typeof state === "undefined" || !state) return null;
    const id = state.pane;
    if (!id) return null;
    const agents = state.agents || [];
    return agents.find((a) => a && a.pane_id === id) || null;
  }

  function paneAgentName() {
    // Same resolution the sidebar uses (render.js agent_token).
    const a = activeAgentRow();
    return a ? a.name || a.display_agent || a.agent || a.terminal_id : null;
  }

  // The structured gate: a supported agent AND a non-null agent_session.
  // `resolvable: false` still opens the switch — the lens shows the
  // refusal reason instead of turns (design section 6).
  function chatSupported() {
    const agent = paneAgentName();
    if (!agent || !SUPPORTED_CHAT_AGENTS.has(agent)) return false;
    const a = activeAgentRow();
    return !!(a && a.agent_session);
  }

  function refusalReasonCopy() {
    const a = activeAgentRow();
    const reason = a && a.agent_session && a.agent_session.reason;
    switch (reason) {
      case "no_session_path":
        return "No jcode conversation found for this panel yet";
      case "ambiguous":
        return "Multiple jcode conversations match this panel; open one in the terminal to disambiguate";
      default:
        return "Conversation unavailable right now";
    }
  }

  // ---- structured mode: poll loop ----

  function ensurePolling() {
    // Poll only when the lens is open, the pane is chat-capable, and
    // the poll belongs to the pane now in view.
    if (!lensActive || !chatSupported()) return stopPolling();
    const paneId = activePaneId();
    if (paneId !== chatPane) resetChatState(paneId);
    if (pollTimer !== null) return;
    pollSoon(0);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function pollSoon(delayMs) {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      pollConversation();
    }, delayMs);
  }

  async function pollConversation() {
    if (!lensActive || !chatSupported()) return stopPolling();
    const paneId = activePaneId();
    if (paneId !== chatPane) resetChatState(paneId);
    // Single-flight: a slow poll never overlaps the next tick; the
    // queued flag runs exactly one catch-up poll right after.
    if (pollInFlight) {
      pollQueued = true;
      return;
    }
    pollInFlight = true;
    try {
      const response = await api(
        `/api/panes/${encodeURIComponent(paneId)}/conversation`,
      );
      if (paneId !== chatPane || !lensActive) return; // stale: pane moved on
      convError = null;
      loadingChat = false;
      conversation = response;
      // Pending bubble: remove once the conversation contains a user
      // turn with the same text (the id is not known at submit time).
      if (pendingBubble && userTurnTexts(response).has(pendingBubble.text)) {
        pendingBubble = null;
      }
      render();
    } catch (error) {
      if (paneId !== chatPane || !lensActive) return;
      const details = error && error.details;
      convError = {
        code: (details && details.code) || "error",
      };
      loadingChat = false;
      // Resolution failures keep the switch visible and the lens open:
      // the refusal copy replaces the turns (hint precedence, round 11).
      render();
    } finally {
      pollInFlight = false;
      if (pollQueued) {
        pollQueued = false;
        pollSoon(0);
      } else if (lensActive && chatSupported()) {
        pollSoon(POLL_MS);
      }
    }
  }

  function userTurnTexts(response) {
    const texts = new Set();
    for (const turn of (response && response.turns) || []) {
      if (turn.role !== "user") continue;
      for (const part of turn.parts || []) {
        if (part.kind === "text" && part.text) texts.add(part.text);
      }
    }
    return texts;
  }

  function resetChatState(paneId) {
    chatPane = paneId;
    conversation = null;
    convError = null;
    loadingChat = true;
    pendingBubble = null;
    expandedTools.clear();
    expandedThinking.clear();
    fetchedOutputs.clear();
    stopPolling();
  }

  // Public: forced re-poll after a successful submit (the user turn
  // should appear immediately, outside the cadence).
  function refreshConversation() {
    if (!lensActive || !chatSupported()) return;
    pollQueued = true;
    if (!pollInFlight) {
      pollQueued = false;
      pollConversation();
    }
  }

  // Public: the composer reports its optimistic bubble so the lens can
  // render it until the poll carries the real user turn.
  function setPendingBubble(text) {
    if (text === null || text === undefined || text === "") pendingBubble = null;
    else pendingBubble = { text: String(text) };
    if (lensActive && chatSupported()) render();
  }

  // ---- structured mode: rendering ----

  function partKey(turnIndex, partIndex, part) {
    // Row identity for the in-place swap and expansion state: turn +
    // part POSITION plus the tool name. The kind is deliberately NOT in
    // the key — a `running` row must be FOUND by the same key when it
    // resolves into the full tool row (kind flips tool_pending -> tool).
    return `${turnIndex}:${partIndex}:${part.name || ""}`;
  }

  function conversationHtml(response, opts) {
    const opts_ = opts || {};
    const fromTurn = opts_.from || 0;
    const turns = (response && response.turns) || [];
    if (!turns.length) {
      return (
        '<div class="lens-empty">No messages yet — send one below</div>'
      );
    }
    const out = [];
    turns.forEach((turn, turnIndex) => {
      const globalIndex = fromTurn + turnIndex;
      const parts = [];
      (turn.parts || []).forEach((part, partIndex) => {
        // Part keys are GLOBAL turn indices; a chunk render must keep
        // the indices of the conversation it came from, not restart at 0.
        parts.push(partHtml(part, globalIndex, partIndex));
      });
      const body = parts.join("");
      if (turn.role === "user") {
        out.push(
          `<div class="lens-turn lens-turn-user" data-turn="${globalIndex}" data-ts="${escapeAttr(String(turn.ts || ""))}"><span>${body}</span></div>`,
        );
      } else {
        out.push(
          `<div class="lens-turn lens-turn-assistant" data-turn="${globalIndex}" data-ts="${escapeAttr(String(turn.ts || ""))}">${body}</div>`,
        );
      }
    });
    // The pending bubble is appended ONLY on a full render; incremental
    // updates manage it through syncPendingBubbleDom instead (it would
    // otherwise be re-inserted by every appended chunk).
    if (pendingBubble && fromTurn === 0) {
      out.push(
        `<div class="lens-turn lens-turn-user lens-turn-pending"><span>${escapeHtml(pendingBubble.text)}</span></div>`,
      );
    }
    return out.join("");
  }

  function partHtml(part, turnIndex, partIndex) {
    if (part.kind === "text") {
      // Text parts carry the key too: the same-count sync must FIND them
      // (a miss would append a duplicate on every poll), and a text part
      // appended to an open turn must render once and then compare equal.
      return `<div class="lens-text" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">${escapeHtml(part.text || "")}</div>`;
    }
    if (part.kind === "thinking") {
      const key = partKey(turnIndex, partIndex, part);
      const open = expandedThinking.has(key);
      // data-part-key on the thinking row too: the same-count sync
      // path updates it in place (expand/collapse without a rewrite).
      const head = `<span class="lens-thinking-toggle" data-toggle-thinking="${escapeAttr(key)}">${open ? "▾" : "▸"} thinking</span>`;
      const body = open
        ? `<div class="lens-thinking-body">${escapeHtml(part.text || "")}</div>`
        : "";
      return `<div class="lens-thinking" data-part-key="${escapeAttr(key)}">${head}${body}</div>`;
    }
    if (part.kind === "tool_pending") {
      return `<div class="lens-tool lens-tool-running" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">running ${escapeHtml(part.name || "tool")}…</div>`;
    }
    if (part.kind === "tool") {
      const key = partKey(turnIndex, partIndex, part);
      const open = expandedTools.has(key);
      const label = part.is_error ? "lens-tool-error" : "";
      // data-part-key sits on the OUTER row (not the head) so the
      // pending -> resolved swap finds and replaces the whole row.
      const head = `<div class="lens-tool-head ${label}" data-toggle-tool="${escapeAttr(key)}">` +
        `<span class="lens-tool-name">${escapeHtml(part.name || "tool")}</span>` +
        `<span class="lens-tool-brief">${escapeHtml(part.brief || "")}</span>` +
        `<span class="lens-tool-caret">${open ? "▾" : "▸"}</span></div>`;
      if (!open)
        return `<div class="lens-tool" data-part-key="${escapeAttr(key)}">${head}</div>`;
      // A fetched whole output replaces the trimmed copy: no size meta,
      // no fetch button. Same ref only (a rotation may reuse the key).
      const fetched = fetchedOutputs.get(key);
      if (fetched && fetched.ref === part.output_ref) {
        return `<div class="lens-tool lens-tool-open" data-part-key="${escapeAttr(key)}">${head}` +
          `<pre class="lens-tool-output">${escapeHtml(fetched.output)}</pre></div>`;
      }
      const size = part.output_size
        ? `<div class="lens-tool-meta">output trimmed: ${part.output_size} chars total</div>`
        : "";
      return (
        `<div class="lens-tool lens-tool-open" data-part-key="${escapeAttr(key)}">${head}` +
        `<pre class="lens-tool-output">${escapeHtml(part.output || "")}</pre>${size}` +
        (part.output_ref
          ? `<button type="button" class="lens-tool-more" data-fetch-output="${escapeAttr(part.output_ref)}">Show full output</button>`
          : "") +
        `</div>`
      );
    }
    if (part.kind === "compact") {
      // Keyed like every other part: the same-count sync must find it
      // (an unkeyed row would be re-appended on every poll).
      return (
        `<div class="lens-compact" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}"><span class="lens-compact-label">Earlier context compacted</span>` +
        `<div class="lens-compact-summary">${escapeHtml(part.summary || "")}</div></div>`
      );
    }
    return "";
  }

  function loadingHtml() {
    return '<div class="lens-loading">loading chat…</div>';
  }

  function refusalHtml() {
    return `<div class="lens-refusal">${escapeHtml(refusalReasonCopy())}</div>`;
  }

  function errorHtml() {
    return `<div class="lens-refusal">Conversation unavailable right now</div>`;
  }

  function renderStructured(node) {
    const content = node.querySelector(".terminal-lens-content");
    if (!content) return;
    // Loading skeleton until the first response lands: never a blank
    // column (round 11).
    if (loadingChat) {
      content.innerHTML = loadingHtml();
      const scroller = node.querySelector("#terminalLensScroller");
      if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (convError) {
      // Error envelope from the route: map every code to its copy.
      // Resolution refusals show their specific copy (agent_session
      // reason parity); anything else shows the generic line.
      const code = convError.code;
      if (code === "no_session_path" || code === "ambiguous") {
        content.innerHTML = refusalHtml();
      } else {
        content.innerHTML = errorHtml();
      }
      const scroller = node.querySelector("#terminalLensScroller");
      if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (!conversation) {
      content.innerHTML = loadingHtml();
      return;
    }
    const turns = conversation.turns || [];
    const prevTurns = Number(content.dataset.renderedTurns || 0);
    const version = conversation.version;
    // Version changes on EVERY append (it is a stat-hash of both files),
    // so append detection is prefix identity: the conversation the DOM
    // already renders must be the prefix of the new one. Rotation and
    // compaction break the prefix -> full re-render. Prefix check: the
    // first prevTurns turn timestamps match. A SAME-COUNT response with
    // an intact prefix takes the sync path (in-flight tools resolving,
    // pending bubble) — never a rewrite: a full innerHTML swap on every
    // idle poll would wipe text selection every 2s.
    const prefixHolds =
      prevTurns > 0 &&
      turns.length >= prevTurns &&
      prefixMatches(content, turns, prevTurns);
    if (prevTurns === 0 || !prefixHolds) {
      // First render or a history rewrite (rotation, compaction, /clear):
      // one full re-render. Expansion state survives via the part keys.
      content.innerHTML = conversationHtml(conversation);
      content.dataset.renderedVersion = version;
      content.dataset.renderedTurns = String(turns.length);
      // A pending bubble on an empty/rewritten conversation is not part
      // of conversationHtml's turn output (empty turns short-circuit
      // before the bubble row): the DOM sync covers it.
      syncPendingBubbleDom(content);
    } else if (turns.length !== prevTurns) {
      // Append-only: rendered turn bodies are immutable, so only the
      // new turns are inserted at the tail (before the pending bubble,
      // which stays last). The chunk is rendered with the bubble
      // suppressed — syncPendingBubbleDom owns its single instance.
      const bubble = content.querySelector(".lens-turn-pending");
      const at = document.createElement("div");
      at.innerHTML = turns
        .slice(prevTurns)
        .map((turn, i) => conversationHtml({ turns: [turn] }, { from: prevTurns + i }))
        .join("");
      if (bubble) {
        while (at.firstChild) content.insertBefore(at.firstChild, bubble);
      } else {
        while (at.firstChild) content.appendChild(at.firstChild);
      }
      content.dataset.renderedTurns = String(turns.length);
      // In-flight tools in ALREADY-rendered turns may have resolved
      // (running -> full row) at constant prefix; sync them in place.
      syncMutableParts(content, turns);
      syncPendingBubbleDom(content);
    } else {
      // Same turn count: only in-flight tool rows and the pending
      // bubble can move; refresh both without touching the rest.
      syncMutableParts(content, turns);
      syncPendingBubbleDom(content);
    }
    const scroller = node.querySelector("#terminalLensScroller");
    if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function prefixMatches(content, turns, prevTurns) {
    // The DOM carries data-ts on every rendered turn; the prefix holds
    // when every rendered ts equals the new response's first ts at the
    // same offset. Cheaper and safer than re-hashing rendered HTML.
    const rendered = content.querySelectorAll(".lens-turn[data-ts]");
    if (rendered.length !== prevTurns) return false;
    for (let i = 0; i < prevTurns; i++) {
      const domTs = rendered[i].getAttribute("data-ts");
      const wireTs = turns[i] && turns[i].ts;
      if (domTs !== String(wireTs || "")) return false;
    }
    return true;
  }

  function syncPendingBubbleDom(content) {
    let existing = content.querySelector(".lens-turn-pending");
    if (pendingBubble) {
      if (!existing) {
        existing = document.createElement("div");
        existing.className =
          "lens-turn lens-turn-user lens-turn-pending";
        content.appendChild(existing);
      }
      existing.innerHTML = `<span>${escapeHtml(pendingBubble.text)}</span>`;
    } else if (existing) {
      existing.remove();
    }
  }

  function syncMutableParts(content, turns) {
    // Mutable part rows at stable prefix, all keyed by data-part-key:
    // 1. A rendered `running` row whose part became a full tool row
    //    (output landed): replace the row in place, same position.
    // 2. A new part appended inside an already-rendered turn (parts
    //    stream while the turn is open): append to the turn — tools and
    //    thinking via the key lookup, text parts straight to the tail.
    // 3. A thinking row whose expansion state changed: swap the row so
    //    the open body shows/clears without touching the rest.
    // Keys are turn:part:name so a row keeps its identity through the
    // kind flip (tool_pending -> tool) and the swap.
    turns.forEach((turn, turnIndex) => {
      const turnEl = content.querySelector(`[data-turn="${turnIndex}"]`);
      (turn.parts || []).forEach((part, partIndex) => {
        const key = partKey(turnIndex, partIndex, part);
        const row = content.querySelector(`[data-part-key="${cssEscape(key)}"]`);
        if (row) {
          const fresh = partHtml(part, turnIndex, partIndex);
          // Compare SERIALIZED forms on both sides: template text keeps
          // entities (&quot;) that the DOM serializer would not emit for
          // text nodes, so a raw string compare would swap unchanged rows
          // on every poll in a real browser. Round-tripping `fresh`
          // through a detached probe normalizes both to DOM-serialized
          // form; a no-change sync then performs zero swaps.
          const probe = document.createElement("div");
          probe.innerHTML = fresh;
          const freshSerialized = probe.firstChild ? probe.firstChild.outerHTML : fresh;
          if (row.outerHTML !== freshSerialized) {
            row.outerHTML = fresh;
          }
          return;
        }
        // Not keyed/not found: append the missing part to the rendered
        // turn (parts stream while the turn is open — text included).
        if (!turnEl) return;
        const at = document.createElement("div");
        at.innerHTML = partHtml(part, turnIndex, partIndex);
        while (at.firstChild) turnEl.appendChild(at.firstChild);
      });
    });
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_:-]/g, "\\$&");
  }

  // Delegated clicks for toggles and fetch buttons: nodes come and go
  // with each append, so per-node listeners would leak. Clicks land on
  // inner spans (name/brief/caret), so resolve up to the carrier.
  function onLensClick(event) {
    const target = event && event.target;
    if (!target || !target.closest) return;
    const toolToggle = target.closest("[data-toggle-tool]");
    if (toolToggle) {
      const key = toolToggle.getAttribute("data-toggle-tool");
      if (expandedTools.has(key)) expandedTools.delete(key);
      else expandedTools.add(key);
      render();
      return;
    }
    const thinkingToggle = target.closest("[data-toggle-thinking]");
    if (thinkingToggle) {
      const key = thinkingToggle.getAttribute("data-toggle-thinking");
      if (expandedThinking.has(key)) expandedThinking.delete(key);
      else expandedThinking.add(key);
      render();
      return;
    }
    const fetchButton = target.closest("[data-fetch-output]");
    if (fetchButton) {
      expandToolFullOutput(
        fetchButton,
        fetchButton.getAttribute("data-fetch-output"),
      );
    }
  }

  async function expandToolFullOutput(button, reference) {
    const paneId = activePaneId();
    if (!paneId) return;
    const row = button.closest("[data-part-key]");
    const key = row && row.getAttribute("data-part-key");
    button.disabled = true;
    button.textContent = "loading…";
    try {
      const response = await api(
        `/api/panes/${encodeURIComponent(paneId)}/tool-output?ref=${encodeURIComponent(reference)}`,
      );
      const output = String(response.output || "");
      // Record under the part key: the payload keeps the trimmed copy, so
      // the map is the source of truth for every later render (polls can
      // never swap the row back to trimmed or re-offer the button).
      if (key) fetchedOutputs.set(key, { ref: reference, output });
      // Touch up whichever row holds the key NOW: the original row may
      // have been swapped by a poll while the fetch was in flight. A
      // collapsed-again row has no pre/button — the map still serves the
      // next expand.
      const lensNode = document.getElementById("terminalLens");
      const current =
        key && lensNode
          ? lensNode.querySelector(`[data-part-key="${cssEscape(key)}"]`)
          : row;
      if (current) {
        const pre = current.querySelector(".lens-tool-output");
        if (pre) pre.textContent = output;
        const meta = current.querySelector(".lens-tool-meta");
        if (meta) meta.remove();
        const liveButton = current.querySelector("[data-fetch-output]");
        if (liveButton) liveButton.remove();
        else button.remove();
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = "Show full output (retry)";
    }
  }

  // ---- scrollback mode (original lens) ----

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
      // One delegated listener for tool/thinking toggles and full-output
      // fetch buttons (structured mode).
      node.addEventListener("click", onLensClick);
    }
    return node;
  }

  function structuredMode() {
    return lensActive && chatSupported();
  }

  function render() {
    const node = overlay();
    if (!node || !lensActive) return;
    if (structuredMode()) {
      const prevCount = countRenderedTurns(node);
      renderStructured(node);
      // Follow/unread pill: same contract as scrollback mode (design
      // section 5: reused unchanged). New turns while the reader
      // scrolled up surface the resume pill; a follow keeps the tail.
      const newCount = countRenderedTurns(node);
      if (!follow && newCount > prevCount) unread = true;
      const pill = node.querySelector("#terminalLensNew");
      if (pill) pill.hidden = !(unread && !follow);
      // Hint precedence (round 11): in structured mode the refusal copy
      // replaces the alt-screen hint entirely — jcode panes are always
      // alt-screen, so the alt hint is meaningless there.
      const altHint = node.querySelector("#terminalLensAlt");
      if (altHint) altHint.hidden = true;
      return;
    }
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

  function countRenderedTurns(node) {
    const content = node && node.querySelector(".terminal-lens-content");
    return content ? Number(content.dataset.renderedTurns || 0) : 0;
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
    const wasActive = lensActive;
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
      // Structured mode re-anchors to the pane now in view; scrollback
      // keeps its dirty-flag path.
      if (chatSupported()) {
        const paneId = activePaneId();
        if (paneId !== chatPane) resetChatState(paneId);
        contentDirty();
        ensurePolling();
      }
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
      stopPolling();
      // Case (c) of the pending-bubble lifecycle: the lens closed — the
      // optimistic bubble drops silently (never resurface a stale submit
      // on the next open).
      pendingBubble = null;
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
    void wasActive;
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
    // Force-off BEFORE the first render tick on the new pane: a jcode
    // pane's frozen transcript must never flash over an incoming shell
    // pane (round 11 force-off timing). Positive evidence only: with no
    // agent row for the pane (agents list empty, backend offline, or a
    // pane not yet snapshotted) the gate cannot judge — the lens keeps
    // its scrollback behavior instead of snapping shut mid-navigation.
    if (lensActive && activeAgentRow() && !chatSupported()) setLens(false);
    if (lensActive) {
      const paneId = activePaneId();
      if (chatSupported() && paneId !== chatPane) resetChatState(paneId);
      contentDirty();
      render();
      ensurePolling();
    }
    syncSwitchVisibility();
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
    // (rewrites of the same tail, spinner redraws). Structured mode
    // ignores it: its content source is the poll, not the bridge.
    if (!lensActive) return;
    if (structuredMode()) return;
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
    // corner; the terminal surface itself is untouched. Visibility per
    // pane is owned by syncSwitchVisibility, called on pane change and
    // after each snapshot.
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
    syncSwitchVisibility();
  }

  // Chat|Terminal visibility gate (design section 6): the switch shows
  // only on panes with a supported agent AND a non-null agent_session.
  // `resolvable: false` keeps it visible (the lens shows the refusal);
  // unsupported panes hide the switch and force the lens off.
  function syncSwitchVisibility() {
    const node = document.getElementById("terminalLensSwitch");
    if (!node) return;
    node.hidden = !chatSupported();
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
    syncSwitchVisibility,
    refreshConversation,
    setPendingBubble,
    // Test/diagnostic surface: the turn-shaping heuristics.
    transcriptHtml,
    PROMPT_LINE,
  };
})();
