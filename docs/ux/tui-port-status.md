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
| Chat lens (transcript view) | `lens.js` (73e6902) | done | P1 |
| Chat composer (server submit) | `composer.js` (9a7abc2, SOLID 3a29edd) | done | P2 |
| Prompt cards (blocked answers) | `prompt_cards.js` (3b2a4ab, 626c80f, 9c745a2) | done | P3 |

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

## P1 — Chat lens (done)

- `src/tui/lens.rs`: `LensState { active, follow, unread, scroll_up }` +
  `transcript_lines()` shaping (prompt-marker user turns, gap folding,
  wrapped-input degradation) + `visible_window()` tail-anchored
  viewport with over-scroll clamp to the first viewport (the clamp
  lives in the helper so a stale scroll offset after a transcript
  shrink can never blank the view; found by the unit test).
- `Ctrl+B Shift+L` toggles over the Terminal screen only; Esc/q/i
  close; j/k/arrows/PgUp/PgDn scroll; G/End jump back to the tail and
  re-arm follow. Footer context `Lens` with hint rows; `refresh_tail`
  and `set_pane_tail_from_styled_lines` feed `observe_len` so unread
  tracks new output while scrolled up (the webui "New output" pill
  is the lens meta line + footer hint here).
- Rendering: centered `Chat · {agent}` overlay over the dimmed
  terminal screen (same `overlay_panel`/shadow as the other floats),
  user turns accent-bold with the ❯ marker, meta line shows
  `lines · following/scrolled` or the unread resume hint.
- Tests: 9 unit (marker/shaping/gap/wrap/state/scroll/window) + 4 TUI
  integration (prefix toggle, other-screen ignore, unread flow,
  render shaping + meta).

## P2 — Composer (done)

Landed as committed work; details kept short since the board folds into
features.md at P5.

- `PromptKind::ComposerMessage` (title "Send a message"), per-pane draft
  map `composer_drafts: HashMap<String, String>` on `TuiApp`, synced on
  every keystroke (`sync_composer_draft`).
- Enter submits via `WebApiClient::submit_pane(pane_id, text)` →
  `POST /api/panes/{id}/submit` (existing server route, no protocol
  change; server owns shaping/validation/copy).
- Success clears the draft + `refresh_tail`; refusal shows the server
  `note` verbatim in the status line and keeps the draft
  (`WebApiError::HttpDetailed` reads `{error, code, note}` bodies).
- `Ctrl+B Shift+C` opens the composer prefilled with the stored draft
  (plain `c` stays git commit). Key gated to the Terminal screen.
- 5 TUI integration tests with a fake composer server (ok / blocked /
  note-copy fidelity / draft prefill / empty-message early out).

## P3 — Prompt cards (done)

- `src/tui/prompt_cards.rs`: `parse_prompt(&[String]) -> Option<PromptCard>`
  port of the webui parser (last-contiguous numbered option block,
  ↑↓ nav hint, esc cancel, free-text "enter your response" shapes,
  3-pass `question_title`), verified against the JS run under node
  (`parity_with_webui_oracle`); `PromptCardState` (dismissal identity,
  blocked-episode re-arm, tail signature, `stale_guard`, `mark_answered`).
- `evaluate_prompt_card()` runs from both tail setters AND the
  `refresh_tail` error/no-pane arms, so a status flip collapses the
  card on the very next tick even when the tail read fails.
- Overlay: bottom-right floating card over the terminal pane (webui
  CSS anchor `right:0; bottom:12px`), NOT a centered modal and no
  backdrop dim; head = question title, body = option rows with a
  j/k cursor (❯ marker, webui button hover counterpart) or the
  free-text hint, foot = key hints. Render gated to Terminal screen +
  Navigate mode; open modals dim/cover it like the webui card slides
  under modals.
- Keys (card visible, Terminal, Navigate): j/k/arrows move the cursor
  (options kind only), Enter answers the highlighted option, 1-9
  jump AND answer like a webui button click, Esc dismisses for this
  question episode, plain q falls through to quit (never stolen);
  non-card keys fall through to navigation.
- Free-text cards: Enter opens `PromptKind::CardAnswer` (title
  "Answer the question", subject = the question) — a separate kind,
  NOT the composer draft, so drafts stay untouched.
- Hybrid answer transport (user decision): numbered options always
  go through raw `send_input` (`N\r`, webui sendInputData parity);
  free text picks by the pane's status at ANSWER time — composer
  submit (`submit_pane`) when unblocked, raw `text\r` when blocked.
  The composer route is never used for blocked dialog answers (the
  server refuses `agent_blocked` by design). `stale_guard` is pure
  dialog freshness (re-parse + title match, webui parity) and only
  gates the raw path.
- Footer context `PromptCard` with full/compact hints; help row
  `prompt card` in `help_rows()`.
- Tests: 14 unit (parser shapes, title passes, state lifecycle,
  stale guard, hybrid routing helper, webui oracle parity) + 8 TUI
  integration (evaluate/hide, key routing + q-quit regression,
  other-screen/attach gating, stale guard + dead-socket error path,
  free-text CardAnswer flow, unblocked composer route with the fake
  server, render gating).

## P4 — e2e (done)

- `src/tui_parity_e2e_tests.rs`
  `tui_composer_submit_round_trips_and_refuses_when_blocked`: real axum
  server + builtin backend + real PTY against the TUI's
  `WebApiClient::submit_pane`. Echo-script pane proves the round trip
  (message lands in the pane tail); the script's second line prints a
  Claurst-style dialog that the real detector + status sweeper must
  catch, then the submit must refuse with the exact 409
  `{error, code, note}` copy. Env redirect (`XDG_CONFIG_HOME`) lives
  inside the `spawn_blocking` closure under the shared env lock, with a
  Drop guard restoring it.
- Two latent flakes surfaced by the new load, both fixed in code:
  the double-throttled `publish_agent_status_if_changed` (detection
  always deferred to the sweeper; test now uses
  `publish_agent_status_if_changed_force` to run synchronously) and the
  lost no-prompt guard in `handle_prompt_key` (Enter with no prompt
  panicked; guard restored at the top).

## P5 — Docs (todo)

- `docs/features.md` Terminal UI section per feature; `help_rows()`
  entries; fold this board into the permanent docs and delete it.

## Validation battery (every commit)

`cargo test` (lib + bin + e2e module), `cargo clippy --all-targets`,
`cargo fmt --check`.
