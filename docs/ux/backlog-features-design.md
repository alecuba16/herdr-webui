# Backlog features design: density toggle, chat lens, prompt cards

Scope decisions and implementation notes for the three deferred backlog items
(`ux-overhaul-plan.md` 3.3, "Optional big items [DECISION]"). User approved the
full sweep on 2026-10-03, plus coverage closure on branch-added code.

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

## Coverage targets ("100% if possible")

Whole-repo 100% is not realistic for a Rust-served webui (main.rs is 7k+
lines of HTTP plumbing). The commitment is: every line this branch added
(terminal_hub.rs, lens.js, prompt_cards.js, density toggle code) is
exercised by unit and/or real-browser e2e tests, measured with:
- Rust: `cargo llvm-cov` on the bin, terminal_hub.rs module coverage closed
  to 100% (test the hub paths; main.rs relay paths covered by the e2e).
- Frontend: the existing vm-based suites cover new modules; new e2e checks
  drive density toggle, lens switch, and prompt cards through the real UI.

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
- **Coverage**: terminal_hub.rs 92.5% regions / 91.9% lines under
  `cargo llvm-cov` (the remainder is the live-socket join/detach path,
  exercised by the multi-viewer e2e's fake herdr server, not unit-reachable).
  Frontend branch-added modules each have a dedicated vm suite.
- Prompt cards also fixed a real backend bug found by the e2e: status
  flips swallowed by the 500ms detection throttle when the pane goes
  silent right after a burst. A pending flag + trailing-edge sweeper
  thread recovers them (regression + burst-stress tests in
  `builtin_backend.rs`).
