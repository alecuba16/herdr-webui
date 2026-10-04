# Design review: docs/ux/jcode-chat-transcript-design.md

Reviewer: code-review-excellence pass, 2026-10-04.
Scope: the jcode chat-transcript design doc (no implementation exists yet;
only this doc + throwaway validation prototypes in ~/.jcode/scratch).

## Summary — what was reviewed

The design that ports the reference herdr-web-ui chat model to jcode:
snapshot+journal read model, pane→session resolution, HTTP route, lens
modes, toggle gating. Reviewed for correctness of claims, internal
consistency, completeness against the repo it must integrate with, and
residual risks for the implementation phase.

## Strengths — done well

- [praise] The read-model correction (snapshot base + journal delta) is
  the load-bearing insight of this doc, and it is root-caused in jcode
  source (`MAX_SESSION_JOURNAL_BYTES`, `checkpoint_snapshot`) with live
  rotation evidence, not inferred. A journal-only reader would have
  silently lost history in production.
- [praise] Resolution honesty: the ambiguity finding (3 sessions sharing
  one daemon pid + one cwd) is exactly the failure a naive
  implementation would hit; the status==Active filter + pane-text
  tiebreak follow the reference's evidenced-match rule.
- [praise] Performance requirements are measured, not assumed: cold
  build 596 ms vs 17 ms stat sweep, with a hard MUST-cache requirement
  written down before anyone writes code.
- [praise] Safety section keeps the blast radius small: read-only store,
  frozen protocol, additive snapshot fields (additivity was verified
  against actual parsers, not assumed).

## Required Changes — [blocking]

1. **`agent_session` shape is under-specified for gating (section 6).**
   The doc says pane_json gains "a real agent_session value" but never
   pins the schema. The frontend and TUI both need the SAME three facts:
   provider kind, resolution status, and (for the lens hint) refusal
   reason. Fix: one line in section 4 or 6 defining the wire shape, e.g.
   `agent_session: null | { kind: "jcode", resolvable: bool, reason?: "no_session_path" | "ambiguous" }`.
   Without it, the two clients will invent two shapes.

2. **Section 3 self-contradicts section 1 on compaction rendering.**
   Section 3 says "turns before covers_up_to_turn stay in the log, so no
   turn dropping is needed server-side (folding is a render choice)" —
   but earlier in the same section compaction is rendered as a `compact`
   summary part. Those are two different renderings of one state; pick
   one and state where it happens (server part vs client fold). Also
   note the live store showed compaction entries with ZERO message
   records, so the "turns before covers stay in the log" premise is not
   universally true — the parser must tolerate compaction being the only
   record (the doc itself proves this in section 8, so the claim in
   section 3 should be softened).

3. **Cursor paging spec (section 3, last paragraph) is stale.** It still
   describes a byte-offset cursor "in the chain" over journal lines —
   written before the round-2 read-model correction. After rotation the
   chain is (snapshot, journal) with the journal being deleted and
   recreated; a byte offset into the journal alone cannot name a stable
   position, and the 409-on-generation-change semantics need to cover
   BOTH file identities. Rewrite the paging paragraph against the
   corrected read model: cursor = (snapshot generation, journal
   generation, turn index or message id), or drop byte cursors and page
   by message id (jcode message ids are globally unique — validated:
   `message_<ts>_<nonce>`), which is simpler and rotation-proof.

## Suggestions — [suggestion]/[nit]

- [suggestion] Section 2's step-2 status filter: jcode statuses are
  `Active` | `Closed` | `Crashed { message }` (a struct). The doc should
  specify serde handling: match the string form `Active` exactly and
  treat any map/object-shaped status as non-Active. In Rust, model it as
  an enum with `#[serde(untagged)]` or match on the raw Value.
- [suggestion] Section 5's optimistic pending bubble: define its
  lifecycle (what removes it — next successful poll showing the message
  id? submit failure? pane switch?) or it will leak visually.
- [nit] Section 8's finding headers are out of order ("Third finding of
  the same round" appears before "Second finding of the round"). Rename
  to finding 1 / 2 / 3 in chronological order for readability.
- [nit] Section 9 claims bak names are `session_X.journal.bak` — the
  actual store has zero such files (journal baks would only exist after
  a journal is hard-linked before delete; none observed). The glob-safety
  conclusion still holds, but the naming claim should be corrected to
  what was verified: all 2,385 baks are `session_X.bak` snapshot baks.
- [question] Section 4: should the route also accept `?before=` paging
  from day one, or ship newest-page-only first and add paging when a
  long-session renders slowly? Measured: 12 MiB worst snapshot parses in
  34 ms, so newest-page-only with turn cap 200 may be enough for v1.
- [question] The resolution gate uses the OSC-9/argv `jcode` label. Is
  that stable for jcode running under `jj`/wrapper shells where argv
  detection misses and OSC 9 has not fired yet (first seconds of a
  pane)? Fallback: attempt resolution whenever the pane cwd has ANY
  Active jcode session, gated by successful resolution only.

## Verdict — Comment only → findings APPLIED (2026-10-04, same day)

No implementation exists to approve or block. The design is
evidence-backed and the two round-2 corrections were real bugs caught
before code.

**Status of this review's findings — all applied to the design doc
(same session):**

- Required 1 (agent_session schema): pinned in section 6 —
  `null | {kind, resolvable: true, session_id} | {kind, resolvable:
  false, reason}`; one shape for webui + TUI; TUI field-reading added.
- Required 2 (compaction rendering): reconciled in section 3 — server
  emits `compact` part, no server-side turn dropping, client folds
  nothing; compact-only/zero-message tolerance stated and test-covered.
- Required 3 (cursor spec): section 3 now ships newest-page-only v1
  (cursor: null, forward-compatible); future paging = message-id cursor
  with dual generation invalidation; byte offsets rejected (rotation).
- Suggestion (status serde): section 2 — raw `serde_json::Value`, exact
  string `"Active"` only, objects = non-Active.
- Suggestion (pending bubble lifecycle): section 5 — removed on matching
  poll text, submit failure, pane change or lens close; one per pane.
- Suggestion (OSC-9 gate fallback): section 2 — attempt resolution when
  pane cwd has any Active jcode session; switch lights only on success.
- Nit (finding order): section 8 headers renamed Finding 1 / Finding 2.
- Nit (bak naming): section 9 corrected — all 2,385 baks are
  `session_X.bak` snapshot baks; glob-safety conclusion unchanged.
- Question (paging v1): resolved as newest-page-only (see Required 3).
- Question (OSC-9 first-seconds): resolved as cwd fallback (see above).

The design doc is now the single source of truth for implementation
order: parser + resolution + route with Rust tests first, then lens
structured mode, then toggle gating.