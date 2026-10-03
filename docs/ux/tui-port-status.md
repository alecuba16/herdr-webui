# TUI port of the WebUI ux_improvements features

Temporary tracking board for porting the `ux_improvements` features to the
ratatui TUI. Status flips as the work lands; the finished record folds into
`docs/features.md` (Terminal UI section) and `docs/tui-parity-plan.md`, then
this file is deleted.

## Scope

Webui features that are terminal-surface UX (all three shipped on
`ux_improvements` for the browser):

| Feature | Webui module | Status | Plan |
| --- | --- | --- | --- |
| Chat lens (transcript view) | `lens.js` (73e6902) | todo | P1 |
| Chat composer (server submit) | `composer.js` (9a7abc2, SOLID 3a29edd) | todo | P2 |
| Prompt cards (blocked answers) | `prompt_cards.js` (3b2a4ab, 626c80f, 9c745a2) | todo | P3 |

Out of scope for the TUI (browser concerns, no TUI counterpart):
density toggle, a11y attributes, mobile drawer/header, stall banner
(socket-level), multi-viewer replay, lens scroller CSS. Documented in
the final docs pass, not ported.

## Shared decisions

- The TUI already keeps `pane_tail` (ANSI-stripped last 240 lines of the
  selected pane) refreshed by `refresh_tail()` on every navigation and
  refresh tick. That is the TUI's transcript source, the same role the
  live wterm bridge plays for the webui lens and prompt cards. No new
  wire protocol frames; protocol 22 stays frozen.
- The composer goes through the existing HTTP route
  `POST /api/panes/{pane_id}/submit` (server owns validation, error
  classification, and refusal copy). The TUI's `WebApiClient` already
  handles login/401/cookies, so the TUI reuses it; refusal notes come
  from the server's `{error, code, note}` body.
- Keybindings stay in the Ctrl+B prefix namespace like every other TUI
  parity feature:
  - `Ctrl+B L` toggles the chat lens overlay (webui: Chat/Terminal
    segmented switch).
  - `Ctrl+B m` opens the composer input prompt (webui: composer box
    under the lens; the lens is not required, the pane is).
  - Prompt cards render automatically when the selected pane's
    agent_status is `blocked` and the tail parses as a question
    (webui: automatic card). Dismissed per question episode, `Esc`
    collapses, answering or episode change re-arms.
- Each feature lands as its own commit with `cargo test` green and
  the TUI parity e2e module extended.

## P1 — Chat lens (todo)

- `src/tui/lens.rs`: `LensState { active, follow, unread, scroll }` +
  `transcript_lines(&[String]) -> Vec<LensLine>` shaping port of the
  webui heuristics: a line matching the prompt markers (`❯`, `›`, `➜`,
  `$ `) is a user turn (accent-colored), consecutive blank lines fold
  to one gap, everything else is plain output.
- Rendering: centered overlay over the dimmed terminal screen, j/k or
  arrows scroll up/down, follow re-arms when scrolled to the bottom,
  `Ctrl+B L` again or `Esc` closes.
- Refresh: re-reads `pane_tail` on every `refresh_tail()` completion
  (the tail already refreshes on interval and navigation).

## P2 — Composer (todo)

- `PromptKind::Composer` input (existing modal prompt infrastructure,
  `needs_confirm() == false`), per-pane draft map on `TuiApp`
  (`composer_drafts: HashMap<String, String>`) keyed by pane id.
- Enter submits: shape the text (strip trailing newlines, CRLF to LF,
  `MAX_COMPOSER_CHARS = 20000` early out) then
  `WebApiClient::submit_pane(pane_id, text)`.
- Success clears the draft; failure shows the server `note` in the
  status line and keeps the draft.
- `WebApiClient::submit_pane` added next to the existing endpoints,
  reusing `request_json` (login/401 handled there).
- `Ctrl+B m` while the lens is open or not; the pane context is the
  selected pane.

## P3 — Prompt cards (todo)

- `src/tui/prompt_cards.rs`: `parse_prompt(&[String]) -> Option<PromptCard>`
  port of the webui parser (numbered option blocks, ↑↓ nav hint, esc
  cancel, free-text "enter your response" question shapes, question
  title extraction), gated on the selected pane's `agent_status ==
  "blocked"`.
- Overlay: title, numbered option rows (j/k select, Enter answers), or
  free-text input; `Esc` dismisses for this episode; the card re-arms
  on a fresh blocked transition.
- Answering synthesizes the answer through the composer submit path
  (server-side `agent.prompt`), not raw terminal keystrokes: a blocked
  agent's question is exactly what `agent_blocked` refusals protect.
  Free-text answers type the text + Enter through the submit route;
  numbered options submit the option number.
- Stale-send guard: re-parse the tail before sending (webui invariant);
  if the dialog changed, do nothing.

## P4 — e2e (todo)

- `src/tui_parity_e2e_tests.rs`: real axum server + `WebApiClient`:
  composer submit round-trip against a builtin backend pane
  (`cat`-echo style), refusal path against a blocked pane (agent
  answers land, blocked refusal carries the server note).

## P5 — Docs (todo)

- `docs/features.md` Terminal UI section per feature; `help_rows()`
  entries; fold this board into the permanent docs and delete it.

## Validation battery (every commit)

`cargo test` (lib + bin + e2e module), `cargo clippy --all-targets`,
`cargo fmt --check`.
