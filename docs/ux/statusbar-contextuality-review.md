# TUI statusbar contextuality review

Goal: the statusbar hint must answer "what can I do **here**, now?" — the
lazygit/k9s/helix standard. lazygit drives hints from a **focus context**
(a stack: side panels, main views, popups/modals), and any input-capture
modal (prompt, find bar, menu) takes over the key handling entirely, so it
must take over the hint line too.

## Current state

`render_footer` selects the hint from `(mode, screen)` only:

- mode: Navigate / Attach / Help / ConfirmQuit / Settings
- screen: Terminal / Files / Git

The app has far more focus state that changes which keys do what:

| Focus context | Keys change? | Hint reflects it? |
|---|---|---|
| Git Changes view | J/K/H hunk cursor, / diff search | No (one hint for all 7 git views) |
| Git Log view | Space mark, c compare, t/R/b tag/reset/rebase | No |
| Git Branches view | c create branch, D delete branch | No |
| Git Stash view | D drop stash, Enter show diff | No |
| Git History/Conflicts/Cleanup | various | No |
| Files edit mode | typing, Ctrl-S save, Ctrl-R reload, Esc stop | No |
| Files filter bar (`/`) | typing, Enter/Esc | No |
| Files content-search results | j/k, Enter jump, A/X toggles | No |
| Editor find bar (Ctrl+F) | typing, Enter next, Esc close | No |
| Editor replace (Ctrl+H) | typing, Enter replace, ! all | No |
| Commit message input | typing, Enter commit, Esc cancel | No |
| Modal prompts (rename/delete/etc.) | typing, Enter, Esc | No |
| Sidebar focused vs main | Tab vs j/k | No (except label change) |
| Quit overlay | y/n/Esc | Yes |

## Gaps found

1. **Git screen is one bucket.** All 7 git views share
   ` Tab view · s stage · d discard · c commit · P push · Ctrl+B ? help `.
   The single most important per-view action (J/K/H in Changes, Space/c in
   Log, D in Branches/Stash) is invisible until you read the help overlay.
2. **Files edit mode is silent.** `e` starts editing, but nothing says
   Ctrl-S saves or Esc stops. A first-time user can only discover it from
   the help overlay. lazygit shows `ctrl-s save · esc cancel` the moment
   a modal opens.
3. **Input-capture bars don't take over the hint.** While the filter bar,
   editor find/replace, commit input, or a modal prompt is open, j/k or
   Enter still display "move selection / attach" — misleading, since
   those keys now type. k9s and helix swap the whole status line to the
   capture context.
4. **Sidebar focus is invisible.** The webui has explicit sidebar vs main
   focus (Ctrl+B . / ,). The TUI label shows the screen, not who has
   focus, and the hint stays identical.
5. **Help tail invariant preserved.** The `Ctrl+B ? help` tail must stay
   in every hint (v0.4.46 fit_hint machinery already handles narrow
   widths; new hints just flow through it).

## Fix plan (this PR)

Introduce a `footer_hint()` on `TuiApp` that resolves the **focused
context** in priority order, mirroring lazygit's context stack:

1. `ConfirmQuit` overlay
2. Active input capture (prompt input > commit input > editor find/replace
   > content search > filter bar) — typing contexts win; hint shows
   Enter/Esc semantics only
3. `Help` / `Settings` overlays
4. Screen + sub-view: git view (7 variants), files edit vs browse,
   attach terminal
5. Navigate fallback

Rules kept from v0.4.46: every hint keeps the `Ctrl+B ? help` tail (input
captures show `Enter ✓ · Esc ✗` style semantics; they keep the tail too),
compact/fit trims on narrow widths, status message keeps 8 columns.

## Sources (how the good TUIs do it)

- **lazygit**: context stack (SIDE/MAIN/POPUP contexts), popups take over
  key dispatch and the bottom line becomes the popup's own options.
- **k9s**: statusbar is a single contextual line per resource view;
  menus/modes replace the whole line, plus a persistent "status" message
  area separate from hints.
- **helix**: mode line (NORMAL/INSERT/SELECT) left, file info right;
  which-key-style menus appear when a chord is pending — the chord hint
  ("Ctrl+B>" in herdr) matches this pattern.

Note: helix's which-key chord display and lazygit's bottom-line-only
hints are two ends of a spectrum; herdr already has the chord state in
`Ctrl+B>` prefix display, so the main gap to close is per-view hints and
input-capture takeover.