// Mobile chat lens: the mobile port of the desktop lens (chat mode over
// the terminal). Structured mode only: the terminal view itself is the
// scrollback fallback on a phone, one tap away in the view switch.
//
// The overlay covers the terminal surface; the terminal socket stays
// attached in both views (the desktop lens's core invariant, kept here:
// switching views never reconnects). The Chat|Terminal switch lives at
// the top of the terminal screen and only appears on chat-capable panes
// (a supported agent with a non-null agent_session, same gate as
// desktop chatSupported()).
//
// Poll model (desktop parity): /api/panes/{id}/conversation every 2s
// while the lens is open, ETag 304 short-circuit, append-only DOM sync
// while the response version holds the prefix, pending bubble until the
// poll carries the real user turn, working indicator while the pane's
// agent works, decision chooser while the pane is blocked, load-older
// pages with the cursor above the newest page.
(function () {
  const POLL_MS = 2000;
  const SUPPORTED_CHAT_AGENTS = new Set(["jcode"]);
  const STATUS_EVENT_TTL_MS = 8000;

  function createMobileLens({
    state,
    el,
    api,
    escapeHtml,
    inputAttrs,
    statusClassFn,
    getTerminal,
    sendPaste,
    render: renderApp,
  }) {
    let lensActive = false;
    let follow = true;
    let unread = false;
    // Bounded walk-back (over 32 pages of missed history) dropped held
    // pages; the endcap must say turns were skipped, not claim a
    // beginning the transcript never reached (desktop parity).
    let olderTruncated = false;
    // Connect target of the pane the reading state belongs to, same guard
    // as the desktop: repeat connects on the unchanged pane must not
    // reset follow.
    let lastPaneKey = null;
    // Structured state, all keyed to one pane at a time (desktop parity).
    let chatPane = null;
    let pollTimer = null;
    let pollInFlight = false;
    let pollQueued = false;
    let conversation = null;
    let convError = null;
    let loadingChat = true;
    let pendingBubble = null;
    let olderTurns = [];
    let olderCursor = null;
    let heldFrom = null;
    let olderState = "idle";
    let pollEtag = null;
    let pollUrl = null;
    const expandedTools = new Set();
    const fetchedOutputs = new Map();
    // Freshest per-pane status (event-driven, fresher than the agents row).
    const paneStatusEvents = new Map();
    // Decision answered/collapsed marks, and working-block expansion.
    let decisionAnsweredKey = null;
    let decisionCollapsedKey = null;
    let workingExpanded = false;
    let workingTickTimer = null;

    // ---- helpers ----

    function escapeAttr(value) {
      return escapeHtml(String(value == null ? "" : value)).replace(/'/g, "&#39;");
    }

    function cssEscape(value) {
      if (typeof CSS !== "undefined" && CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_:-]/g, "\\$&");
    }

    function activePaneId() {
      return state && state.pane ? state.pane : null;
    }

    function activeAgentRow() {
      if (!state) return null;
      const id = state.pane;
      if (!id) return null;
      return (state.agents || []).find((a) => a && a.pane_id === id) || null;
    }

    function paneAgentName() {
      const row = activeAgentRow();
      return row ? row.name || row.display_agent || row.agent || row.terminal_id : null;
    }

    function chatSupported() {
      const agent = paneAgentName();
      if (!agent || !SUPPORTED_CHAT_AGENTS.has(agent)) return false;
      const row = activeAgentRow();
      return !!(row && row.agent_session);
    }

    function refusalReasonCopy(errorCode) {
      const row = activeAgentRow();
      const reason = errorCode || (row && row.agent_session && row.agent_session.reason);
      if (reason === "no_session_path")
        return "No jcode conversation found for this panel yet";
      if (reason === "ambiguous")
        return "Multiple jcode conversations match this panel; open one in the terminal to disambiguate";
      return "Conversation unavailable right now";
    }

    // ---- poll loop ----

    function conversationUrl(paneId, params) {
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

    function resetChatState(paneId) {
      chatPane = paneId;
      conversation = null;
      convError = null;
      loadingChat = true;
      pendingBubble = null;
      unread = false;
      dropOlderPages();
      pollEtag = null;
      pollUrl = null;
      expandedTools.clear();
      fetchedOutputs.clear();
      decisionAnsweredKey = null;
      decisionCollapsedKey = null;
      workingExpanded = false;
      stopWorkingTick();
      stopPolling();
    }

    function dropOlderPages() {
      olderTurns = [];
      olderCursor = null;
      heldFrom = null;
      olderState = "idle";
      olderTruncated = false;
    }

    function ensurePolling() {
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

    async function pollConversation() {
      if (!lensActive || !chatSupported()) return stopPolling();
      const paneId = activePaneId();
      if (paneId !== chatPane) resetChatState(paneId);
      if (pollInFlight) {
        pollQueued = true;
        return;
      }
      pollInFlight = true;
      try {
        const params = heldFrom !== null ? { from: heldFrom } : {};
        const url = conversationUrl(paneId, params);
        const etag = pollUrl === url ? pollEtag : null;
        const result = await fetchConversation(paneId, params, etag);
        if (paneId !== chatPane || !lensActive) return;
        if (result.notModified) return;
        const response = result.body;
        pollUrl = url;
        pollEtag = result.etag || null;
        convError = null;
        loadingChat = false;
        conversation = response;
        if (heldFrom === null) olderCursor = response.cursor;
        if (heldFrom !== null && response.cursor && response.cursor !== heldFrom) {
          const moved = await turnsBetween(paneId, heldFrom, response.cursor);
          if (moved === null || moved === "bounded") {
            // The gap cannot be joined (history changed mid-walk) or the
            // walk hit its 32-page bound: drop the held pages and
            // re-anchor on the newest page. A bounded walk marks what
            // was lost: the endcap says turns were skipped instead of
            // hiding the truncation (desktop parity).
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
            // control alive so the reader can page back manually.
            if (bounded && typeof fresh.body.cursor === "string")
              olderCursor = fresh.body.cursor;
          } else if (moved.length) {
            olderTurns = olderTurns.concat(moved);
            heldFrom = response.cursor;
          } else {
            heldFrom = response.cursor;
          }
        } else if (heldFrom !== null && !response.cursor) {
          heldFrom = response.cursor;
        }
        if (pendingBubble && userTurnTexts(response).has(pendingBubble.text)) {
          pendingBubble = null;
        }
        render();
      } catch (error) {
        if (paneId !== chatPane || !lensActive) return;
        const details = error && error.details;
        const code = (details && details.code) || "error";
        if (code === "history_changed" || error.status === 409) {
          dropOlderPages();
          convError = null;
          loadingChat = false;
          pollEtag = null;
          pollUrl = null;
          try {
            const fresh = await fetchConversation(paneId, {}, null);
            if (paneId !== chatPane || !lensActive) return;
            if (!fresh.notModified) {
              conversation = fresh.body;
              pollUrl = conversationUrl(paneId, {});
              pollEtag = fresh.etag || null;
              render();
              return;
            }
          } catch (_) {
            // fall through to the error render
          }
        }
        convError = { code };
        loadingChat = false;
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

    async function loadOlder() {
      const paneId = activePaneId();
      if (!paneId || paneId !== chatPane) return;
      if (olderState === "loading" || typeof olderCursor !== "string") return;
      const before = olderCursor;
      olderState = "loading";
      try {
        const result = await fetchConversation(paneId, { before }, null);
        // The pane changed or the lens closed mid-fetch: the page belongs
        // to a state that no longer exists. Drop it and leave olderState
        // idle, or a same-pane lens reopen would find a dead "loading"
        // flag and never load older turns again.
        if (paneId !== chatPane || !lensActive) {
          olderState = "idle";
          return;
        }
        if (result.notModified) {
          olderState = "failed";
          return;
        }
        const page = result.body;
        if (!page || (page.error && true) || (typeof page.cursor !== "string" && page.cursor !== null)) {
          olderState = "failed";
          return;
        }
        const first = heldFrom === null;
        heldFrom = first ? before : heldFrom;
        olderTurns = (page.turns || []).concat(olderTurns);
        olderCursor = page.cursor;
        olderState = "idle";
        if (first) refreshConversation();
        render();
      } catch (error) {
        if (paneId !== chatPane || !lensActive) {
          olderState = "idle";
          return;
        }
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

    function refreshConversation() {
      if (!lensActive || !chatSupported()) return;
      pollQueued = true;
      if (!pollInFlight) {
        pollQueued = false;
        pollConversation();
      }
    }

    function setPendingBubble(text) {
      if (text === null || text === undefined || text === "") pendingBubble = null;
      else pendingBubble = { text: String(text) };
      if (lensActive && chatSupported()) render();
    }

    // ---- status gates (event cache first, desktop parity) ----

    function onAgentStatusChanged(data) {
      if (!data || !data.pane_id) return;
      paneStatusEvents.set(data.pane_id, {
        status: String(data.agent_status || ""),
        at: Date.now(),
      });
      if (lensActive && data.pane_id === activePaneId()) render();
    }

    function paneStatusNow(name) {
      try {
        if (!state) return false;
        const paneId = state.pane;
        const event = paneId && paneStatusEvents.get(paneId);
        if (event && Date.now() - event.at < STATUS_EVENT_TTL_MS)
          return event.status === name;
        const row = paneId && (state.agents || []).find((a) => a && a.pane_id === paneId);
        if (row && row.agent_status) {
          const status = statusClassFn
            ? statusClassFn(row.agent_status)
            : row.agent_status;
          return status === name;
        }
        const ws = (state.workspaces || []).find((w) => w && w.workspace_id === state.ws);
        if (!ws) return false;
        const status = statusClassFn ? statusClassFn(ws.agent_status) : ws.agent_status;
        return status === name;
      } catch (_) {
        return false;
      }
    }

    function paneBlockedNow() {
      return paneStatusNow("blocked");
    }

    function paneWorkingNow() {
      return paneStatusNow("working");
    }

    // ---- rendering ----

    function partKey(turnIndex, partIndex, part) {
      return `${turnIndex}:${partIndex}:${part && part.name ? String(part.name) : ""}`;
    }

    // Consecutive same-name tool calls form one visual run (desktop
    // parity): the first row keeps the name plus a count, tail rows list
    // their briefs. tool_pending counts as the same call in flight - the
    // kind flips in place at the same part index. Runs are recomputed
    // from the parts array on every render: the same-count DOM sync
    // must reach the identical row form from parts alone, so run
    // membership can never live in mutable state. Any other part kind or
    // a different name breaks the run.
    function toolRunInfo(parts, partIndex) {
      const list = parts || [];
      const part = list[partIndex];
      if (!part || (part.kind !== "tool" && part.kind !== "tool_pending"))
        return null;
      const name = part.name || "";
      let start = partIndex;
      while (start > 0) {
        const prev = list[start - 1];
        if (
          !prev ||
          (prev.kind !== "tool" && prev.kind !== "tool_pending") ||
          (prev.name || "") !== name
        )
          break;
        start--;
      }
      let end = partIndex;
      while (end + 1 < list.length) {
        const next = list[end + 1];
        if (
          !next ||
          (next.kind !== "tool" && next.kind !== "tool_pending") ||
          (next.name || "") !== name
        )
          break;
        end++;
      }
      return { first: start === partIndex, size: end - start + 1 };
    }

    function turnSpanSeconds(turn) {
      if (!turn || !turn.ts) return null;
      const start = Date.parse(String(turn.ts));
      if (!Number.isFinite(start)) return null;
      if (turn.end_ts) {
        const end = Date.parse(String(turn.end_ts));
        if (Number.isFinite(end) && end >= start) return Math.round((end - start) / 1000);
        return null;
      }
      return null;
    }

    function formatDuration(totalSeconds) {
      const seconds = Math.max(0, Math.floor(totalSeconds));
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    }

    function turnDurationHtml(turn) {
      const span = turnSpanSeconds(turn);
      if (span === null || span < 1) return "";
      return `<div class="lens-turn-meta">Worked for ${escapeHtml(formatDuration(span))}</div>`;
    }

    function conversationHtml(response, opts) {
      const opts_ = opts || {};
      const fromTurn = opts_.from || 0;
      const turns = (response && response.turns) || [];
      if (!turns.length) {
        return '<div class="lens-empty">No messages yet: send one below</div>';
      }
      const out = [];
      turns.forEach((turn, turnIndex) => {
        const globalIndex = fromTurn + turnIndex;
        const parts = [];
        (turn.parts || []).forEach((part, partIndex) => {
          parts.push(partHtml(part, globalIndex, partIndex, turn.parts));
        });
        const body = parts.join("");
        const metaHtml = turn.role === "assistant" ? turnDurationHtml(turn) : "";
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
      if (pendingBubble && fromTurn === 0) {
        out.push(
          `<div class="lens-turn lens-turn-user lens-turn-pending"><span>${escapeHtml(pendingBubble.text)}</span></div>`,
        );
      }
      return out.join("");
    }

    function partHtml(part, turnIndex, partIndex, turnParts) {
      if (part.kind === "text") {
        return `<div class="lens-text" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">${escapeHtml(part.text || "")}</div>`;
      }
      if (part.kind === "image") {
        const ref = part.ref || "";
        if (!ref) return "";
        const paneId = activePaneId();
        const src = paneId
          ? `/api/panes/${encodeURIComponent(paneId)}/conversation/image?ref=${encodeURIComponent(ref)}`
          : "";
        const alt = part.media_type ? `pasted ${part.media_type} image` : "pasted image";
        return (
          `<div class="lens-image" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">` +
          `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">` +
          `</div>`
        );
      }
      if (part.kind === "thinking") {
        // Desktop lens parity: reasoning text collapses behind a tappable
        // label (expandedThinking on desktop, expandedTools here). The row
        // carries data-part-key so the same-count DOM sync updates it in
        // place instead of re-appending on every poll.
        const key = partKey(turnIndex, partIndex, part);
        const open = expandedTools.has(key);
        const head =
          `<span class="lens-thinking-toggle" data-toggle-thinking="${escapeAttr(key)}" tabindex="0" role="button" aria-expanded="${open}">${open ? "▾" : "▸"} thinking</span>`;
        const body = open
          ? `<div class="lens-thinking-body">${escapeHtml(part.text || "")}</div>`
          : "";
        return `<div class="lens-thinking" data-part-key="${escapeAttr(key)}">${head}${body}</div>`;
      }
      if (part.kind === "tool_pending") {
        // One "running name…" head per same-name run; tail rows mark
        // the queue depth without repeating the label (desktop parity).
        const run = toolRunInfo(turnParts, partIndex);
        if (run && !run.first)
          return `<div class="lens-tool lens-tool-running lens-tool-run-continuation" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">…</div>`;
        const count = run && run.size > 1 ? ` <span class="lens-tool-count">×${run.size}</span>` : "";
        return `<div class="lens-tool lens-tool-running" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}">running <span class="lens-tool-name">${escapeHtml(part.name || "tool")}</span>${count}…</div>`;
      }
      if (part.kind === "tool") {
        const key = partKey(turnIndex, partIndex, part);
        const open = expandedTools.has(key);
        const label = part.is_error ? "lens-tool-error" : "";
        const run = toolRunInfo(turnParts, partIndex);
        // Run tail rows: the brief IS the row (the command-list look,
        // desktop parity). The row keeps its own toggle carrier so each
        // command still expands its output individually.
        if (run && !run.first && !open) {
          const briefClass = part.is_error
            ? "lens-tool-run-item lens-tool-run-item-error"
            : "lens-tool-run-item";
          return `<div class="lens-tool lens-tool-run-item" data-part-key="${escapeAttr(key)}" data-toggle-tool="${escapeAttr(key)}" tabindex="0" role="button" aria-expanded="false"><span class="${briefClass}">${escapeHtml(part.brief || part.input || "")}</span></div>`;
        }
        const head =
          `<div class="lens-tool-head ${label}" data-toggle-tool="${escapeAttr(key)}" tabindex="0" role="button" aria-expanded="${open}">` +
          `<span class="lens-tool-name">${escapeHtml(part.name || "tool")}</span>` +
          (run && run.size > 1 ? `<span class="lens-tool-count">×${run.size}</span>` : "") +
          `<span class="lens-tool-brief">${escapeHtml(part.brief || "")}</span>` +
          `<span class="lens-tool-caret">${open ? "▾" : "▸"}</span></div>`;
        if (!open)
          return `<div class="lens-tool" data-part-key="${escapeAttr(key)}">${head}</div>`;
        const fetched = fetchedOutputs.get(key);
        if (fetched && fetched.ref === part.output_ref) {
          return (
            `<div class="lens-tool lens-tool-open" data-part-key="${escapeAttr(key)}">${head}` +
            `<pre class="lens-tool-output">${escapeHtml(fetched.output)}</pre></div>`
          );
        }
        const size = part.output_size
          ? `<div class="lens-tool-meta">output trimmed: ${escapeHtml(String(part.output_size))} chars total</div>`
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
        return (
          `<div class="lens-compact" data-part-key="${escapeAttr(partKey(turnIndex, partIndex, part))}"><span class="lens-compact-label">Earlier context compacted</span>` +
          `<div class="lens-compact-summary">${escapeHtml(part.summary || "")}</div></div>`
        );
      }
      if (part.kind === "decision") {
        return decisionHtml(part, turnIndex, partIndex);
      }
      return "";
    }

    function decisionKey(part) {
      return (
        String(part.question || "") +
        "|" +
        (part.options || []).map((o) => (o && o.label) || "").join("|")
      );
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
      let hint;
      if (interactive) hint = '<div class="lens-decision-hint">Pick a number or type your own answer</div>';
      else if (collapsedHere && paneBlockedNow()) hint = '<div class="lens-decision-hint">Waiting for your answer in the terminal</div>';
      else hint = '<div class="lens-decision-hint">Answered: waiting for the agent to continue</div>';
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

    // ---- working indicator ----

    function workingStartedAt() {
      const paneId = state ? state.pane : null;
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

    function runningToolsOfOpenTurn() {
      const turns = (conversation && conversation.turns) || [];
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (!turn) continue;
        if (turn.role !== "assistant") break;
        const names = (turn.parts || [])
          .filter((p) => p && p.kind === "tool_pending")
          .map((p) => p.name || "tool");
        return names;
      }
      return [];
    }

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
        lines.push(`<div class="lens-working-elapsed">Working for ${escapeHtml(formatDuration(elapsed))}</div>`);
      const running = runningToolsOfOpenTurn();
      if (running.length)
        lines.push(
          `<div class="lens-working-tools">${running
            .map((name) => `<span class="lens-working-tool">${escapeHtml(name)}</span>`)
            .join("")}</div>`,
        );
      if (!lines.length)
        lines.push('<div class="lens-working-note">Agent is processing: output appears when the turn completes</div>');
      return lines.join("");
    }

    function syncWorkingDom(content) {
      if (!content) return;
      const show = paneWorkingNow() && !paneBlockedNow();
      let existing = content.querySelector(".lens-working");
      if (!show) {
        if (existing && existing.remove) existing.remove();
        stopWorkingTick();
        return;
      }
      if (!existing) {
        existing = document.createElement("div");
        existing.className = "lens-working";
        content.appendChild(existing);
        existing.innerHTML = `${workingHeadHtml()}${workingExpanded ? `<div class="lens-working-body">${workingBodyLines()}</div>` : ""}`;
      } else {
        // Head keeps node identity (keyboard focus survives); only
        // attributes and text mutate in place.
        const toggle = existing.querySelector("[data-toggle-working]");
        if (toggle) {
          toggle.setAttribute("aria-expanded", workingExpanded ? "true" : "false");
          const label = toggle.querySelector(".lens-working-label");
          if (label) label.textContent = `${workingHeadLabel()}…`;
          const caret = toggle.querySelector(".lens-working-caret");
          if (caret) caret.textContent = workingExpanded ? "▾" : "▸";
        }
        let body = existing.querySelector(".lens-working-body");
        if (!workingExpanded) {
          if (body && body.remove) body.remove();
        } else {
          if (!body) {
            body = document.createElement("div");
            body.className = "lens-working-body";
            existing.appendChild(body);
          }
          body.innerHTML = workingBodyLines();
        }
      }
      const last = content.lastElementChild;
      if (last && last !== existing) content.appendChild(existing);
      if (workingExpanded) ensureWorkingTick();
    }

    function ensureWorkingTick() {
      if (workingTickTimer !== null) return;
      workingTickTimer = setTimeout(function onWorkingTick() {
        workingTickTimer = null;
        if (!lensActive || !workingExpanded || !paneWorkingNow()) return;
        const node = overlay();
        if (!node) return;
        const content = node.querySelector(".mobile-lens-content");
        const block = content && content.querySelector(".lens-working");
        if (!block) return;
        const elapsedLine = block.querySelector(".lens-working-elapsed");
        if (elapsedLine) {
          const startedAt = workingStartedAt();
          if (startedAt) {
            const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
            elapsedLine.textContent = `Working for ${formatDuration(elapsed)}`;
          }
        }
        ensureWorkingTick();
      }, 1000);
    }

    function stopWorkingTick() {
      if (workingTickTimer !== null) {
        clearTimeout(workingTickTimer);
        workingTickTimer = null;
      }
    }

    // ---- overlay + render ----

    function overlay() {
      let node = el("mobileLens");
      if (!node) {
        const shell = el("terminalShell");
        if (!shell) return null;
        node = document.createElement("div");
        node.id = "mobileLens";
        node.className = "mobile-lens";
        node.setAttribute("role", "region");
        node.setAttribute("aria-label", "Chat transcript view of this panel");
        node.innerHTML =
          '<div class="mobile-lens-scroller" id="mobileLensScroller" tabindex="0">' +
          '<div class="mobile-lens-content"></div></div>' +
          '<button type="button" class="mobile-lens-new" id="mobileLensNew" hidden ' +
          'aria-label="Resume following latest output">New output</button>';
        shell.appendChild(node);
        const scroller = node.querySelector("#mobileLensScroller");
        if (scroller) {
          scroller.addEventListener("scroll", () => {
            const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
            if (atBottom) {
              follow = true;
              unread = false;
              const pill = node.querySelector("#mobileLensNew");
              if (pill) pill.hidden = true;
            } else {
              follow = false;
            }
            if (scroller.scrollTop <= 80 && typeof olderCursor === "string" && olderState === "idle") {
              loadOlder();
            }
          });
        }
        const pill = node.querySelector("#mobileLensNew");
        if (pill) {
          pill.onclick = () => {
            follow = true;
            unread = false;
            pill.hidden = true;
            render();
            const scroller2 = node.querySelector("#mobileLensScroller");
            if (scroller2) scroller2.scrollTop = scroller2.scrollHeight;
          };
        }
        node.addEventListener("click", onLensClick);
        node.addEventListener("keydown", onLensKeydown);
        node.addEventListener("submit", onLensSubmit);
      }
      return node;
    }

    function prefixMatches(content, turns, prevTurns) {
      for (let i = 0; i < prevTurns; i++) {
        if (!turns[i] || !content.querySelector(`[data-turn="${i}"]`)) return false;
      }
      return true;
    }

    function syncPendingBubbleDom(content) {
      let existing = content.querySelector(".lens-turn-pending");
      if (pendingBubble) {
        if (!existing) {
          existing = document.createElement("div");
          existing.className = "lens-turn lens-turn-user lens-turn-pending";
          content.appendChild(existing);
        }
        existing.innerHTML = `<span>${escapeHtml(pendingBubble.text)}</span>`;
      } else if (existing && existing.remove) {
        existing.remove();
      }
    }

    function syncMutableParts(content, turns) {
      turns.forEach((turn, turnIndex) => {
        const turnEl = content.querySelector(`[data-turn="${turnIndex}"]`);
        (turn.parts || []).forEach((part, partIndex) => {
          const key = partKey(turnIndex, partIndex, part);
          const row = content.querySelector(`[data-part-key="${cssEscape(key)}"]`);
          if (row) {
            const fresh = partHtml(part, turnIndex, partIndex, turn.parts);
            const probe = document.createElement("div");
            probe.innerHTML = fresh;
            const freshSerialized = probe.firstChild ? probe.firstChild.outerHTML : fresh;
            if (row.outerHTML !== freshSerialized) {
              row.outerHTML = fresh;
            }
            return;
          }
          if (!turnEl) return;
          const at = document.createElement("div");
          at.innerHTML = partHtml(part, turnIndex, partIndex, turn.parts);
          while (at.firstChild) turnEl.appendChild(at.firstChild);
        });
      });
    }

    function olderPagesHeaderHtml() {
      if (!conversation) return "";
      if (typeof olderCursor !== "string") {
        // The endcap only marks a KNOWN beginning: pages were held and
        // walked to the transcript start. A truncated reset with no
        // held pages must say turns were skipped, not claim a beginning
        // (desktop parity).
        if (olderTruncated)
          return '<div class="lens-older-done" data-older-truncated="1">Some earlier messages were skipped to catch up</div>';
        if (!olderTurns.length) return "";
        return '<div class="lens-older-done">Beginning of conversation</div>';
      }
      if (olderState === "loading") return '<button type="button" class="lens-older-load" disabled>Loading…</button>';
      if (olderState === "failed")
        return '<button type="button" class="lens-older-load" data-load-older="1">Retry loading earlier messages</button>';
      const truncatedNote = olderTruncated
        ? '<div class="lens-older-done" data-older-truncated="1">Some earlier messages were skipped to catch up</div>'
        : "";
      return `${truncatedNote}<button type="button" class="lens-older-load" data-load-older="1">Load earlier messages</button>`;
    }

    function loadingHtml() {
      return '<div class="lens-loading">loading chat…</div>';
    }

    function refusalHtml(errorCode) {
      return `<div class="lens-refusal">${escapeHtml(refusalReasonCopy(errorCode))}</div>`;
    }

    function render() {
      const node = overlay();
      if (!node || !lensActive) return;
      const content = node.querySelector(".mobile-lens-content");
      if (!content) return;
      // Captured before the DOM sync so the pill block below can see
      // whether this render added turns (desktop render parity).
      const prevCount = Number(content.dataset.renderedTurns || 0);
      if (loadingChat) {
        content.innerHTML = loadingHtml();
        const scroller = node.querySelector("#mobileLensScroller");
        if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      if (convError) {
        const code = convError.code;
        content.innerHTML =
          code === "no_session_path" || code === "ambiguous"
            ? refusalHtml(code)
            : '<div class="lens-refusal">Conversation unavailable right now</div>';
        const scroller = node.querySelector("#mobileLensScroller");
        if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      if (!conversation) {
        content.innerHTML = loadingHtml();
        return;
      }
      const turns = conversation.turns || [];
      const olderCount = olderTurns.length;
      const prevOlder = Number(content.dataset.renderedOlder || 0);
      const prevTurns = Number(content.dataset.renderedTurns || 0);
      const joinedTurns = olderTurns.concat(turns);
      const olderPrepended = olderCount !== prevOlder;
      const prefixHolds =
        prevTurns > 0 &&
        !olderPrepended &&
        joinedTurns.length >= prevTurns &&
        prefixMatches(content, joinedTurns, prevTurns);
      const scroller0 = node.querySelector("#mobileLensScroller");
      const anchor = scroller0
        ? { top: scroller0.scrollTop, height: scroller0.scrollHeight }
        : null;
      if (prevTurns === 0 || olderPrepended || !prefixHolds) {
        const olderHeader = olderPagesHeaderHtml();
        content.innerHTML =
          (olderHeader
            ? `<div data-older-control="1">${olderHeader}</div>`
            : "") + conversationHtml({ turns: joinedTurns });
        content.dataset.renderedTurns = String(joinedTurns.length);
        content.dataset.renderedOlder = String(olderCount);
        syncPendingBubbleDom(content);
        syncWorkingDom(content);
      } else if (joinedTurns.length !== prevTurns) {
        const bubble = content.querySelector(".lens-turn-pending");
        const at = document.createElement("div");
        at.innerHTML = joinedTurns
          .slice(prevTurns)
          .map((turn, i) => conversationHtml({ turns: [turn] }, { from: prevTurns + i }))
          .join("");
        if (bubble) {
          while (at.firstChild) content.insertBefore(at.firstChild, bubble);
        } else {
          while (at.firstChild) content.appendChild(at.firstChild);
        }
        content.dataset.renderedTurns = String(joinedTurns.length);
        syncMutableParts(content, joinedTurns);
        syncPendingBubbleDom(content);
        syncWorkingDom(content);
      } else {
        syncMutableParts(content, joinedTurns);
        syncPendingBubbleDom(content);
        syncWorkingDom(content);
      }
      const scroller = node.querySelector("#mobileLensScroller");
      if (olderPrepended && anchor && scroller) {
        scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
      } else if (follow && scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      const pill = node.querySelector("#mobileLensNew");
      // New turns while the reader is scrolled up arm the resume pill
      // (desktop parity: !follow && newCount > prevCount). The one
      // mobile addition is !olderPrepended: a load-older render grows
      // the count without any new output and must not arm the pill.
      const newCount = Number(content.dataset.renderedTurns || 0);
      if (!follow && !olderPrepended && newCount > prevCount) unread = true;
      if (pill) pill.hidden = !(unread && !follow);
    }

    function countRenderedTurns() {
      const node = el("mobileLens");
      const content = node && node.querySelector(".mobile-lens-content");
      return content ? Number(content.dataset.renderedTurns || 0) : 0;
    }

    // ---- interactions ----

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

    function decisionAnswer(key, payload) {
      if (!paneBlockedNow()) return;
      const part = decisionPartFromDom(key);
      if (!part) return;
      const identity = decisionKey(part);
      if (decisionAnsweredKey === identity) return;
      if (typeof sendPaste !== "function") return;
      sendPaste(payload);
      decisionAnsweredKey = identity;
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
        if (key) fetchedOutputs.set(key, { ref: reference, output });
        const lensNode = el("mobileLens");
        const current =
          key && lensNode
            ? lensNode.querySelector(`[data-part-key="${cssEscape(key)}"]`)
            : row;
        if (current) {
          const pre = current.querySelector(".lens-tool-output");
          if (pre) pre.textContent = output;
          const meta = current.querySelector(".lens-tool-meta");
          if (meta && meta.remove) meta.remove();
          const liveButton = current.querySelector("[data-fetch-output]");
          if (liveButton && liveButton.remove) liveButton.remove();
          else if (button.remove) button.remove();
        }
      } catch (_) {
        button.disabled = false;
        button.textContent = "Show full output (retry)";
      }
    }

    function onLensClick(event) {
      const target = event && event.target;
      if (!target || !target.closest) return;
      const decisionOption = target.closest("[data-decision-key].lens-decision-option");
      if (decisionOption) {
        const key = decisionOption.getAttribute("data-decision-key");
        const index = Number(decisionOption.getAttribute("data-decision-index"));
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
      const thinkingToggle = target.closest("[data-toggle-thinking]");
      if (thinkingToggle) {
        const key = thinkingToggle.getAttribute("data-toggle-thinking");
        if (expandedTools.has(key)) expandedTools.delete(key);
        else expandedTools.add(key);
        render();
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
        expandToolFullOutput(fetchButton, fetchButton.getAttribute("data-fetch-output"));
        return;
      }
      const olderButton = target.closest("[data-load-older]");
      if (olderButton) {
        loadOlder();
      }
    }

    function onLensKeydown(event) {
      const key = event && event.key;
      if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
      const target = event && event.target;
      if (!target || !target.closest) return;
      const toggle =
        target.closest("[data-toggle-tool]") || target.closest("[data-toggle-thinking]") || target.closest("[data-toggle-working]");
      if (!toggle) return;
      if (target !== toggle) return;
      event.preventDefault();
      onLensClick({ target: toggle });
    }

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
      const payload =
        "\u001b[200~" + text.replace(/[\r\n]+/g, " ") + "\u001b[201~" + "\r";
      decisionAnswer(key, payload);
    }

    // ---- lens open/close ----

    function setLens(active) {
      lensActive = !!active;
      const node = overlay();
      if (!node) return;
      node.hidden = !lensActive;
      const shell = el("terminalShell");
      if (shell) shell.classList.toggle("lens-active", lensActive);
      if (lensActive) {
        follow = true;
        unread = false;
        const paneId = activePaneId();
        if (chatSupported()) {
          if (paneId !== chatPane) resetChatState(paneId);
          ensurePolling();
        }
        render();
      } else {
        stopPolling();
        stopWorkingTick();
        workingExpanded = false;
        pendingBubble = null;
      }
      syncSwitchUi();
      // The prompt card rides the chat-mode gate too (desktop parity):
      // the lens decision chooser owns blocked answering while the chat
      // view is open, so the card must not fight it. The dock hook moves
      // the composer into the lens (open) or back to the keybar (closed);
      // the plain sync then refreshes the textarea state in its new home.
      const deps = globalThis.HerdrMobileComposerDeps;
      if (deps) {
        try {
          if (deps.syncComposerDock) deps.syncComposerDock();
          if (deps.syncComposer) deps.syncComposer();
        } catch (_) {}
      }
    }

    function syncSwitchUi() {
      const chatToggle = el("mobileLensChatToggle");
      if (chatToggle) chatToggle.setAttribute("aria-pressed", lensActive ? "true" : "false");
      const terminalToggle = el("mobileLensTerminalToggle");
      if (terminalToggle)
        terminalToggle.setAttribute("aria-pressed", lensActive ? "false" : "true");
    }

    function renderSwitch() {
      // The segmented control floats over the terminal screen like the
      // Keys fab: the whole pill drags (position persists per layout),
      // the buttons stay taps. Hidden on non-chat panes (renderTerminal
      // in panels.js drops it when chatSupported() is false).
      return (
        `<div class="mobile-lens-switch" id="mobileLensSwitch" role="group" aria-label="Panel view, drag to move" onmousedown="HerdrMobileLens.switchDragStart(event)" ontouchstart="HerdrMobileLens.switchDragStart(event)">` +
        `<button type="button" id="mobileLensChatToggle" aria-pressed="false" onclick="HerdrMobileLens.showChat()">Chat</button>` +
        `<button type="button" id="mobileLensTerminalToggle" aria-pressed="true" onclick="HerdrMobileLens.showTerminal()">Terminal</button>` +
        `</div>`
      );
    }

    // ---- switch drag (Keys fab parity) ----

    // Whole-pill drag: a tap on a button still toggles the view, a move
    // past the threshold repositions the pill. The switch re-renders on
    // every pane sync, so the position lives in localStorage and
    // applySwitchPosition re-reads it after each mount.
    const SWITCH_DRAG_KEY = "herdr-mobile-lens-switch";

    // Position math runs in the container's coordinate space: the pill
    // is absolute inside .mobile-terminal-screen, which starts below the
    // header, so viewport coords (getBoundingClientRect) must be
    // rebased onto the container before they can be written back as
    // style.left/top. Clamping stays inside the container: the pill
    // belongs to the terminal surface and must not park over the header
    // or the nav bar.
    function switchPlacement(node) {
      const container = node.offsetParent;
      const nodeRect = node.getBoundingClientRect();
      if (!container) {
        return { maxX: window.innerWidth - nodeRect.width, maxY: window.innerHeight - nodeRect.height, baseX: 0, baseY: 0 };
      }
      const contRect = container.getBoundingClientRect();
      return {
        maxX: contRect.width - nodeRect.width,
        maxY: contRect.height - nodeRect.height,
        baseX: nodeRect.left - contRect.left,
        baseY: nodeRect.top - contRect.top,
      };
    }

    function writeSwitchPosition(node, x, y) {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.right = "auto";
      // The default centering rides on this transform; an explicit
      // position must not keep shifting the pill by half its width.
      node.style.transform = "none";
    }

    function switchDragStart(event) {
      const node = el("mobileLensSwitch");
      if (!node) return;
      const point = event.touches && event.touches[0] ? event.touches[0] : event;
      const startX = point.clientX;
      const startY = point.clientY;
      const base = switchPlacement(node);
      let moved = false;
      // Desktop fires click after mouseup even for a real drag; releasing
      // over a button must not toggle the view. Same capture-phase
      // suppressor as the sidebar strips (wireSidebarWidthDrag).
      const suppressClick = (clickEvent) => {
        clickEvent.stopImmediatePropagation();
        clickEvent.preventDefault();
      };
      node.addEventListener("click", suppressClick, true);
      const move = (moveEvent) => {
        const p = moveEvent.touches && moveEvent.touches[0] ? moveEvent.touches[0] : moveEvent;
        const dx = p.clientX - startX;
        const dy = p.clientY - startY;
        if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        moved = true;
        node.classList.add("dragging");
        const x = Math.max(0, Math.min(base.maxX, base.baseX + dx));
        const y = Math.max(0, Math.min(base.maxY, base.baseY + dy));
        writeSwitchPosition(node, x, y);
        moveEvent.preventDefault();
      };
      const end = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", end);
        document.removeEventListener("touchmove", move);
        document.removeEventListener("touchend", end);
        node.classList.remove("dragging");
        if (moved) {
          saveSwitchPosition(node);
          // Drop the suppressor after the trailing click: one drag, one
          // swallowed click, then taps work again.
          setTimeout(() => node.removeEventListener("click", suppressClick, true), 0);
        } else {
          node.removeEventListener("click", suppressClick, true);
        }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
      document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("touchend", end);
      // No preventDefault on the start event: on touch it would swallow
      // the synthetic click, and the buttons ARE taps (Chat/Terminal).
      // The move handler prevents default once the drag threshold passes,
      // which is also what stops text selection mid-drag.
    }

    function saveSwitchPosition(node) {
      const container = node.offsetParent;
      if (!container) return;
      // Clamp at save time: the drag arms its placement math once at
      // pointerdown, so a container that shrank mid-drag (rotation,
      // keyboard) would otherwise persist an out-of-bounds spot and park
      // the pill outside; the mid-drag observer skip means nothing else
      // re-clamps until the next resize.
      const placement = switchPlacement(node);
      const x = Math.max(0, Math.min(placement.maxX, placement.baseX));
      const y = Math.max(0, Math.min(placement.maxY, placement.baseY));
      if (x !== placement.baseX || y !== placement.baseY) writeSwitchPosition(node, x, y);
      try {
        localStorage.setItem(SWITCH_DRAG_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
      } catch (_) {}
    }

    // Called after every mount of the switch: restores the saved
    // position or clears inline offsets so a fresh default position is
    // not fought by stale styles from the previous render. A live drag
    // owns the pill; the drag class keeps this out of the way until
    // release.
    function applySwitchPosition() {
      const node = el("mobileLensSwitch");
      if (!node) return;
      if (node.classList.contains("dragging")) return;
      let pos = null;
      try {
        const raw = localStorage.getItem(SWITCH_DRAG_KEY);
        if (raw) pos = JSON.parse(raw);
      } catch (_) {}
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
        node.style.left = "";
        node.style.top = "";
        node.style.right = "";
        node.style.transform = "";
        return;
      }
      const base = switchPlacement(node);
      writeSwitchPosition(
        node,
        Math.max(0, Math.min(base.maxX, pos.x)),
        Math.max(0, Math.min(base.maxY, pos.y)),
      );
    }

    function syncSwitchVisibility() {
      const node = el("mobileLensSwitch");
      if (!node) return;
      node.hidden = !chatSupported();
    }

    // The pill parks in the terminal screen, and that screen resizes
    // under it: the soft keyboard hides the header/nav (body class), the
    // keybar folds, and the app rotates. Clamping at drag time is not
    // enough, a spot saved with the keyboard open can sit past the
    // closed-screen edge. One observer on the container re-applies the
    // saved position (clamped to the fresh bounds) whenever it resizes;
    // applySwitchPosition skips while a drag owns the pill.
    let switchContainerObserver = null;
    let observedSwitchContainer = null;

    function observeSwitchContainer() {
      const node = el("mobileLensSwitch");
      const container = node ? node.offsetParent : null;
      if (observedSwitchContainer === container) return;
      if (switchContainerObserver && switchContainerObserver.disconnect)
        switchContainerObserver.disconnect();
      switchContainerObserver = null;
      observedSwitchContainer = null;
      if (!container || typeof ResizeObserver !== "function") return;
      switchContainerObserver = new ResizeObserver(() => applySwitchPosition());
      switchContainerObserver.observe(container);
      observedSwitchContainer = container;
    }

    function onPaneChanged(paneKey) {
      if (typeof paneKey === "string" && paneKey === lastPaneKey) return;
      lastPaneKey = typeof paneKey === "string" ? paneKey : null;
      follow = true;
      unread = false;
      // Force-off before the first render on the new pane: an agent-less
      // pane must never keep the previous pane's chat open.
      if (lensActive && !chatSupported() && (activeAgentRow() || chatPane !== null)) {
        setLens(false);
      }
      if (lensActive) {
        const paneId = activePaneId();
        if (chatSupported() && paneId !== chatPane) resetChatState(paneId);
        render();
        ensurePolling();
      }
      syncSwitchVisibility();
    }

    function isActive() {
      return lensActive;
    }

    function toggle() {
      setLens(!lensActive);
    }

    function showChat() {
      setLens(true);
    }

    function showTerminal() {
      setLens(false);
    }

    return {
      toggle,
      setLens,
      showChat,
      showTerminal,
      isActive,
      render,
      renderSwitch,
      switchDragStart,
      applySwitchPosition,
      observeSwitchContainer,
      syncSwitchUi,
      syncSwitchVisibility,
      onPaneChanged,
      onAgentStatusChanged,
      refreshConversation,
      setPendingBubble,
      loadOlder,
      // Test/diagnostic surface.
      chatSupported,
      paneBlockedNow,
      paneWorkingNow,
      decisionHtml,
      workingBlockHtml: () =>
        `${workingHeadHtml()}${workingExpanded ? `<div class="lens-working-body">${workingBodyLines()}</div>` : ""}`,
      formatDuration,
      _state: () => ({
        lensActive,
        chatPane,
        olderCursor,
        heldFrom,
        olderState,
        olderTurns,
        pendingBubble,
        conversation,
        convError,
        loadingChat,
      }),
      _resetDecisionState: () => {
        decisionAnsweredKey = null;
        decisionCollapsedKey = null;
      },
      _resetWorkingState: () => {
        workingExpanded = false;
        stopWorkingTick();
      },
    };
  }

  globalThis.HerdrMobileLensModule = { create: createMobileLens };
})();