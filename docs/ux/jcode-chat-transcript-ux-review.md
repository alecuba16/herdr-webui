# UX deep review: jcode chat transcript design (round 11)

Scope: the design doc's UX claims and gaps, checked against the real
lens/composer/TUI implementations and their tests.

## Verified UX facts the design builds on

- [praise] The lens already has the right interaction skeleton: follow /
  unread pill (`New output`) with 2px bottom-stick detection, dirty-flag
  render skipping, pane-switch state reset in `onPaneChanged`, covered
  rendering pause, focus hand-back on close. Structured mode can reuse
  ALL of it — the design correctly keeps this surface.
- [praise] The composer already owns per-pane drafts, pane-switch note
  reset, disabled-during-switch state, and server-owned refusal copy.
- The TUI lens (`src/tui/lens.rs`) is a real port of the same turn
  heuristics with its own tests; `Shortcut::Lens` (Shift+L) exists and is
  the right guard point, as the design says.

## UX gaps in the design (fixed in this round)

1. **[blocking] Loading state is unspecified.** The first `/conversation`
   poll on an active jcode session parses a 12 MiB worst case and always
   takes at least one round trip; the lens shows nothing meanwhile. The
   scrollback lens never has this problem (it reads synchronously from
   the page). Fix: structured mode must show an immediate skeleton /
   "loading chat…" state on lens open until the first poll lands. Added
   to the doc.

2. **[blocking] Rendering jitter / scroll anchoring on re-render.** The
   scrollback lens rewrites `innerHTML` on every change; for structured
   turns that would nuke text selection and reset expansion state
   (collapsed thinking, expanded tool output) every 2s poll. Fix: keyed
   diffing by turn index + content hash, or render-append only (turns
   are append-only; rotation may rewrite the base, so full re-render is
   needed only when the `version` changes). Added to the doc.

3. **[blocking] In-flight tool UX.** The design says "render pending"
   for unmatched tool_use but never defines the visual. The lens
   aesthetic has no spinner/progress element. Fix: in-flight tool renders
   as a muted one-line `running <name>…` entry that resolves into the
   normal tool line on the next poll; never blocks other turns. Added.

4. **[important] `resolvable: false` lens hint vs alt-screen hint
   collision.** The lens already has `#terminalLensAlt` ("An interactive
   app is using this panel") for alt-screen. A jcode pane is ALWAYS
   alt-screen, so on a jcode pane with resolution failure BOTH hints
   could apply. Fix: precedence rule — refusal reason replaces the
   alt-screen hint (the pane is a supported agent whose chat failed to
   resolve; the alt hint is meaningless there). Added to the doc.

5. **[important] Toggle visibility semantics.** The design says hide the
   switch on unsupported panes, but `insertLensSwitch` is created once
   per shell and the lens state is per pane. Switching from a jcode pane
   (lens open) to a shell pane must force the lens closed silently, or
   the shell pane shows a frozen jcode transcript. The design says
   "lens forced off" — now made explicit that force-off happens in
   `onPaneChanged` BEFORE the first render tick, with the scrollback
   fallback not shown.

6. **[important] Polling lifecycle.** "Poll every ~2s while the lens is
   open" needs the full lifecycle: start on lens open (structured mode),
   stop on lens close and pane switch (the old pane's poll must not leak
   onto the new pane), single-flight (no overlapping request when a poll
   is slow), and immediate re-poll after submit success. Added.

7. **[nit] Mobile: no change.** Mobile has no lens/composer surface at
   all (verified: zero references in `src/assets/mobile/`). The design's
   "mobile-specific rendering out of scope" is correct and confirmed.

8. **[nit] `agent_blocked` composer parity.** The submit route refuses
   when the agent waits for a terminal answer (`agent_blocked`, 409).
   The pending-bubble design should mirror that: on 409 agent_blocked do
   NOT show a pending bubble (the text never reached the conversation);
   show the server note only. Added to the pending-bubble lifecycle.

9. **[nit] Empty-turn render.** Zero-turn conversation (validated as a
   legitimate state, round 3) shows an explicit empty state ("No messages
   yet — send one below") instead of a blank column. Added.

10. **[question] Turn-cap UX.** Newest-200 page on a long session: the
    lens is a reading surface with a 400-line cap today; 200 turns
    renders far more DOM than 400 lines of scrollback in the worst case
    (long tool outputs are collapsed, so this is bounded — collapsed
    summaries keep it comparable). No change needed; noted in doc.

## Verdict

The design's server side is complete; this round filled the client-side
state machine gaps (loading, jitter, in-flight, hints, lifecycle, empty,
blocked). All fixes applied to the design doc's section 5 and 6.