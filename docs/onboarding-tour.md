# Onboarding tour

A guided walkthrough that walks a first-time user through the main UI
areas, explains what each one does, shows the shortcut chord that
reaches it, and runs the real action so the interface moves through its
own states while the user watches. Both surfaces ship the same story in
the same order, so a user who learns the desktop can sit at the TUI and
recognize every step.

The tour exists because the UI is prefix-driven: most power lives
behind `Ctrl+B` chords and a new user has no way to discover them
without reading docs. The tour teaches the chord language in place,
with the live UI as the prop.

## When it starts

| Surface | First run | Replay |
| --- | --- | --- |
| WebUI | auto-starts ~600ms after boot when no prior record exists | Help modal, "Replay the tour" button |
| TUI | no auto-start (auto-start is a webui localStorage behavior; the TUI has no persisted first-run store) | Help overlay, `T` key |
| Mobile | auto-starts ~600ms after boot when no prior record exists | Settings, Tour group, "Replay the onboarding tour" button |

The WebUI tour is desktop-only: the steps ship in the desktop bundle
(`app_js/`), and the mobile bundle ships its own tour (`mobile/tour.js` +
`mobile/tour_steps.js`). The TUI covers terminal users.

Persistence: WebUI `localStorage` key `herdr-web-tour-done`, mobile
`localStorage` key `herdr-mobile-tour-done`. Each holds `done` when the
last step is reached, `skipped` after an early exit. Both values suppress
the auto-start; only the explicit replay paths start it again. The
`reset()` export clears the key. The TUI has no persisted first-run store.

## The steps (both surfaces, same order)

1. **Search palette** - one palette reaches workspaces, worktrees,
   files, folder names, file contents, and every app action. Demo opens
   the palette. Chord: `Ctrl+B /`.
2. **Workspaces** - every open root and linked worktree. Demo moves the
   selection to the next workspace. Chord: `Ctrl+B j`.
3. **Agents** - status per agent with color badges. Demo jumps between
   agents. Chord: `Ctrl+B a`.
4. **Panels / main screen** - one view per flat panel, labels riding
   the rail above the panes; split panes carry one merged header per
   member. WebUI demo creates a terminal tab; TUI demo switches to
   the files screen. Chord: `Ctrl+B f` (TUI) / `Ctrl+B P` (WebUI new
   panel).
5. **Terminal** - paste, scrollback, links. WebUI demo focuses the
   terminal; TUI demo returns to the terminal screen. Chord: `Ctrl+B t`.
6. **Workspace views / sidebar collapse** - WebUI walks the right rail
   (files, git, search, notes); TUI collapses the sidebar column.
   Chord: `Ctrl+B Shift+V` (WebUI right rail) / `Ctrl+B Shift+B`
   (TUI sidebar).
7. **Help overlay** - the full shortcut reference with a type-to-filter
   box. No demo (opening help over the tour card would hide it; the
   card explains the `?` chord instead). Chord: `Ctrl+B ?`.
8. **The prefix language** - `Ctrl+B` arms the prefix, the next key
   runs a shortcut instead of reaching the terminal, `Esc` cancels. No
   chord; this step is the concept the other seven use.

## Chords are resolved from the shortcut maps

Every chord label comes from the configured shortcut map at render

time, so remapping a key in Settings changes the WebUI tour text with
no code edits. Stale hardcoded chords were the main maintainability
risk of a tour feature; this design removes it on the WebUI.

- WebUI: `tour_steps.js` stores chord *intent* (`["webuiShortcuts",
  "search"]`), and `chordLabel()` resolves it through
  `shortcutMapFor`/`globalShortcutPrefixLabel` from `core.js`. Remap a
  shortcut in Settings and the tour card follows.
- TUI: each step stores a `Shortcut` enum value and renders through
  `shortcut_key_hint()` behind `Ctrl+B`. The TUI prefix and key table
  are code constants (`src/tui/keys.rs`), so a keys.rs change must
  update `shortcut_key_hint()` in `src/tui/tour.rs` in the same commit;
  the tour tests catch title/order drift, not chord drift.

## Demos run the real dispatch

Demo actions never duplicate behavior. Each demo calls the same
function a real keypress would call (`openSearchPalette`,
`selectRelativeWorkspace`, `run_shortcut(Shortcut::Search)`, ...), so a
regression in the real action shows up in the tour too, and any
behavior change automatically stays in sync.

Demo-opened surfaces (the search palette) stay open under the tour card
while their step is active, then the next step or the tour close drops
them, matching the WebUI `hideOnDemo` behavior.

## WebUI implementation

| File | Role |
| --- | --- |
| `src/assets/desktop/app_js/tour_steps.js` | Step table: target selector, title, body, chord intent, demo closure, `showWhen` guard. Exports `window.HerdrTourSteps`. |
| `src/assets/desktop/app_js/tour.js` | Driver: spotlight (clip-path polygon hole), card placement, capture-phase keydown, `localStorage` persistence, stop cleanup. Exports `window.HerdrOnboardingTour`. |
| `src/assets/desktop/tour.css` | Spotlight, card, kbd chips, reduced-motion support. Served at `/assets/desktop/tour.css`. |
| `src/assets/tour.test.mjs` | vm-harness tests (FakeElement fake DOM). |
| `src/assets.rs`, `src/main.rs` | Concat + route wiring. |
| `shortcuts.js`, `core.js`, `bindings.js` | `handleGlobalShortcut` guard while tour active, Help modal replay button, first-run auto-start. |

