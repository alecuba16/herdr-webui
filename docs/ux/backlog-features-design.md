# Backlog features design: density toggle, chat lens, prompt cards, composer

Scope decisions and implementation notes for the deferred backlog items
(`ux-overhaul-plan.md` 3.3, "Optional big items [DECISION]"): the original
three shipped on 2026-10-03; the composer (server-side message submit, parity
with upstream `devswha/herdr-web-ui`) was added after a features audit on the
same branch. User approved the full sweep plus coverage closure on
branch-added code.

## 1. Density toggle (S)

Reference pattern (`research-annotations.md` #6): `[data-density="compact"]`
overrides the type scale and row heights without changing information
architecture.

Decisions:
- Attribute lives on `<html>` (`document.documentElement.dataset.density`),
  set by a new `optDensity` select in the Appearance settings section:
  `default` | `compact`. Stored in the existing options store, applied on
  boot and on change, no reload.
- tokens.css gains a compact override block: smaller `--fs-*` scale (one step
  down), tighter row/control heights, tighter paddings. Terminal font size
  stays untouched (it has its own setting); only chrome UI scales.
- Live application = set attribute + call the existing refit scheduler so the
  terminal grid renegotiates against the new shell box.

## 2. Chat lens over terminal (L)

Reference pattern (`research-annotations.md` "Composer/chat lens"): centered
`--content-w` transcript rendered over the still-attached terminal; switching
lens never creates a second connection.

Decisions:
- **Transcript source**: the live wterm bridge in the page. The adapter
  exposes the underlying core (`getScrollbackCell/getCell`), same source the
  selection-capture uses. NO second WS, no backend transcript API (none
  exists; protocol 22 is frozen).
- **Renderer**: new `src/assets/desktop/app_js/lens.js`, loaded in the
  DESKTOP_JS concat after terminal.js. A segmented control in the panel
  header (Chat | Terminal, mirroring the reference) toggles
  `#terminalLens` overlay over `#terminalShell`. The terminal socket stays
  attached and keeps receiving frames while the lens is visible; the lens
  re-reads the bridge on every refresh tick (cheap: bounded to the visible
  slice) so it stays live.
- **Turn rendering**: user turns (lines starting with the shell prompt
  marker at their start-of-line) render as neutral right-aligned cards;
  everything else is plain left transcript lines. This is a heuristic
  render, not structured data (none exists on protocol 22); it degrades
  gracefully to a plain transcript.
- Auto-follow: lens scrolled to bottom sticks; scrolling up stops follow and
  shows a "New output" pill that resumes on click (reference pattern).
- Mobile: out of scope for the first cut (mobile has its own surface stack);
  lens is desktop-only. Documented as follow-up.

## 3. Prompt cards (L)

Reference pattern: while an agent is blocked, an interactive form of its
question translated to keypresses. The plan said "needs a feasibility spike".

Feasibility findings:
- The backend already detects blocked question dialogs
  (`jcode_question_blocked`, question_dialog line regexes in
  `builtin_backend.rs`) and publishes `pane.agent_status_changed` with
  status `blocked`. The frontend already badges blocked panes.
- No structured prompt payload exists on protocol 22 and we froze the
  protocol, so the card must parse the question from the visible terminal
  text (same bridge source as the lens). This is the spike's answer:
  feasible, heuristic, degrades to a "Show in terminal" link.

Decisions:
- New `src/assets/desktop/app_js/prompt_cards.js` in the DESKTOP_JS concat.
  When the selected pane is `blocked` and the bridge tail matches the
  question-dialog shapes (numbered `❯ 1. ...` options, `↑/↓` navigation
  hint, free-text "enter your response"), render a prompt card overlay
  anchored to the terminal: title = question line, options = clickable
  buttons, plus a free-text input for response-type prompts.
- **Answering** = synthesized keypresses through the same
  `sendInputData` path the terminal uses: option `N` -> `"N\r"` (numbered
  lists), navigation prompts -> the option's index then Enter, free text ->
  typed text + `\r`. No new wire frames.
- Dismiss/escape collapses the card to the existing blocked badge; a
  "Show in terminal" action focuses the raw terminal view.
- The card is derived state only: every status change or terminal frame
  re-evaluates, so a stale card can never send stale input (re-evaluated
  against the current tail before sending).

## 4. Chat composer over terminal (L)

Upstream parity audit (2026-10-03) named the composer the one major missing
feature: upstream herdr-web-ui submits messages SERVER-side through herdr's
`agent.prompt`, so the paste + Enter survives a locked phone or a dropped
connection, and a blocked pane can be refused before anything is typed.

Decisions:
- **Server owns submit authority** (same model as upstream): new builtin
  backend method `agent.prompt` (`pane_id` or `target` alias for herdr wire
  compat) pastes the message as ONE bracketed paste (`\e[200~ ... \e[201~`,
  newlines as CR inside the block), then sends its `\r` after a 300ms gap on
  a detached thread holding only the runtime Arc. The gap is deliberately
  outside jcode's 150ms paste-guard window (`paste_guard.rs`): a trailing
  Enter inside that window is swallowed as paste residue, so the submit would
  silently not happen. Never shorten below ~200ms.
- **Refusals before typing**: `agent_blocked` (the pane waits on a question
  dialog; typing would answer the dialog, never the composer),
  `agent_not_found`, `agent_exited`, `message_too_long` (20000 chars),
  `empty_agent_prompt`. Error strings are `<code>: <message>` so the wire
  code survives both transports.
- **HTTP route**: `POST /api/panes/{id}/submit` with `{text}`. Goes through
  the same ApiClient socket path, so it works for builtin AND external herdr
  backends (passthrough free). Status mapping: blocked 409, gone 404,
  validation 400, else 502; body carries `{error, code}`.
- **Browser never types into the pane**: desktop composer
  (`src/assets/desktop/app_js/composer.js`) rides with the lens surface
  (visible only while the lens is on), keeps per-pane drafts (Map keyed by
  `state.pane`, restored on pane switch), Enter submits / Shift+Enter is a
  newline, over-cap and empty drafts never reach the server. Refusal notes
  land in a `role=status` row and the draft stays in the box.
- **Shared shaping policy** (`src/assets/shared/compose.js`, DOM-free):
  `composerMessage` (trailing-newline strip, CRLF→LF) mirrors the server's
  `composer_message`; `submitNote` maps wire codes to actionable copy;
  `QUEUE_READY_STATUS` is the closed set of statuses a held message could be
  released on (done/idle; working/blocked never).
- Protocol 22 stays frozen: this is a new HTTP route + herdr RPC, not a
  wire-protocol change.

## Coverage targets ("100% if possible")

Whole-repo 100% is not realistic for a Rust-served webui (main.rs is 7k+
lines of HTTP plumbing). The commitment is: every line this branch added
(terminal_hub.rs, lens.js, prompt_cards.js, density toggle code) is
exercised by unit and/or real-browser e2e tests, measured with:
- Rust: `cargo llvm-cov` on the bin, terminal_hub.rs module coverage closed
  to 100% (test the hub paths; main.rs relay paths covered by the e2e).
- Frontend: the existing vm-based suites cover new modules; new e2e checks
  drive density toggle, lens switch, prompt cards, and the composer through
  the real UI.

## Validation plan

Per feature: unit suite (vm harness) + one e2e acceptance path + full
batteries (Rust bin+lib, 25 frontend suites, e2e scripts) before commit.

## Delivered status (measured, not aspirational)

All three features shipped on `ux_improvements`:
- **Density toggle** (`06f9ee4`): vm coverage in app_load.
- **Chat lens** (`73e6902`): 9 vm tests + 11-check real-browser e2e
  (includes zero-socket assertion across toggles).
- **Prompt cards** (`3b2a4ab`, extended in `626c80f`): 13 vm tests
  (parse/answer/stale-guard/dismiss/XSS-escape) + 15-check e2e covering
  option dialogs, free-text prompts, dismissal, and the stale-send guard.
- **Composer** (`ux_improvements`, after the parity audit): 5 Rust tests
  (shaping pair, paste+Enter sequence, blocked refusal, validation) +
  19 vm tests (compose 5, composer 14: drafts, refusals, key handling,
  guards) + 13-check real-browser e2e (echo round-trip through the real
  route, per-pane draft across workspace switches, blocked refusal with
  the draft kept and nothing reaching the pane, lens visibility).
- **Coverage**: terminal_hub.rs 92.5% regions / 91.9% lines under
  `cargo llvm-cov` (the remainder is the live-socket join/detach path,
  exercised by the multi-viewer e2e's fake herdr server, not unit-reachable).
  Frontend branch-added modules each have a dedicated vm suite.
- Prompt cards also fixed a real backend bug found by the e2e: status
  flips swallowed by the 500ms detection throttle when the pane goes
  silent right after a burst. A pending flag + trailing-edge sweeper
  thread recovers them (regression + burst-stress tests in
  `builtin_backend.rs`).
