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
  // Session metadata row (model / reasoning effort) for the composer
  // status line: reference parity ("composer status line displays the
  // model and Reasoning <level>"). null while unknown.
  let sessionMeta = null;

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

  // Refusal copy, newest evidence first: the poll's error code is
  // fresher than the agents row (state.agents only refreshes on events,
  // so a session that resolved at flip time and stopped matching later
  // keeps a stale resolved row while the poll already carries the
  // refusal). Fall back to the agents row for the resolvable:false gate
  // path, then the generic line (design section 6 hint precedence).
  function refusalReasonCopy(errorCode) {
    const a = activeAgentRow();
    const reason = errorCode || (a && a.agent_session && a.agent_session.reason);
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

  // The composer must never keep a dead pane's model label. Every path
  // that stops the structured poll (unsupported pane from a workspace
  // close or pane switch, lens closing) funnels through here so the
  // clear happens exactly once, even when no poll tick ever fires.
  function clearStaleSessionMeta() {
    if (!sessionMeta) return;
    sessionMeta = null;
    publishSessionMeta();
  }

  function ensurePolling() {
    // Poll only when the lens is open, the pane is chat-capable, and
    // the poll belongs to the pane now in view.
    if (!lensActive || !chatSupported()) {
      // No tick will ever run for this pane: clear now or the composer
      // freezes with the previous pane's label (workspace close often
      // lands here, before any poll timer can fire).
      clearStaleSessionMeta();
      return stopPolling();
    }
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
    if (!lensActive || !chatSupported()) {
      // The pane stopped being chat-capable between ticks (workspace
      // closed, pane switched to a shell). Same clear as the failed
      // poll: the composer must not keep the dead pane's model label.
      clearStaleSessionMeta();
      return stopPolling();
    }
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
      if (paneId !== chatPane || !lensActive) {
        // Stale in-flight poll (the pane moved while the request was
        // out): the response belongs to a pane nobody is looking at.
        // The new pane's tick will publish fresh meta, but if the new
        // pane never supports chat (workspace close), no tick runs:
        // clear now so the composer cannot freeze mid-transition.
        clearStaleSessionMeta();
        return;
      }
      convError = null;
      loadingChat = false;
      conversation = response;
      // Session metadata travels on every poll (model/effort refresh
      // even without a new message, reference parity): publish it so the
      // composer status line can render it.
      sessionMeta = {
        model: response && response.model ? String(response.model) : null,
        reasoning_effort:
          response && response.reasoning_effort
            ? String(response.reasoning_effort)
            : null,
      };
      publishSessionMeta();
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
      // A failed poll must not leave a stale model label on the
      // composer: the conversation is unavailable, so the status line
      // goes empty until a poll succeeds again.
      sessionMeta = null;
      publishSessionMeta();
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
    sessionMeta = null;
    publishSessionMeta();
    expandedTools.clear();
    expandedThinking.clear();
    fetchedOutputs.clear();
    // The decision answered/collapsed marks are per pane: a decision
    // answered on pane A must not suppress the chooser of a pending
    // question on pane B (the old pane's answer key could match by
    // text).
    decisionAnsweredKey = null;
    decisionCollapsedKey = null;
    // Working block state belongs to the pane it was expanded on: a
    // pane switch must not carry the expansion into the next pane's
    // turn, and any live tick timer must stop (it would keep firing on
    // the new pane's data otherwise).
    workingExpanded = false;
    stopWorkingTick();
    stopPolling();
  }

  // Push the session metadata to the composer status line. The composer
  // owns the DOM; the lens owns the data (it sees every poll). Keep this
  // tolerant of load order: composer.js may not exist yet.
  function publishSessionMeta() {
    if (
      globalThis.HerdrComposer &&
      typeof globalThis.HerdrComposer.setSessionMeta === "function"
    ) {
      globalThis.HerdrComposer.setSessionMeta(sessionMeta);
    }
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

  // Duration label for one assistant turn: "Worked for 2m 36s" style,
  // rendered as a muted meta line ABOVE the turn body (reference puts it
  // on the folded work block; we have no work blocks yet, so the meta
  // line carries it). Empty string when the span is unknown or bogus
  // (missing end, unparseable, negative, or absurdly large — clock skew
  // between snapshot and journal must not invent a 40-hour turn).
  function turnDurationHtml(turn) {
    const span = turnSpanSeconds(turn);
    if (span === null) return "";
    return `<div class="lens-turn-meta">Worked for ${formatDuration(span)}</div>`;
  }

  function turnSpanSeconds(turn) {
    if (!turn || !turn.ts || !turn.end_ts) return null;
    const start = Date.parse(String(turn.ts));
    const end = Date.parse(String(turn.end_ts));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const seconds = Math.round((end - start) / 1000);
    // <1s spans render as "0s" (fine, tool calls can be instant);
    // anything negative or > 24h is data corruption, not a duration.
    if (seconds < 0 || seconds > 24 * 60 * 60) return null;
    return seconds;
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mRest = m % 60;
    return mRest ? `${h}h ${mRest}m` : `${h}h`;
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
      // Assistant turns carry the turn's wall-clock span (ts -> end_ts)
      // as a muted duration line, reference parity ("Worked for 2m 36s"
      // blocks). Only rendered when both ends exist and parse.
      const metaHtml =
        turn.role === "assistant" ? turnDurationHtml(turn) : "";
      if (turn.role === "user") {
        out.push(
          `<div class="lens-turn lens-turn-user" data-turn="${globalIndex}" data-ts="${escapeAttr(String(turn.ts || ""))}"><span>${body}</span></div>`,
        );
      } else {
        out.push(
          `<div class="lens-turn lens-turn-assistant" data-turn="${globalIndex}" data-ts="${escapeAttr(String(turn.ts || ""))}">${metaHtml}${body}</div>`,
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
      // tabindex+role: the toggle must work from the keyboard alone
      // (the lens is a keyboard-heavy surface). The delegated keydown
      // handler below maps Enter/Space to the same toggle path as the
      // click.
      const head = `<span class="lens-thinking-toggle" data-toggle-thinking="${escapeAttr(key)}" tabindex="0" role="button" aria-expanded="${open}">${open ? "▾" : "▸"} thinking</span>`;
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
      const head = `<div class="lens-tool-head ${label}" data-toggle-tool="${escapeAttr(key)}" tabindex="0" role="button" aria-expanded="${open}">` +
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
    if (part.kind === "decision") {
      return decisionHtml(part, turnIndex, partIndex);
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

  // ---- structured mode: decision chooser (ask_user) ----

  // Identity of the decision the user answered/collapsed from the webui.
  // The decision row keeps rendering (it is part of the transcript) but
  // its interactive controls only show while the pane is blocked AND
  // this question was not already answered/dismissed here. The key is
  // the question + option labels so a re-ask of the SAME question in a
  // later ask_user is treated as a new decision (blocked re-arms it).
  // Answered from the webui (keystrokes sent): suppress the controls and
  // hint "answered, waiting". Collapsed from the webui (local hide, the
  // user wants to answer in the terminal): suppress the controls too, but
  // the hint must say the agent is STILL waiting.
  let decisionAnsweredKey = null;
  let decisionCollapsedKey = null;

  function decisionKey(part) {
    return (
      (part.question || "") +
      "|" +
      (part.options || []).map((o) => (o && o.label) || "").join("|")
    );
  }

  // OSC 9 jcode:blocked is the ONLY reliable blocked signal: the
  // session file alone cannot tell a blocked ask_user from a running
  // one. Three sources, freshest first:
  // 1. pane.agent_status_changed events (instant, per-pane)
  // 2. the active pane's agents row (per-pane, snapshot-refreshed)
  // 3. the workspace row (aggregated: strongest status wins)
  // The event map carries a TTL so a dropped events socket cannot pin a
  // stale `blocked` forever — the refreshed agents row takes over.
  const paneStatusEvents = new Map(); // pane id -> {status, at}
  const STATUS_EVENT_TTL_MS = 10000;

  function onAgentStatusChanged(data) {
    if (!data || !data.pane_id) return;
    paneStatusEvents.set(data.pane_id, {
      status: String(data.agent_status || ""),
      at: Date.now(),
    });
    // Instant arming/disarming: the chooser reacts to the event itself,
    // not the next poll tick (the agents row refreshes ~500ms later and
    // the poll would add up to 2s more).
    if (lensActive && data.pane_id === activePaneId()) render();
  }

  function paneBlockedNow() {
    try {
      if (typeof state === "undefined" || !state) return false;
      const paneId = state.pane;
      // 1. Freshest: the last status event for THIS pane (if recent).
      const event = paneId && paneStatusEvents.get(paneId);
      if (event && Date.now() - event.at < STATUS_EVENT_TTL_MS) {
        return event.status === "blocked";
      }
      // 2. Per-pane agents row (never the workspace aggregate: another
      // blocked pane in the same workspace must not arm THIS pane's
      // chooser — a stale click there types into the main input).
      const row = paneId && (state.agents || []).find((a) => a && a.pane_id === paneId);
      if (row && row.agent_status) {
        return (typeof statusClass === "function" ? statusClass(row.agent_status) : row.agent_status) === "blocked";
      }
      // 3. Workspace aggregate as the last resort (agents list empty).
      const ws = (state.workspaces || []).find(
        (w) => w && w.workspace_id === state.ws,
      );
      if (!ws) return false;
      const status =
        typeof statusClass === "function" ? statusClass(ws.agent_status) : ws.agent_status;
      return status === "blocked";
    } catch (_) {
      return false;
    }
  }

  // Working indicator: mirrors paneBlockedNow's three-source, freshest-
  // first gate but for the `working` status. While the ACTIVE pane's
  // agent works, the chat tail carries a collapsed animated block the
  // user can expand into a live elapsed timer. Pure presentation — no
  // keystrokes are synthesized, so there is no stale-interaction risk
  // to fail closed; the gate itself is per-pane and fails closed too
  // (another pane's worker must never animate this pane's tail).
  function paneWorkingNow() {
    try {
      if (typeof state === "undefined" || !state) return false;
      const paneId = state.pane;
      const event = paneId && paneStatusEvents.get(paneId);
      if (event && Date.now() - event.at < STATUS_EVENT_TTL_MS) {
        return event.status === "working";
      }
      const row = paneId && (state.agents || []).find((a) => a && a.pane_id === paneId);
      if (row && row.agent_status) {
        return (
          typeof statusClass === "function" ? statusClass(row.agent_status) : row.agent_status
        ) === "working";
      }
      const ws = (state.workspaces || []).find(
        (w) => w && w.workspace_id === state.ws,
      );
      if (!ws) return false;
      const status =
        typeof statusClass === "function" ? statusClass(ws.agent_status) : ws.agent_status;
      return status === "working";
    } catch (_) {
      return false;
    }
  }

  // The working block's reference start time, best effort: the status
  // event's arrival (exact transition-to-working moment we observed)
  // wins; the last assistant turn's ts is the fallback when the event
  // is too old to trust or was never seen (e.g. lens opened mid-turn).
  // Both are clamped sane: never negative, never older than 24h.
  function workingStartedAt() {
    const paneId = typeof state !== "undefined" && state ? state.pane : null;
    const event = paneId && paneStatusEvents.get(paneId);
    if (event && event.status === "working" && event.at) return event.at;
    const last = lastAssistantTurn();
    if (last && last.ts) {
      const parsed = Date.parse(String(last.ts));
      if (Number.isFinite(parsed)) {
        const now = Date.now();
        if (now - parsed >= 0 && now - parsed < 24 * 60 * 60 * 1000) return parsed;
      }
    }
    return null;
  }

  function lastAssistantTurn() {
    const turns = (conversation && conversation.turns) || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i] && turns[i].role === "assistant") return turns[i];
    }
    return null;
  }

  // User preference for the working block: expanded state survives
  // polls (renders re-run syncWorkingDom every cycle) but resets on
  // pane switch (it belongs to this pane's turn, not the next pane's).
  let workingExpanded = false;
  const WORKING_TICK_MS = 1000;
  let workingTickTimer = null;

  function workingBlockHtml() {
    const startedAt = workingStartedAt();
    const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
    // Collapsed: a quiet animated row (dots do the movement; CSS owns
    // the animation). Expanded: the live counter plus what we know
    // from the transcript (in-flight tools of the open turn).
    const head =
      `<div class="lens-working-toggle" data-toggle-working="1" tabindex="0" role="button" aria-expanded="${workingExpanded}">` +
      `<span class="lens-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="lens-working-label">${workingExpanded ? "Working" : "Thinking"}…</span>` +
      `<span class="lens-working-caret">${workingExpanded ? "▾" : "▸"}</span></div>`;
    let body = "";
    if (workingExpanded) {
      const lines = [];
      if (elapsed !== null)
        lines.push(`<div class="lens-working-elapsed">Working for ${formatDuration(elapsed)}</div>`);
      const running = runningToolsOfOpenTurn();
      if (running.length)
        lines.push(
          `<div class="lens-working-tools">${running
            .map((name) => `<span class="lens-working-tool">${escapeHtml(name)}</span>`)
            .join("")}</div>`,
        );
      if (!lines.length)
        lines.push('<div class="lens-working-note">Agent is processing — output appears when the turn completes</div>');
      body = `<div class="lens-working-body">${lines.join("")}</div>`;
    }
    return `${head}${body}`;
  }

  function runningToolsOfOpenTurn() {
    // The open assistant turn streams parts as it goes; a tool_pending
    // row there is a tool running RIGHT NOW. Older turns' pending rows
    // are stale data, not live activity.
    const turns = (conversation && conversation.turns) || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn) continue;
      if (turn.role !== "assistant") break; // user turn reached: turn over
      const names = (turn.parts || [])
        .filter((p) => p && p.kind === "tool_pending")
        .map((p) => p.name || "tool");
      return names;
    }
    return [];
  }

  // DOM sync for the working block: same shape as syncPendingBubbleDom.
  // Full re-render paths recreate the node; append/same-count paths
  // call this directly. The block must sit LAST (after the pending
  // bubble: the user's optimistic bubble is the true tail anchor) but
  // only while the pane actually works — status flips (idle, blocked)
  // remove it on the same tick that arming adds it.
  function syncWorkingDom(content) {
    if (!content) return;
    const show = paneWorkingNow() && !paneBlockedNow();
    let existing = content.querySelector(".lens-working");
    if (!show) {
      if (existing) existing.remove();
      stopWorkingTick();
      return;
    }
    if (!existing) {
      existing = document.createElement("div");
      existing.className = "lens-working";
      existing.setAttribute("data-working", "1");
      content.appendChild(existing);
    }
    existing.innerHTML = workingBlockHtml();
    // Keep the working block last: appends during the working turn
    // (new parts streaming into open turns) can leave it above the
    // pending bubble or below a newly landed turn. A re-order costs
    // nothing; a wrong order misleads (bubble looks resolved).
    const last = content.lastElementChild;
    if (last && last !== existing) content.appendChild(existing);
    if (workingExpanded) ensureWorkingTick();
  }

  // 1s in-place timer tick while expanded: rewrites only the block's
  // own innerHTML (the rest of the lens is untouched), stops when the
  // status flips away from working or the user collapses.
  function ensureWorkingTick() {
    if (workingTickTimer !== null) return;
    workingTickTimer = setTimeout(function onWorkingTick() {
      workingTickTimer = null;
      if (!lensActive || !workingExpanded || !paneWorkingNow()) return;
      const node = overlay();
      if (!node) return;
      const content = node.querySelector(".terminal-lens-content");
      const block = content && content.querySelector(".lens-working");
      if (block) block.innerHTML = workingBlockHtml();
      ensureWorkingTick();
    }, WORKING_TICK_MS);
  }

  function stopWorkingTick() {
    if (workingTickTimer !== null) {
      clearTimeout(workingTickTimer);
      workingTickTimer = null;
    }
  }

  function decisionHtml(part, turnIndex, partIndex) {
    const key = partKey(turnIndex, partIndex, part);
    const options = Array.isArray(part.options) ? part.options : [];
    const identity = decisionKey(part);
    const answeredHere = decisionAnsweredKey === identity;
    const collapsedHere = decisionCollapsedKey === identity;
    const interactive = paneBlockedNow() && !answeredHere && !collapsedHere;
    const rows = options
      .map((option, i) => {
        const label = (option && option.label) || "";
        const detail = option && option.detail;
        return (
          `<button type="button" class="lens-decision-option" data-decision-key="${escapeAttr(key)}" ` +
          `data-decision-index="${i + 1}" tabindex="${interactive ? 0 : -1}" ` +
          `aria-disabled="${!interactive}"><span class="lens-decision-label">${escapeHtml(label)}</span>` +
          (detail
            ? `<span class="lens-decision-detail">${escapeHtml(detail)}</span>`
            : "") +
          "</button>"
        );
      })
      .join("");
    const context = part.context
      ? `<div class="lens-decision-context">${escapeHtml(part.context)}</div>`
      : "";
    const answerForm = interactive
      ? `<form class="lens-decision-form" data-decision-key="${escapeAttr(key)}">` +
        `<input class="lens-decision-input" placeholder="Your answer"${inputAttrs("send")} aria-label="Your answer">` +
        `<button type="submit" class="lens-decision-send">Send</button></form>`
      : "";
    const expand = collapsedHere && paneBlockedNow()
      ? `<button type="button" class="lens-decision-expand" data-decision-key="${escapeAttr(key)}">Answer</button>`
      : "";
    const dismiss = interactive
      ? `<button type="button" class="lens-decision-dismiss" data-decision-key="${escapeAttr(key)}">Dismiss</button>`
      : "";
    // Answered state: one quiet line instead of live controls. The
    // wording covers both ends (answered here, answered/dismissed in
    // the terminal) because the poll cannot tell them apart — the
    // tool_result simply has not landed yet. A collapsed card keeps an
    // "Answer" button while the pane is STILL blocked; once the pane
    // unblocks the decision resolved somewhere, so the hint flips to
    // answered and the expand button goes away.
    let hint;
    if (interactive) hint = '<div class="lens-decision-hint">Pick a number or type your own answer</div>';
    else if (collapsedHere && paneBlockedNow()) hint = '<div class="lens-decision-hint">Waiting for your answer in the terminal</div>';
    else hint = '<div class="lens-decision-hint">Answered — waiting for the agent to continue</div>';
    return (
      `<div class="lens-decision" data-part-key="${escapeAttr(key)}" data-decision="${interactive ? "live" : "answered"}">` +
      `<div class="lens-decision-question">${escapeHtml(part.question || "")}</div>` +
      context +
      rows +
      answerForm +
      dismiss +
      expand +
      hint +
      `</div>`
    );
  }

  // The DOM key is turn:part:name; recover the decision part from the
  // CURRENT conversation by position so the dismissal marks the right
  // question even after polls reshuffled rows. Decision parts carry no
  // name, so the key's name segment is always the empty string.
  function decisionPartFromDom(key) {
    const turns = (conversation && conversation.turns) || [];
    const parts = String(key).split(":");
    const turnIndex = Number(parts[0]);
    const partIndex = Number(parts[1]);
    const name = parts.slice(2).join(":");
    if (!Number.isInteger(turnIndex) || !Number.isInteger(partIndex)) return null;
    const part = turns[turnIndex] && (turns[turnIndex].parts || [])[partIndex];
    if (!part || part.kind !== "decision") return null;
    if ((part.name || "") !== name) return null;
    return part;
  }

  // Answering synthesizes keystrokes through the same sendInputData
  // path prompt_cards uses: the TUI chooser owns the keyboard while
  // visible, so a digit (option pick) or typed text + Enter (free-form
  // answer) resolves it. Double-guarded: the pane must STILL be blocked
  // (a stale click after the TUI answered types garbage into the main
  // input) and the decision part must still be live in the current
  // conversation (position + name match).
  function decisionAnswer(key, payload) {
    if (!paneBlockedNow()) return;
    const part = decisionPartFromDom(key);
    if (!part) return;
    const identity = decisionKey(part);
    // Already answered from the webui: the pane is STILL blocked on the
    // same question (the tool_result has not landed yet). A second send
    // would type into the chooser a second time — after the first
    // answer resolves it, that lands in the re-enabled main input.
    if (decisionAnsweredKey === identity) return;
    if (typeof sendInputData !== "function") return;
    sendInputData(payload);
    decisionAnsweredKey = identity;
    // The next poll folds the ask_user into a plain tool row once the
    // tool_result lands; until then the answered hint replaces the
    // controls immediately (no second click can double-send).
    render();
  }

  function decisionDismiss(key) {
    const part = decisionPartFromDom(key);
    if (!part) return;
    decisionCollapsedKey = decisionKey(part);
    render();
  }

  function decisionExpand(key) {
    const part = decisionPartFromDom(key);
    if (!part) return;
    if (decisionKey(part) !== decisionCollapsedKey) return;
    decisionCollapsedKey = null;
    render();
  }

  function refusalHtml(errorCode) {
    return `<div class="lens-refusal">${escapeHtml(refusalReasonCopy(errorCode))}</div>`;
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
        content.innerHTML = refusalHtml(code);
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
      syncWorkingDom(content);
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
      syncWorkingDom(content);
    } else {
      // Same turn count: only in-flight tool rows and the pending
      // bubble can move; refresh both without touching the rest.
      syncMutableParts(content, turns);
      syncPendingBubbleDom(content);
      syncWorkingDom(content);
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

  // Delegated clicks for toggles, decision buttons, and fetch buttons:
  // nodes come and go with each append, so per-node listeners would leak.
  // Clicks land on inner spans (name/brief/caret), so resolve up to the
  // carrier.
  function onLensClick(event) {
    const target = event && event.target;
    if (!target || !target.closest) return;
    const decisionOption = target.closest("[data-decision-key].lens-decision-option");
    if (decisionOption) {
      const key = decisionOption.getAttribute("data-decision-key");
      const index = Number(decisionOption.getAttribute("data-decision-index"));
      // TUI contract: digits 1-9 pick an option IMMEDIATELY when an
      // option row is selected (no Enter). An Up arrow first guarantees
      // an option row is selected even if the user had moved the TUI
      // selection onto the "Your answer" row (Up from there lands on the
      // last option; from an option row it moves up one, still an
      // option). No trailing Enter: the chooser resolves on the digit,
      // and an Enter after it would hit the re-enabled main input.
      if (Number.isInteger(index) && index >= 1)
        decisionAnswer(key, "\u001b[A" + String(index));
      return;
    }
    const decisionDismissBtn = target.closest("[data-decision-key].lens-decision-dismiss");
    if (decisionDismissBtn) {
      decisionDismiss(decisionDismissBtn.getAttribute("data-decision-key"));
      return;
    }
    const decisionExpandBtn = target.closest("[data-decision-key].lens-decision-expand");
    if (decisionExpandBtn) {
      decisionExpand(decisionExpandBtn.getAttribute("data-decision-key"));
      return;
    }
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
    // Working block toggle: pure local state, no keystrokes. Gated on
    // paneWorkingNow() so a stale click (turn just ended, the kept node
    // is detached) cannot flip expansion state that no block renders.
    const workingToggle = target.closest("[data-toggle-working]");
    if (workingToggle) {
      if (paneWorkingNow() && !paneBlockedNow()) {
        workingExpanded = !workingExpanded;
        if (!workingExpanded) stopWorkingTick();
      }
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

  // Keyboard twin of onLensClick: Enter/Space on a focused tool or
  // thinking head toggles the same way a click does. Delegated for the
  // same leak reason as the click (the lens rewrites innerHTML). Native
  // <button> elements (fetch-output) already handle their own keys, so
  // this only serves the div/span carriers.
  function onLensKeydown(event) {
    const key = event && event.key;
    if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
    const target = event && event.target;
    if (!target || !target.closest) return;
    const toggle =
      target.closest("[data-toggle-tool]") ||
      target.closest("[data-toggle-thinking]") ||
      target.closest("[data-toggle-working]");
    if (!toggle) return;
    // Only act when the carrier itself has focus (not an inner span
    // that happens to bubble): the carriers carry tabindex, inner
    // spans do not, so target === toggle is the focused case.
    if (target !== toggle) return;
    event.preventDefault();
    onLensClick({ target: toggle });
  }

  // The decision answer form's submit path: Enter in the input or the
  // Send button. Delegated on the overlay root so it survives the
  // innerHTML rewrites (same leak reason as the click).
  function onLensSubmit(event) {
    const target = event && event.target;
    if (!target || !target.closest) return;
    const form = target.closest("form.lens-decision-form");
    if (!form) return;
    if (event.preventDefault) event.preventDefault();
    const key = form.getAttribute("data-decision-key");
    const input = form.querySelector(".lens-decision-input");
    const text = input && input.value ? String(input.value).trim() : "";
    if (!text) return;
    // TUI contract for free-form answers: typing only reaches the
    // answer draft when the "Your answer" row is selected, and the
    // selection state is invisible from here. A bracketed paste
    // instead is deterministic: the TUI routes paste into the chooser's
    // answer draft AND auto-selects the answer row (input.rs
    // handle_paste), whatever row was selected. The trailing Enter then
    // submits the draft. jcode enables bracketed paste, and the markers
    // survive sendInputData (only OSC color replies and mouse reports
    // are stripped). Newlines become spaces like any terminal paste.
    const payload =
      "\u001b[200~" +
      text.replace(/[\r\n]+/g, " ") +
      "\u001b[201~" +
      "\r";
    decisionAnswer(key, payload);
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
      // One delegated listener for tool/thinking toggles, decision
      // buttons, and full-output fetch buttons (structured mode), plus
      // their keyboard twins. The decision answer form rides the same
      // delegation through a submit listener (submit bubbles).
      node.addEventListener("click", onLensClick);
      node.addEventListener("keydown", onLensKeydown);
      node.addEventListener("submit", onLensSubmit);
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
      // The lens closed: the working tick has no DOM to update — stop
      // it here too, and drop the expansion (the turn it described is
      // ambiguous by the next open; the next working turn starts fresh).
      stopWorkingTick();
      workingExpanded = false;
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
      // The lens stays open on non-chat panes when no agent row exists
      // (setLens force-off needs positive evidence): make sure the
      // previous pane's meta does not survive the switch.
      if (!chatSupported()) clearStaleSessionMeta();
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
    // Test/diagnostic surface: duration shaping for assistant turns.
    turnDurationHtml,
    formatDuration,
    // Test/diagnostic surface: the decision chooser internals.
    decisionHtml,
    paneBlockedNow,
    paneWorkingNow,
    onAgentStatusChanged,
    _decisionAnsweredKey: () => decisionAnsweredKey,
    _resetDecisionState: () => { decisionAnsweredKey = null; },
    // Test/diagnostic surface: the working (thinking) block internals.
    workingBlockHtml,
    syncWorkingDom,
    _workingExpanded: () => workingExpanded,
    _resetWorkingState: () => {
      workingExpanded = false;
      stopWorkingTick();
    },
  };
})();
