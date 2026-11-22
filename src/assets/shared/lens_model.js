// Shared chat-lens conversation model.
//
// desktop/app_js/lens.js and mobile/lens.js kept two copies of the
// conversation-model helpers (tool-run grouping, user-turn collection,
// decision-part lookup, refusal copy, working head markup, older-page
// walking). The two lenses drifted everywhere else (markup, state
// plumbing, escape guards), so this module only owns the helpers that
// verified byte-identical modulo whitespace: pure functions that take
// their inputs as arguments, no closure state. The lenses keep their own
// wrappers with the same names and pass closure values in.
(function (root) {
  // Grouping info for a tool part: runs of consecutive tool/tool_pending
  // parts with the same name render as one block; a later part in the
  // run must not open a second block.
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

  // Set of user text parts in a conversation response; the pending bubble
  // suppresses them from the rendered turns.
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

  // Decision part behind a "turn:part:name" DOM key, or null when the
  // conversation moved on. The name check catches a renumbered turn whose
  // indices now point at a different part.
  function decisionPartFromDom(conversation, key) {
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

  // Human copy for a refusal; `row` is the pane's agent row (or null),
  // whose agent_session.reason pins the specific failure.
  function refusalReasonCopy(row, errorCode) {
    const reason = errorCode || (row && row.agent_session && row.agent_session.reason);
    switch (reason) {
      case "no_session_path":
        return "No jcode conversation found for this panel yet";
      case "ambiguous":
        return "Multiple jcode conversations match this panel; open one in the terminal to disambiguate";
      default:
        return "Conversation unavailable right now";
    }
  }

  function refusalHtml(copy) {
    return `<div class="lens-refusal">${copy}</div>`;
  }

  function loadingHtml() {
    return '<div class="lens-loading">loading chat…</div>';
  }

  // Working-head toggle row. `label` comes from workingHeadLabel().
  function workingHeadHtml(workingExpanded, label, escapeHtml) {
    return (
      `<div class="lens-working-toggle" data-toggle-working="1" tabindex="0" role="button" aria-expanded="${workingExpanded}">` +
      `<span class="lens-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="lens-working-label">${escapeHtml(label)}…</span>` +
      `<span class="lens-working-caret">${workingExpanded ? "▾" : "▸"}</span></div>`
    );
  }

  // Walk older conversation pages backwards from `start` until the
  // already-held cursor; "bounded" when 32 pages are not enough, null on
  // any failure. `fetchPage(paneId, { before })` returns the page.
  async function turnsBetween(fetchPage, paneId, held, start) {
    const pages = [];
    let before = start;
    try {
      for (let step = 0; step < 32 && before !== held; step++) {
        const result = await fetchPage(paneId, { before }, null);
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

  const api = {
    toolRunInfo,
    userTurnTexts,
    decisionPartFromDom,
    refusalReasonCopy,
    refusalHtml,
    loadingHtml,
    workingHeadHtml,
    turnsBetween,
  };
  root.HerdrLensModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);