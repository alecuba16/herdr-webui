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
  // Connect target of the pane the reading state belongs to. It keys the
  // same-pane guard in onPaneChanged: refresh() polls re-run
  // connectTerminal on the unchanged pane and must not reset follow.
  let lastPaneKey = null;
  // The pane moved away from a chat pane while the lens was open, so
  // onPaneChanged force-closed it (an agent-less panel must not show
  // the previous pane's chat). The user never closed it: coming back
  // to a chat-capable pane reopens the lens.
  let autoReopenOnChatPane = false;

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
  // Older pages (reference heldOlder parity): turns the chat holds above
  // the newest page, fetched with `before` as the reader scrolls up.
  // heldFrom anchors the newest-page poll at the oldest turn the chat
  // holds, so no poll ever reads more than a page once older pages are
  // held. olderCursor is the next-older cursor (null = beginning
  // reached); olderState gates the loader (idle/loading/failed).
  let olderTurns = [];
  let olderCursor = null;
  let heldFrom = null;
  let olderState = "idle";
  // True when the gap-backfill walk hit its 32-page bound and the
  // held older pages were dropped: the transcript between the shown
  // pages and the held ones is KNOWN-missing, and the endcap below
  // the load-older control says so instead of hiding the truncation.
  let olderTruncated = false;
  // ETag of the last newest-page answer, keyed by the poll URL. A poll
  // that sends If-None-Match and gets 304 skips all re-render work; the
  // browser cache stays out of it (no-store, reference parity) so the
  // lens itself is the only cache.
  let pollEtag = null;
  let pollUrl = null;
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

  // The newest-page poll request. Bypasses the shared api() helper on
  // purpose: it unconditionally parses JSON, and a 304 has no body to
  // parse (reference fetchPaneConversation parity). HerdrHttp.options()
  // keeps the session/backend headers on the direct fetch, so auth rides
  // exactly like every other call.
  function conversationUrl(paneId, params) {
    // Hand-built query, not URLSearchParams: the vm test harness and
    // any sandboxed host may not expose the constructor, and the shape
    // here is fixed (pane_id plus at most one cursor param).
    let query = `pane_id=${encodeURIComponent(paneId)}`;
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null)
        query += `&${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    }
    return `/api/panes/${encodeURIComponent(paneId)}/conversation?${query}`;
  }

  async function fetchConversation(paneId, params, etag) {
    const url = conversationUrl(paneId, params);
    const headers = {};
    if (etag) headers["if-none-match"] = etag;
    const opts =
      typeof globalThis.HerdrHttp === "object" && globalThis.HerdrHttp
        ? globalThis.HerdrHttp.options({ headers })
        : { credentials: "same-origin", headers };
    const response = await fetch(url, opts);
    if (response.status === 304 && etag) return { notModified: true };
    if (response.status === 401 && typeof location !== "undefined") {
      location.href = "/";
      throw Error("unauthorized");
    }
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    if (!response.ok || (body && body.error)) {
      const error = Error(
        (body && body.error && String(body.error)) || response.statusText || "poll failed",
      );
      error.status = response.status;
      error.details = body || {};
      throw error;
    }
    return { notModified: false, body, etag: response.headers.get("etag") };
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
      // From-anchored newest-page poll (reference parity): once older
      // pages are held the poll starts at the held start, so no poll
      // reads more than a page.
      const params = heldFrom !== null ? { from: heldFrom } : {};
      const url = conversationUrl(paneId, params);
      const etag = pollUrl === url ? pollEtag : null;
      const result = await fetchConversation(paneId, params, etag);
      if (paneId !== chatPane || !lensActive) {
        // Stale in-flight poll (the pane moved while the request was
        // out): the response belongs to a pane nobody is looking at.
        // The new pane's tick will publish fresh meta, but if the new
        // pane never supports chat (workspace close), no tick runs:
        // clear now so the composer cannot freeze mid-transition.
        clearStaleSessionMeta();
        return;
      }
      if (result.notModified) {
        // Unchanged since the last answer (304 + If-None-Match): the
        // rendered conversation is already current — no re-render, no
        // meta churn, no pending-bubble scan. The idle poll costs one
        // header round trip.
        return;
      }
      const response = result.body;
      pollUrl = url;
      pollEtag = result.etag || null;
      convError = null;
      loadingChat = false;
      conversation = response;
      // While no older pages are held, the newest page's cursor is the
      // next-older page's `before` (reference: setOlderCursor on every
      // read). Once pages are held, the poll's cursor describes the
      // held join point instead and loadOlder owns olderCursor.
      if (heldFrom === null) olderCursor = response.cursor;
      // Older pages: the newest page may have moved past the held
      // start (new turns pushed the page window). Backfill the gap
      // with `before` pages and re-anchor, so the held turns and the
      // newest page stay contiguous (reference turnsBetween parity,
      // bounded so a runaway walk cannot spin).
      if (heldFrom !== null && response.cursor && response.cursor !== heldFrom) {
        const moved = await turnsBetween(paneId, heldFrom, response.cursor);
        if (moved === null || moved === "bounded") {
          // The gap cannot be joined (history changed mid-walk) or the
          // walk hit its 32-page bound: drop the older pages and
          // re-anchor on the newest page: the same clean-reset a 409
          // triggers. A bounded walk also marks what was lost: the
          // endcap under the load-older control says turns were
          // skipped instead of hiding the truncation.
          const bounded = moved === "bounded";
          dropOlderPages();
          olderTruncated = bounded;
          const fresh = await fetchConversation(paneId, {}, null);
          if (fresh.notModified) return;
          if (paneId !== chatPane || !lensActive) return;
          conversation = fresh.body;
          pollUrl = conversationUrl(paneId, {});
          pollEtag = fresh.etag || null;
          // The gap was too wide to join, but the newest page's own
          // cursor is a valid walk-back point: keep the load-older
          // control alive so the reader can page down manually, with
          // the truncation note above it explaining the skip.
          if (bounded && typeof fresh.body.cursor === "string")
            olderCursor = fresh.body.cursor;
        } else if (moved.length) {
          olderTurns = olderTurns.concat(moved);
          heldFrom = response.cursor;
        } else {
          heldFrom = response.cursor;
        }
      } else if (heldFrom !== null && !response.cursor) {
        // The held start fell out of the newest page AND the page
        // reached the transcript beginning: everything before the
        // newest page is the older pages already held. Keep them.
        heldFrom = response.cursor; // null: next poll reads the newest page whole
      }
      // Session metadata travels on every poll (model/effort refresh
      // even without a new message, reference parity): publish it so the
      // composer status line can render it.
      sessionMeta = {
        model: response && response.model ? String(response.model) : null,
        reasoning_effort:
          response && response.reasoning_effort
            ? String(response.reasoning_effort)
            : null,
        title: response && response.title ? String(response.title) : null,
        context_used:
          response && Number.isFinite(Number(response.context_used))
            ? Number(response.context_used)
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
      const code = (details && details.code) || "error";
      if (code === "history_changed" || error.status === 409) {
        // The transcript the older pages came from is gone (rotation,
        // /clear, or a cursor the transcript no longer knows). Drop the
        // older pages and re-anchor: the next tick reads the newest
        // page of whatever history exists now (reference dropOlder
        // parity — one clean reset, no zombie pages).
        dropOlderPages();
        convError = null;
        loadingChat = false;
        pollEtag = null;
        pollUrl = null;
        // Retry once immediately with a clean fetch; on failure the
        // normal error path below renders the refusal.
        try {
          const fresh = await fetchConversation(paneId, {}, null);
          if (paneId !== chatPane || !lensActive) return;
          if (!fresh.notModified) {
            conversation = fresh.body;
            pollUrl = conversationUrl(paneId, {});
            pollEtag = fresh.etag || null;
            sessionMeta = metaFromConversation(conversation);
            publishSessionMeta();
            render();
            return;
          }
        } catch (_) {
          // fall through to the error render
        }
      }
      convError = {
        code,
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

  // Turns between a held start and where the newest page now starts,
  // a page at a time (reference turnsBetween parity). Null when the
  // walk cannot be joined (history changed); "bounded" when the walk
  // hit its 32-page bound before reaching the held start: a caller
  // that treats both alike silently hides a real truncation, so the
  // bound gets its own answer.
  async function turnsBetween(paneId, held, start) {
    const pages = [];
    let before = start;
    try {
      for (let step = 0; step < 32 && before !== held; step++) {
        const result = await fetchConversation(paneId, { before }, null);
        if (result.notModified) return null;
        const page = result.body;
        if (typeof page.cursor !== "string") return null;
        pages.unshift(page.turns || []);
        before = page.cursor;
      }
    } catch (_) {
      return null;
    }
    if (before === held) return pages.flat();
    return "bounded";
  }

  function metaFromConversation(response) {
    return {
      model: response && response.model ? String(response.model) : null,
      reasoning_effort:
        response && response.reasoning_effort
          ? String(response.reasoning_effort)
          : null,
      title: response && response.title ? String(response.title) : null,
      context_used:
        response && Number.isFinite(Number(response.context_used))
          ? Number(response.context_used)
          : null,
    };
  }

  // Drop the held older pages and re-anchor on the newest page (a 409,
  // a history rewrite, or a failed gap join).
  function dropOlderPages() {
    olderTurns = [];
    olderCursor = null;
    heldFrom = null;
    olderState = "idle";
    olderTruncated = false;
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
    dropOlderPages();
    pollEtag = null;
    pollUrl = null;
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

  // ---- older pages (reference loadOlder parity) ----

  // Fetch one page of older turns with `before` and prepend them,
  // keeping the reader's viewport anchored where it was (the scroll
  // position math happens in renderStructured, keyed on the
  // prepended-anchor dataset this function sets).
  async function loadOlder() {
    const paneId = activePaneId();
    if (!paneId || paneId !== chatPane) return;
    if (olderState === "loading" || typeof olderCursor !== "string") return;
    const before = olderCursor;
    olderState = "loading";
    try {
      const result = await fetchConversation(paneId, { before }, null);
      // Pane moved while the fetch was out: the page belongs to a
      // pane nobody is looking at.
      if (paneId !== chatPane || !lensActive) return;
      if (result.notModified) {
        olderState = "failed";
        return;
      }
      const page = result.body;
      // A history rewrite between the poll and this fetch: drop and
      // re-anchor (same clean reset as a 409 on the poll).
      if (page && page.error) {
        olderState = "failed";
        return;
      }
      if (!page || typeof page.cursor !== "string" && page.cursor !== null) {
        olderState = "failed";
        return;
      }
      // First older page: anchor the newest-page poll at the start of
      // the newest turns the chat already holds, so no later poll reads
      // more than a page.
      const first = heldFrom === null;
      heldFrom = first ? before : heldFrom;
      olderTurns = (page.turns || []).concat(olderTurns);
      olderCursor = page.cursor;
      olderState = "idle";
      // The newest page may have slid since it was read (turns landed
      // between the poll and this fetch): poll from the held start
      // now instead of waiting for the next tick.
      if (first) refreshConversation();
      render();
    } catch (error) {
      if (paneId !== chatPane || !lensActive) return;
      const status = error && error.status;
      const code = error && error.details && error.details.code;
      if (status === 409 || code === "history_changed") {
        dropOlderPages();
        refreshConversation();
        return;
      }
      olderState = "failed";
      render();
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
    if (part.kind === "image") {
      // Image parts reference their bytes by message id (reference
      // conversationImage parity): the <img> src points at the byte
      // route, which serves the same session's immutable bytes with a
      // day-long private cache — repeated polls cost no refetches. The
      // media_type rides on the part for alt text only; the byte route
      // owns the real content-type.
      const ref = part.ref || "";
      if (!ref) return "";
      const paneId = activePaneId();
      const src = paneId
        ? `/api/panes/${encodeURIComponent(paneId)}/conversation/image?ref=${encodeURIComponent(ref)}`
        : "";
      const alt = part.media_type ? `pasted ${part.media_type} image` : "pasted image";
      return `<div class="lens-image" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">` +
        `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">` +
        `</div>`;
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
      // The name gets the tool-name span so the cyan anchor holds while a
      // call runs (the row itself is amber: in-flight state reads first,
      // then what is running).
      return `<div class="lens-tool lens-tool-running" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">running <span class="lens-tool-name">${escapeHtml(part.name || "tool")}</span>…</div>`;
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
  // wins. Fallback ONLY when the last turn is the OPEN assistant turn
  // (mid-flight, its ts is when the first flush landed): the turn is
  // the thing working, so time-since-start is honest. When the last
  // turn is a user turn (fresh question, no assistant content yet) or
  // the event was never seen, there is no honest reference — return
  // null and the body renders the note line instead of an invented
  // elapsed counter (the PREVIOUS turn's ts must never stand in).
  function workingStartedAt() {
    const paneId = typeof state !== "undefined" && state ? state.pane : null;
    const event = paneId && paneStatusEvents.get(paneId);
    if (event && event.status === "working" && event.at) return event.at;
    const turns = (conversation && conversation.turns) || [];
    const last = turns[turns.length - 1];
    if (!last || last.role !== "assistant" || !last.ts) return null;
    const parsed = Date.parse(String(last.ts));
    if (!Number.isFinite(parsed)) return null;
    const now = Date.now();
    if (now - parsed >= 0 && now - parsed < 24 * 60 * 60 * 1000) return parsed;
    return null;
  }

  // User preference for the working block: expanded state survives
  // polls (renders re-run syncWorkingDom every cycle) but resets on
  // pane switch (it belongs to this pane's turn, not the next pane's).
  let workingExpanded = false;
  const WORKING_TICK_MS = 1000;
  let workingTickTimer = null;

  // The working block is split head/body so the head can keep node
  // identity: the head is built ONCE per block and never rewritten
  // afterwards (syncs mutate attributes/text in place), while the
  // body is a plain innerHTML region. Rewriting the head would drop
  // keyboard focus from the toggle on every poll/tick.
  function workingHeadLabel() {
    if (workingExpanded) return "Working";
    const running = runningToolsOfOpenTurn();
    return running.length ? String(running[0]) : "Thinking";
  }

  function workingHeadHtml() {
    return (
      `<div class="lens-working-toggle" data-toggle-working="1" tabindex="0" role="button" aria-expanded="${workingExpanded}">` +
      `<span class="lens-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="lens-working-label">${escapeHtml(workingHeadLabel())}…</span>` +
      `<span class="lens-working-caret">${workingExpanded ? "▾" : "▸"}</span></div>`
    );
  }

  function workingBodyLines() {
    const startedAt = workingStartedAt();
    const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
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
    return lines.join("");
  }

  function workingBodyHtml() {
    return `<div class="lens-working-body">${workingBodyLines()}</div>`;
  }

  // Diagnostic surface: the full block markup in one string.
  function workingBlockHtml() {
    return `${workingHeadHtml()}${workingExpanded ? workingBodyHtml() : ""}`;
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
      // Seed once per block: head + (expanded ? body). Every later
      // sync mutates the head in place and only rewrites the body
      // region, so the toggle/dots/label/caret nodes never change.
      existing.innerHTML = workingBlockHtml();
    } else {
      syncWorkingHead(existing);
      syncWorkingBody(existing);
    }
    // Keep the working block last: appends during the working turn
    // (new parts streaming into open turns) can leave it above the
    // pending bubble or below a newly landed turn. A re-order costs
    // nothing; a wrong order misleads (bubble looks resolved).
    const last = content.lastElementChild;
    if (last && last !== existing) content.appendChild(existing);
    if (workingExpanded) ensureWorkingTick();
  }

  // In-place head sync: attribute/text writes only, never a rewrite
  // (a rewritten head drops keyboard focus from the toggle).
  function syncWorkingHead(block) {
    const toggle = block.querySelector("[data-toggle-working]");
    if (!toggle) return; // no head: the next full render re-seeds
    toggle.setAttribute("aria-expanded", workingExpanded ? "true" : "false");
    const label = toggle.querySelector(".lens-working-label");
    if (label) label.textContent = `${workingHeadLabel()}…`;
    const caret = toggle.querySelector(".lens-working-caret");
    if (caret) caret.textContent = workingExpanded ? "▾" : "▸";
  }

  // The body is a plain region: rewrite its innerHTML, create or drop
  // the wrapper as expansion demands. The head stays untouched.
  function syncWorkingBody(block) {
    // Accepted tradeoff: only the elapsed line is 1s-tick fresh; the
    // tools chips refresh on the poll cycle (~2s) because a body
    // rewrite is the only honest way to recompute them from state,
    // and body rewrites are exactly what the head must not do.
    let body = block.querySelector(".lens-working-body");
    if (!workingExpanded) {
      if (body) body.remove();
      return;
    }
    if (!body) {
      body = document.createElement("div");
      body.className = "lens-working-body";
      block.appendChild(body);
    }
    body.innerHTML = workingBodyLines();
  }

  // 1s in-place timer tick while expanded: touches only the elapsed
  // line inside the block (head nodes keep their identity, so focus
  // on the toggle survives every second), stops when the status
  // flips away from working or the user collapses.
  function ensureWorkingTick() {
    if (workingTickTimer !== null) return;
    workingTickTimer = setTimeout(function onWorkingTick() {
      workingTickTimer = null;
      if (!lensActive || !workingExpanded || !paneWorkingNow()) return;
      const node = overlay();
      if (!node) return;
      const content = node.querySelector(".terminal-lens-content");
      const block = content && content.querySelector(".lens-working");
      // No block (error/refusal copy took the content over): die here
      // instead of re-arming forever — the next render that owns a
      // block re-arms through syncWorkingDom.
      if (!block) return;
      // Touch ONLY the elapsed line: the head keeps node identity
      // (and keyboard focus) across every tick. A null startedAt here
      // means the reference vanished mid-tick; keep the last honest
      // text instead of blanking the line (the next poll rebuilds
      // the body from fresh state).
      const elapsedLine = block.querySelector(".lens-working-elapsed");
      if (elapsedLine) {
        const startedAt = workingStartedAt();
        if (startedAt) {
          const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
          elapsedLine.textContent = `Working for ${formatDuration(elapsed)}`;
        }
      }
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
    // The rendered conversation is older pages + the newest page; the
    // turn-key indices the DOM already carries stay valid only when the
    // OLDER prefix is unchanged, so the append detection works on the
    // joined view, not the newest page alone.
    const olderCount = olderTurns.length;
    const prevOlder = Number(content.dataset.renderedOlder || 0);
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
    const joinedTurns = olderTurns.concat(turns);
    // An older page landing rewrites the front of the view: turn keys
    // SHIFT, so the append path cannot serve it. One full re-render,
    // scroll-anchored so the reader's viewport keeps the content it was
    // looking at (reference prepended.current parity).
    const olderPrepended = olderCount !== prevOlder;
    const prefixHolds =
      prevTurns > 0 &&
      !olderPrepended &&
      joinedTurns.length >= prevTurns &&
      prefixMatches(content, joinedTurns, prevTurns);
    const scroller0 = node.querySelector("#terminalLensScroller");
    const anchor = scroller0
      ? { top: scroller0.scrollTop, height: scroller0.scrollHeight }
      : null;
    if (prevTurns === 0 || olderPrepended || !prefixHolds) {
      // First render, an older-page prepend, or a history rewrite
      // (rotation, compaction, /clear): one full re-render. Expansion
      // state survives via the part keys.
      const olderHeader = olderPagesHeaderHtml();
      content.innerHTML =
        (olderHeader
          ? `<div data-older-control="1">${olderHeader}</div>`
          : "") + conversationHtml({ turns: joinedTurns });
      content.dataset.renderedVersion = version;
      content.dataset.renderedTurns = String(joinedTurns.length);
      content.dataset.renderedOlder = String(olderCount);
      // A pending bubble on an empty/rewritten conversation is not part
      // of conversationHtml's turn output (empty turns short-circuit
      // before the bubble row): the DOM sync covers it.
      syncPendingBubbleDom(content);
      syncWorkingDom(content);
    } else if (joinedTurns.length !== prevTurns) {
      // Append-only: rendered turn bodies are immutable, so only the
      // new turns are inserted at the tail (before the pending bubble,
      // which stays last). The chunk is rendered with the bubble
      // suppressed — syncPendingBubbleDom owns its single instance.
      // Turn keys are global across the joined view, so the chunk
      // starts at the joined offset.
      const bubble = content.querySelector(".lens-turn-pending");
      const at = document.createElement("div");
      at.innerHTML = joinedTurns
        .slice(prevTurns)
        .map((turn, i) =>
          conversationHtml({ turns: [turn] }, { from: prevTurns + i }),
        )
        .join("");
      if (bubble) {
        while (at.firstChild) content.insertBefore(at.firstChild, bubble);
      } else {
        while (at.firstChild) content.appendChild(at.firstChild);
      }
      content.dataset.renderedTurns = String(joinedTurns.length);
      // In-flight tools in ALREADY-rendered turns may have resolved
      // (running -> full row) at constant prefix; sync them in place.
      syncMutableParts(content, joinedTurns);
      syncPendingBubbleDom(content);
      syncWorkingDom(content);
    } else {
      // Same turn count: only in-flight tool rows, the pending
      // bubble, and the older-page control can move; refresh without
      // touching the rest.
      syncMutableParts(content, joinedTurns);
      syncPendingBubbleDom(content);
      syncWorkingDom(content);
      syncOlderControlDom(content);
    }
    // Prepended older turns shift the scroll: restore the reader's
    // viewport so the content under their eyes does not jump. Only a
    // prepend lands here (appends keep the follow tail below).
    const scroller = node.querySelector("#terminalLensScroller");
    if (olderPrepended && anchor && scroller) {
      scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
    } else if (follow && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  // The load-older row above the turns: a button while older turns
  // remain ("Load earlier messages" / "Loading…" / "Retry"), or a
  // muted marker once the beginning is held. Wrapped in the
  // data-older-control row so the in-place sync can find it on every
  // render without disturbing the turn keys below.
  function olderPagesHeaderHtml() {
    if (!conversation) return "";
    if (typeof olderCursor !== "string") {
      // The endcap only marks a KNOWN beginning: older pages were held
      // and walked to the transcript start (reference chat-endcap:
      // `olderCursor === null && older.length > 0`). A newest page with
      // no cursor and no held pages shows nothing — it is just a short
      // conversation.
      if (!olderTurns.length && !olderTruncated) return "";
      // A bounded reset with no held pages left is NOT the beginning:
      // turns were skipped, and the endcap must say that, not claim a
      // beginning the transcript never reached.
      if (olderTruncated && !olderTurns.length)
        return '<div class="lens-older-done" data-older-truncated="1">Some earlier messages were skipped to catch up</div>';
      return '<div class="lens-older-done">Beginning of conversation</div>';
    }
    const label =
      olderState === "loading"
        ? "Loading earlier…"
        : olderState === "failed"
          ? "Load earlier messages (retry)"
          : "Load earlier messages";
    const truncatedNote = olderTruncated
      ? '<div class="lens-older-done" data-older-truncated="1">Some earlier messages were skipped to catch up</div>'
      : "";
    return `${truncatedNote}<button type="button" class="lens-older-load" data-load-older="1">${label}</button>`;
  }

  // Keep the older-page control in sync without a full rewrite: swap
  // its content in place, or insert it above the first turn when the
  // append path skipped the full render (which created it).
  function syncOlderControlDom(content) {
    let row = content.querySelector("[data-older-control]");
    const header = olderPagesHeaderHtml();
    if (!header) {
      // The control fell away (history reset dropped the held pages,
      // or the conversation is simply short): the row must not linger
      // as an empty div above the turns.
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = document.createElement("div");
      row.setAttribute("data-older-control", "1");
      const firstTurn = content.querySelector(".lens-turn");
      if (firstTurn) content.insertBefore(row, firstTurn);
      else content.appendChild(row);
    }
    row.innerHTML = header;
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
      return;
    }
    // Load-older button: fetch the next page above the turns.
    const olderButton = target.closest("[data-load-older]");
    if (olderButton) {
      loadOlder();
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
          // Near the top (structured mode with older pages left):
          // fetch the next page the way the reference auto-loads on
          // scroll — the button stays for keyboard and precise clicks.
          if (
            structuredMode() &&
            scroller.scrollTop <= 80 &&
            typeof olderCursor === "string" &&
            olderState === "idle"
          ) {
            loadOlder();
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
    syncComposerClearance();
    return node;
  }

  // Composer clearance: the scroller's bottom padding must always clear
  // the docked composer (never overlap chat output). The composer is
  // user-resizable (textarea up to 40vh) and its note/session rows toggle,
  // so a static pad cannot guarantee it. A ResizeObserver keeps the
  // clearance locked to the live height; attachComposerClearance is
  // idempotent and re-run from render() because the composer node may be
  // created after the lens overlay (both lazily materialize on first use).
  let composerClearObserved = false;
  function composerClearance() {
    const scroller = document.querySelector("#terminalLensScroller");
    if (!scroller) return;
    const composer = document.getElementById("terminalComposer");
    // Hidden composer (Terminal view): fall back to the static pad.
    const pad = composer && !composer.hidden ? composer.offsetHeight + 12 : 120;
    scroller.style.paddingBottom = Math.max(48, pad) + "px";
  }
  function syncComposerClearance() {
    if (composerClearObserved) return;
    const composerNode = document.getElementById("terminalComposer");
    if (!composerNode || typeof ResizeObserver === "undefined") return;
    composerClearObserved = true;
    new ResizeObserver(composerClearance).observe(composerNode);
    composerClearance();
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
    // A user-driven open or close consumes the reopen intent: only the
    // force-off path in onPaneChanged re-arms it (after this clear).
    autoReopenOnChatPane = false;
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
      // Unpause alone leaves the last painted frame on screen: while the
      // lens covered the pane, same-length rewrites (spinner frames, clock
      // redraws) never triggered a repaint because rendering was paused.
      // Force a full repaint so the grid the user returns to matches the
      // PTY state, not the stale pre-lens paint.
      forceTerminalRedraw();
      // Returning to the terminal view must restore typing: the lens
      // scroller held focus while open, so hand it back explicitly.
      if (typeof focusTerminal === "function") {
        try { focusTerminal(true); } catch (_) {}
      }
    }
    // The composer rides with the lens: same surface, same visibility,
    // and it swaps its per-pane draft when the pane changes. The prompt
    // card is the same chat-mode surface: closing the lens hides it now
    // (its own evaluate gate also keeps it hidden on terminal mode).
    if (globalThis.HerdrComposer) globalThis.HerdrComposer.sync();
    if (globalThis.HerdrPromptCards && globalThis.HerdrPromptCards.evaluate)
      globalThis.HerdrPromptCards.evaluate();
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

  // Full repaint of the covered grid after the lens closes. Same
  // adapter lookup as setCoveredRendering: `term` is the shared
  // terminal adapter created by HerdrTerminalRenderer.create, and its
  // forceRedraw() is best-effort (older bundles without renderer
  // access keep the last paint, same as before).
  function forceTerminalRedraw() {
    try {
      const adapter = typeof term !== "undefined" && term ? term : null;
      if (adapter && typeof adapter.forceRedraw === "function")
        adapter.forceRedraw();
    } catch (_) {}
  }

  function onPaneChanged(paneKey) {
    // Called from connectTerminal on every pane/terminal switch: reading
    // state is per-pane. Without the reset, follow/unread and the change
    // detection baseline leaked from the previous pane.
    //
    // BUT connectTerminal also runs on every refresh() poll tick with the
    // SAME pane (core.js re-connects idempotently when the target string
    // is unchanged). Resetting follow there broke the autoscroll
    // disconnect: a reader scrolled up was force-snapped back to the tail
    // by the next poll render, over and over, exactly the bug this change
    // set fixes on the wheel side. So the reset runs only when the pane
    // actually moved: the caller passes the connect target
    // (session|backend|ws|tab|pane|terminal) and a repeat of the current
    // pane's key is a no-op. The first call (no key yet) resets as before.
    if (
      typeof paneKey === "string" &&
      paneKey === lastPaneKey
    ) {
      return;
    }
    lastPaneKey = typeof paneKey === "string" ? paneKey : null;
    follow = true;
    unread = false;
    lastRenderedLineCount = -1;
    // Force-off BEFORE the first render tick on the new pane: a jcode
    // pane's frozen transcript must never flash over an incoming shell
    // pane (round 11 force-off timing). Two ways to know the new pane
    // cannot host the chat view: a positive agent row that fails the
    // gate (null/unsupported agent_session), or a lens that was in
    // structured chat mode (chatPane anchored) landing on a pane with
    // no row at all. connectTerminal fires this after refresh()
    // landed the fresh agents list, so a missing row means the pane
    // has no agent (a split sibling shell), not a not-yet-snapshotted
    // one. Keeping the lens open there left the previous pane's chat
    // view riding the shell onto the agent-less panel. A pane the
    // gate can neither green nor disprove (no row, never anchored:
    // scrollback mode) keeps the old excursion contract: the lens
    // survives the switch.
    if (lensActive && !chatSupported() && (activeAgentRow() || chatPane !== null)) {
      // Structured mode is leaving a chat pane the user never closed:
      // remember to reopen when a chat-capable pane returns. Scrollback
      // force-offs (row-positive) never auto-reopen, nobody opened a
      // chat there. setLens(false) clears the flag, so arm it after.
      const wasStructured = chatPane !== null;
      // The lens closes before the lensActive block below, so the stale
      // pane's session meta must clear here too: the composer must not
      // keep the previous pane's model label over the agent-less pane.
      clearStaleSessionMeta();
      setLens(false);
      autoReopenOnChatPane = wasStructured;
    }
    // The other side of the force-off above: the user left the chat
    // pane open and the excursion closed it, so returning to a
    // chat-capable pane reopens it (their click, not ours, opened it
    // the first time). An explicit Terminal click clears nothing here
    // because the flag was already consumed at the reopen before any
    // close could follow it.
    if (!lensActive && autoReopenOnChatPane && chatSupported()) {
      autoReopenOnChatPane = false;
      setLens(true);
    }
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
    // corner; the terminal surface itself is untouched. The whole pill
    // drags (position persists in options.lensSwitchPos), taps still
    // toggle the view. Visibility per pane is owned by
    // syncSwitchVisibility, called on pane change and after each
    // snapshot.
    let node = document.getElementById("terminalLensSwitch");
    if (node) return;
    const shell = shellElement();
    if (!shell) return;
    node = document.createElement("div");
    node.id = "terminalLensSwitch";
    node.className = "terminal-lens-switch segmented";
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Panel view, drag to move");
    node.innerHTML =
      '<button type="button" id="lensToggleChat" aria-pressed="false" onclick="HerdrLens.toggle()">Chat</button>' +
      '<button type="button" id="lensToggleTerminal" aria-pressed="true" onclick="HerdrLens.toggle()">Terminal</button>';
    shell.appendChild(node);
    applyLensSwitchPos(node);
    wireLensSwitchDrag(node);
    syncSwitchVisibility();
  }

  // ---- switch drag (mobile Keys fab parity) ----

  const LENS_SWITCH_DRAG_THRESHOLD_PX = 4;

  // The switch anchors with top/right; a dragged position switches to
  // left/top in the shell's coordinate space and clears the anchor so
  // the two never fight.
  function applyLensSwitchPos(node) {
    // options/saveOptions live in the desktop bundle scope (core.js);
    // guard so the module still loads where they are absent.
    const pos = typeof options !== "undefined" && options && options.lensSwitchPos;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      node.style.left = "";
      node.style.top = "";
      node.style.right = "";
      return;
    }
    const shell = shellElement();
    const rect = node.getBoundingClientRect();
    if (!shell) return;
    const shellRect = shell.getBoundingClientRect();
    const maxX = shellRect.width - rect.width;
    const maxY = shellRect.height - rect.height;
    node.style.left = `${Math.max(0, Math.min(maxX, pos.x))}px`;
    node.style.top = `${Math.max(0, Math.min(maxY, pos.y))}px`;
    node.style.right = "auto";
  }

  function wireLensSwitchDrag(node) {
    // Document-level move/up listeners (Keys fab pattern on mobile):
    // explicit pointer capture is the lighter alternative, but some
    // embedded/webview runtimes drop it mid-drag, and the drag must keep
    // working when the cursor leaves the pill either way. The armed flag
    // filters the document stream to the active drag only.
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    let maxX = 0;
    let maxY = 0;
    let dragging = false;
    let suppressedClick = false;
    let armed = false;
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || armed) return;
      const shell = shellElement();
      if (!shell) return;
      startX = e.clientX;
      startY = e.clientY;
      const rect = node.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      baseX = rect.left - shellRect.left;
      baseY = rect.top - shellRect.top;
      maxX = shellRect.width - rect.width;
      maxY = shellRect.height - rect.height;
      dragging = false;
      suppressedClick = false;
      armed = true;
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stopDrag);
      document.addEventListener("pointercancel", stopDrag);
    });
    const move = (e) => {
      if (!armed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) < LENS_SWITCH_DRAG_THRESHOLD_PX && Math.abs(dy) < LENS_SWITCH_DRAG_THRESHOLD_PX)
        return;
      if (!dragging) {
        dragging = true;
        suppressedClick = true;
        node.classList.add("dragging");
      }
      node.style.left = `${Math.max(0, Math.min(maxX, baseX + dx))}px`;
      node.style.top = `${Math.max(0, Math.min(maxY, baseY + dy))}px`;
      node.style.right = "auto";
    };
    const stopDrag = () => {
      if (!armed) return;
      armed = false;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stopDrag);
      document.removeEventListener("pointercancel", stopDrag);
      if (dragging) {
        node.classList.remove("dragging");
        dragging = false;
        const rect = node.getBoundingClientRect();
        const shell = shellElement();
        if (shell) {
          const shellRect = shell.getBoundingClientRect();
          if (typeof options !== "undefined" && options)
            options.lensSwitchPos = {
              x: Math.round(rect.left - shellRect.left),
              y: Math.round(rect.top - shellRect.top),
            };
          if (typeof saveOptions === "function") saveOptions();
        }
      }
    };
    // The browser fires click after pointerup even for a real drag;
    // releasing over a button must not flip the view.
    node.addEventListener("click", (e) => {
      if (!suppressedClick) return;
      suppressedClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
    // Double-click resets the pill to its anchored spot: an explicit
    // escape hatch for a position parked somewhere annoying.
    node.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typeof options !== "undefined" && options) options.lensSwitchPos = null;
      if (typeof saveOptions === "function") saveOptions();
      applyLensSwitchPos(node);
    });
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
    loadOlder,
    // Test/diagnostic surface: older-page internals.
    _olderState: () => ({ olderCursor, heldFrom, olderState, olderTurns, olderTruncated }),
    _dropOlderPages: dropOlderPages,
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
    _workingStartedAt: workingStartedAt,
    _resetWorkingState: () => {
      workingExpanded = false;
      stopWorkingTick();
    },
  };
})();
