# Design system

The human-readable mirror of `src/assets/shared/tokens.css` and
`src/assets/shared/primitives.css`. The two must not drift: when a value changes
here, change it there in the same commit. Layout base tokens (`--bg`, `--fg`,
`--panel`, `--panel2`, `--border`, `--border2`, `--muted`, `--accent`,
`--accent-fg`) stay owned by each layout's base CSS (desktop `base.css`, mobile
`app.css`) with their dark default and `body.light` override; everything shared
lives in the shared files.

## Rules

1. Component rules reference tokens, never raw hex values.
2. One chrome color: the accent is selection, focus, cursor, and the user's
   primary action. Status colors never double as chrome.
3. Status is always a written label; color is never the only signal.
4. Tonal depth: resting surfaces separate by tone + hairline; shadows are for
   overlays (`--shadow-pop/drawer/card`).
5. Motion only for state changes; endless pulses use `steps(2, jump-none)` so
   they cost about one frame a second.
6. `prefers-reduced-motion` kills pulses and transitions; state stays legible.

## Color

### Status (dark / light)

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--status-idle` | `#a6e3a1` | `#13661b` | agent idle |
| `--status-working` | `#f9e2af` | `#6f4a04` | agent running |
| `--status-blocked` | `#f38ba8` | `#a81c1c` | agent needs input |
| `--status-done` | `#89b4fa` | `#2150ae` | turn finished |
| `--status-unknown` | `var(--muted)` | same | unknown state, dashed edge |

Each has a `-tint` variant (same hue, `color-mix` 86% transparent) for badge
backgrounds.

### Danger and warn (dark / light)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--danger` | `#f38ba8` | `#a61b1b` | destructive borders/text |
| `--danger-tint` | mix | mix | destructive hover backgrounds |
| `--danger-hover` | `#ffccd5` | `#7a1212` | danger text on `--danger-bg` |
| `--danger-bg` | `#3b2028` | `#f3d9dc` | danger button fill |
| `--danger-bg-hover` | `#5a2734` | `#e5c0c5` | danger button hover |
| `--warn` | `#f9e2af` | `#8a4708` | reversible-but-loud |
| `--warn-hover` | `#56401b` | `#f2e3c2` | warn hover background |

### Git aliases

`--git-modified/added/deleted/changed/conflict` alias the per-layout
`--git-*-color` tokens (with fallbacks) so shared components can use one name.

## Spacing, radii, type

- Spacing: `--space-1..8` = 4/8/12/16/20/24/32px (4px base).
- Radii: `--radius-sm/md/lg/xl/pill` = 6/8/12/16/999px.
- Type: `--fs-2xs..xl` = 11/12/13/14/16/18px, `--fs-input: 16px` (no iOS zoom),
  weights 400/500/600/700, `--tracking-caps: 0.06em`.

## Control sizing

| Token | Value | Use |
|---|---|---|
| `--control-h` | 34px | buttons and icon buttons (fine pointer) |
| `--touch-target` | 44px | coarse-pointer minimum (our existing mobile audit target) |
| `--chip-h` | 20px | badge height |
| `--rail-w` | 3px | selected-row rail (planned) |

## Focus and layers

- `--ring: 2px solid var(--accent)`, `--ring-offset: 2px`; a global
  `:focus-visible` outline uses them.
- `--focus-ring` keeps the legacy box-shadow ring shape for controls that
  cannot switch to outline yet.
- Layers: `--z-popover 10`, `--z-scrim 15`, `--z-drawer 20`, `--z-modal 30`,
  `--z-banner 40`, `--z-alert-card 1400` (transient top-of-world surfaces
  like the attention alert card; above desktop modals and mobile sheets).

## Terminal palette

The wterm ANSI palette lives in tokens as `--term-*` custom properties
(`--term-black` ... `--term-bright-white`, Catppuccin dark default,
`body.light` overrides). `HerdrAppHelpers.readTerminalThemeTokens()` reads
them via `getComputedStyle` (normalizing `rgb()` to `#rrggbb`) and desktop
`terminalTheme()` plus the mobile terminal `themeFn` merge the result
over the legacy JS tables, which remain as fallback where computed styles
are unavailable (tests). Background/foreground/cursor/selection still come
from the user-customizable `options.themeColors` (mobile reads them through
`HerdrAppHelpers.terminalThemeColors()`), so per-user theme picking
keeps working on top of the shared ANSI palette.

Propagation: every theme change (manual toggle, settings select, or a
`prefers-color-scheme` switch in auto mode) re-pushes the resolved theme
into every open renderer surface. Desktop `applyTheme()` re-themes the
main terminal and fans out to all temporary-terminal sessions through the
shared manager; mobile routes the same through the theme module's
`applyThemeToBody` hook. The wterm adapter delegates full palettes to the
bundle's `setThemeColors` (24-bit ints) so painted rows repaint instead of
keeping stale colors, and mirrors `selectionBackground` as
`--term-selection-bg` (the variable wterm.css actually reads).

## Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | hover/active/toggle |
| `--dur-base` | 180ms | drawer and future standard transitions |
| `--dur-pulse` | 1600ms | working/reconnecting dots |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | finite transitions |
| `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | reserved |
| `--ease-pulse` | `steps(2, jump-none)` | endless dots (one frame a second) |

## Primitives (primitives.css)

- `.badge` + `.idle/.working/.blocked/.done/.unknown`: uppercase written label
  on a tint. Working carries a breathing dot before the word; the word never
  pulses. Unknown: dim text + dashed border.
- `.btn` family: neutral (default), `.btn-primary`/`.primary`, `.btn-danger`/
  `.danger`, `.warn`, `.btn-ghost`, `.btn-sm`. Legacy `.mini`, `.git-ui-btn`,
  `.git-ui-btn.primary/.danger`, `.mini.active`, `.mini.danger/.warn` are
  aliases: same declarations, no markup churn.
- `.icon-button` (+ `.is-outlined`): square, transparent, mandatory
  `aria-label` in markup.
- `.kbd`: 18px mono keycap with a strong bottom edge.
- `.segmented`: track + quiet options; `[aria-pressed="true"]` or `.active`
  takes the accent.
- Hover lift (`translateY(-1px)`) and hover fills only apply under
  `@media (hover: hover)`; `:active` resets. Coarse pointers grow `.btn` to
  `--touch-target` and `.icon-button` to the square target.
- All primitives drop transitions and the pulse under
  `prefers-reduced-motion: reduce`.

## Mobile patterns

- **Bottom-sheet modals** (`modals.css`, `<=640px`): desktop modal markup
  keeps one implementation; the phone override pins it to the bottom edge
  with `--radius-xl` top corners, safe-area padding, drag handle on the
  `h2::before`, and an upward shadow. Scrim tap closes (settings modal has
  the pointerdown guard). Mobile-native sheets (`.mobile-sheet`, z 91)
  remain for file browser action sheets.
- **Terminal key bar** (`.mobile-keybar`): Esc/Tab/one-shot Ctrl/arrows/^C
  above the terminal shell. Bytes go through `sendInputData` (strip helpers
  intact); every button uses `onmousedown preventDefault` so wterm's
  textarea keeps focus. Ctrl arms via `aria-pressed` on the key plus a
  module-level flag (source of truth), disarms after any key send and on
  screen leave. Hides with header/nav while the OS keyboard is open
  (`body.mobile-keyboard-open`).
- **Drawer navigation** (`.mobile-drawer`, z 92/93): secondary screens
  (Agents/Panels/Worktrees/Files/Git/Sessions/Settings) slide from the left
  over a scrim; 24px edge swipe opens, 56px left swipe closes, scrim tap
  closes. Home/Search/Terminal stay fixed in the bottom nav; deep links via
  `showScreen` keep working.
- **Header meta row** (`.mobile-context-meta`): status text + connection
  dot (events-WS state via `onEventState`) + backend pill;
  `<=480px` sheds the text label and shrinks the pill.

## Accessibility contract

Enforced by the `a11y audit contract` suite in `app_load.test.mjs`:

- Every icon-only button carries `aria-label` (header toggles, modal
  closes, tab close, mobile header). Glyph bodies are `aria-hidden` spans.
- Dialogs: `role="dialog"` + `aria-modal="true"` (settings via
  `aria-labelledby`, search palette via `aria-label`), Escape closes,
  scrim closes, focus is trapped (existing tab handler).
- Live regions: connection chips and the mobile meta row are
  `role="status"`/`aria-live="polite"`; paste progress already carries
  `aria-live="polite"`.
- Selected desktop tab exposes `aria-current="page"`.
- Toggles expose `aria-pressed` (theme toggle, key-bar Ctrl, segmented
  controls).
- Contrast: WCAG AA measured in `theme_contrast.test.mjs` on every actual
  backing surface, resolving `var(--status-*)` light tokens from
  tokens.css.
- Motion: the global `prefers-reduced-motion` block in `tokens.css` kills
  every transition/animation on both layouts (per-component blocks remain
  as belt-and-braces).

## Debt / accepted gaps

- `.mini` keeps a `margin-left: 4px` from its old inline usage; new markup
  should set spacing with `--space-*` utilities instead.
- The duplicate light-theme status overrides in mobile `app.css` were removed
  in favor of the shared `body.light` block in tokens.css.
- Per-layout base palettes still differ slightly (desktop vs mobile accent
  handling); unifying them is Phase 1 follow-up, not blocking.