Key behavior: keys are captured in the capture phase before the
terminal or the prefix system can see them; ArrowRight/Enter/Space
advance, ArrowLeft goes back, Esc quits. `handleGlobalShortcut` also
checks the tour first, so ordering stays safe either way.

## TUI implementation

| File | Role |
| --- | --- |
| `src/tui/tour.rs` | `TourRegion`, `TourStep`, `tour_steps()` table, `TuiApp::{open_tour, close_tour, run_tour_demo, handle_tour_key, tour_step}`, `render_tour` (accent border + bottom card). |
| `src/tui/tour/tests.rs` | 6 tests: first step + demo, forward/back with demo side effects, finish at the last step, no key leakage, Esc close + Help replay, step order parity with the WebUI. |
| `src/tui/model.rs`, `src/tui/mod.rs`, `src/tui/keys.rs`, `src/tui/render/mod.rs` | `TuiMode::Tour`, `tour_index`/`tour_finished`/`tour_demo_overlay` fields, mode dispatch, footer hints, render wiring. |
Key behavior: the tour owns every key while open (`j`/Right/Enter
next, `k`/Left back, Esc/q/`?` close); nothing leaks into navigation or
the panes below. The step's demo surface (search palette) renders
below the card because the TUI has a single exclusive mode: the demo
records the overlay it opened, the tour takes the mode back for keys
and render order, and closing the tour still unwinds the overlay stack
to the pre-tour context.

## Mobile implementation

| File | Role |
| --- | --- |
| `src/assets/mobile/tour_steps.js` | Step table: target selector, title, body, demo closure, `showWhen` guard. Targets the mobile shell (nav bar, header title). Exports `HerdrMobileTourSteps`. |
| `src/assets/mobile/tour.js` | Driver: spotlight cutout, bottom card, keyboard (Esc/Enter/Arrows) as a secondary path, `localStorage` persistence, stop cleanup. Exports `HerdrMobileTour`. |
| `src/assets/mobile/tour.css` | Spotlight, card, buttons at the 44px touch standard, reduced-motion support. Served at `/assets/mobile/tour.css`. |
| `src/assets/mobile_tour.test.mjs` | vm-harness tests (fake DOM), mirroring the desktop tour suite. |
| `src/assets/mobile/settings.js` | Settings "Tour" group with the replay button (`HerdrMobile.replayTour()`). |
| `src/assets/mobile/app.js` | Boot auto-start after `connectEvents` (600ms, suppressed when the persisted flag exists). |
| `src/assets.rs`, `src/main.rs`, `src/assets/app_boot.js` | Asset constants, routes, and mobile bundle wiring. |

Key behavior: touch-first. Back/Next buttons drive the steps; keyboard
(Esc/Enter/Arrows) works as a secondary path. Demos call the real
`HerdrMobile` functions (`showScreen`, `openWorkspacesSheet`,
`openDrawer`, `closeSearch`), and `stop()` closes the surfaces the demos
opened. The mobile step list follows the desktop story for the nav
screens (search, workspaces, home, terminal, git, files, more), then
walks every More drawer screen with its own step (agents, panels,
worktrees, sessions, notes, settings, each spotlighting the drawer
item), and closes with the replay hint: 14 steps total. Drawer item
buttons carry `data-screen` in `mobile/screens.js` so the tour targets
stay queryable and drift-guarded.

## Step parity table

| # | Region | Chord | Demo |
| --- | --- | --- | --- |
| 1 | search palette | `Ctrl+B /` | open palette |
| 2 | workspaces | `Ctrl+B j` | move selection |
| 3 | agents | `Ctrl+B a` | jump agent |
| 4 | main screen / panels | `Ctrl+B f` (TUI) / `Ctrl+B P` (WebUI) | open files screen (TUI), new tab (WebUI) |
| 5 | terminal | `Ctrl+B t` | return to terminal screen / focus terminal |
| 6 | sidebar | `Ctrl+B Shift+B` (TUI) / `Ctrl+B Shift+V` (WebUI) | collapse sidebar (TUI) / walk right rail (WebUI) |
| 7 | help | `Ctrl+B ?` | none |
| 8 | footer | none | none |

## Maintenance rules

- Adding a step: add the entry in every `tour_steps` table, same
  position, same story. Keep the WebUI order as the source of truth
  (the TUI test asserts the parity; the mobile table maps the same
  story onto mobile targets).
- Chord labels: never hardcode a key string. Store the shortcut
  identity and resolve it through the configured map. The mobile tour
  names no chords: every action has a button or a tap instead.
- Demos: call the real action function. If a demo opens an overlay,
  the TUI needs the `tour_demo_overlay` record (see `run_tour_demo`);
  the WebUI needs `hideOnDemo: true` so the spotlight repaints; the
  mobile driver repaints after every demo and closes opened
  sheets/drawers in `stop()`.
- Tests: `src/assets/tour.test.mjs` (WebUI), `src/assets/mobile_tour.test.mjs`
  (mobile), and `src/tui/tour/tests.rs` (TUI) must all cover step order
  and demo side effects.