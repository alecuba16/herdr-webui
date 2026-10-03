# UX research annotations: herdr-webui vs herdr-web-ui (reference)

Deep research notes comparing our WebUI (`src/assets`, Catppuccin-flavored vanilla JS/CSS
shell served by Rust) against the reference project
<https://github.com/devswha/herdr-web-ui> (React + Bun + xterm.js).
Purpose: feed the overhaul plan (`docs/ux/ux-overhaul-plan.md`) with concrete, file-backed
observations instead of opinions. Both projects control the same herdr backends, so most
reference patterns port conceptually even when the stack differs.

## 1. Stacks at a glance

| Layer | Ours | Reference |
|---|---|---|
| Frontend | Vanilla JS modules, no framework, strings of HTML in JS | React 18 components, one CSS file per component |
| Terminal renderer | wterm (`@wterm/dom` + `@wterm/ghostty` GhosttyCore WASM VT), rendered in 12ms time-slices | `@xterm/xterm` 5.5.0 (locally patched) + addons: fit, unicode-graphemes, web-links |
| Terminal transport | Own JSON protocol over `/ws/terminal?terminal_id=...` (`AttachTerminal { terminal_id, takeover }` in `src/protocol.rs`) | Real `herdr terminal attach <id>` process on a PTY, raw bytes over Bun WebSocket |
| PTY | `portable-pty 0.9` embedded in the Rust server | `@lydell/node-pty` 1.1.0 in a Node sidecar (`server/pty/pty-host.mjs`); node-pty panics inside Bun (oven-sh/bun#18546) so the PTY lives in Node |
| Styling | ~5.3k lines CSS across desktop/mobile/shared, tokens duplicated per layout | ~1.2k lines shell `styles.css` + per-component CSS; single `:root` token block, DESIGN.md mirrors it |
| Design language | Catppuccin Mocha/Frappe palette (`--bg: #11111b`, `--accent: #89b4fa`) | Own system: "amber-phosphor on lamp-lit graphite", 3 opt-in palettes (amber default, report, charcoal) |
| Icons | Inline SVG files in `src/assets/icons/` used via CSS masks | `lucide-react` icon components |
| Fonts | JetBrainsMono Nerd Font Mono bundled | Pretendard Variable (UI), Symbols Nerd Font Mono (terminal) |
| Docs | `docs/*.md` feature docs, `docs/ux-flow-proposal.md` | `DESIGN.md`: 529-line design system spec mirroring every token |

## 2. Terminal connection (reference deep dive)

The reference's terminal stack is instructive even if we keep wterm:

- **One live PTY per pane, shared by every client watching that pane** (`server/index.ts`,
  `PaneAttachment`). We spawn per connection; sharing avoids N attaches against herdr's
  single attach slot.
- **Replay buffer**: bounded tail so a client joining late still sees the current screen.
  Our late joiners wait for the next render frame.
- **Explicit backpressure protocol**: sidecar stdin gets `{"t":"p","paused":bool}` so
  browser acknowledgements stop PTY reads while keeping Ctrl+C input live. Server closes
  clients with a dedicated close code when the buffered amount exceeds budget. Our
  wterm writes in 12ms time-slices but our server never pauses the PTY.
- **Held-attach retries**: when another web bridge holds herdr's one attach slot, the
  server waits, and re-attaches when released; after a live handoff it re-looks-up which
  terminal now owns the pane. Our reconnect backoff exists client-side only
  (`terminal.js` `scheduleTerminalReconnect`).
- **Mirror fallback** (`server/mirror.ts`): when attach is impossible, the server repaints
  `pane.read` snapshots on the pane's own grid instead of failing.
- **Client wrapper** (`src/lib/ws.ts` `HerdrSocket`): terminal input is NEVER queued while
  disconnected, a dropped draft is kept for review; roles (`interact`/`observe`) survive
  reconnects; submit acks with timeouts. We queue input and flush on reconnect
  (`flushInputQueue` in `terminal.js`), which can replay a command into a dead session.
- **xterm config**: `scrollback: 0`, herdr owns scrollback via alternate-screen mouse
  reports; Unicode grapheme widths provided by a custom provider; wheel events collapsed to
  one report per event with replay suppression.

## 3. Design system (reference)

Key transferable ideas, all backed by `DESIGN.md` + `src/styles.css`:

1. **One chrome color.** Amber is the only chrome accent (selection, focus, cursor,
   user's primary action). Agent states (idle/working/blocked/done) carry the other
   saturated colors, always tinted + labeled, never chrome amber. Ours uses accent blue
   for everything including status counts; states and chrome compete.
2. **Token discipline.** Every color/size/space/motion is a `:root` token; component CSS
   only consumes tokens. DESIGN.md mirrors the token block and both must not drift. Ours
   has tokens but also many raw hex values in CSS (`#f38ba8` etc. inline in
   `controls.css`, `app.css`).
3. **Semantic status tokens with tints**: `--status-working/-blocked/-done` plus
   `*-tint` variants for badge backgrounds. Labels are always written out (a11y: color is
   never the only signal). Unknown state = dim text + dashed edge, not a fifth color.
4. **Typography scale** as tokens: `--fs-2xs..--fs-xl` (11–18px), `--fs-input: 16px`
   (the one size iOS Safari does not zoom on focus), weight and tracking tokens.
5. **4px spacing base** with 8 tokens; radii scale 6/8/12/16/999; sizing tokens for
   header height, control height, touch target (40px), row height, chip height.
6. **Density setting**: `[data-density="compact"]` overrides type scale and row heights
   without changing information architecture.
7. **Motion rules**: only state changes move; `--dur-fast 120ms`, `--dur-base 180ms`;
   pulse animation uses `steps(2, jump-none)` so a working dot does not force 60fps
   repaints; dialogs snap (no enter/exit animation); `prefers-reduced-motion` honored
   globally.
8. **Depth strategy**: "tonal shift + hairline, with shadow reserved for overlays".
   Resting surfaces have no shadow; only popover/modal/drawer shadows + one card shadow
   (the composer input).
9. **Focus**: global `:focus-visible` with `--ring: 2px solid var(--accent)` + offset.
10. **Primitive classes**: `.btn` (neutral/primary/danger/ghost), `.icon-button`
    (mandatory `aria-label`), `.segmented`, `.pill`, `.badge`, `.kbd`, `.modal`,
    `.menu`, `.field`. Coarse pointers grow controls to `--touch-target` via
    `@media (pointer: coarse)`.

## 4. Component/functionality patterns worth porting

- **Header**: context title (agent mark + pane title over workspace + cwd), segmented
  Chat/Terminal lens switch, connection chip (dot + written state, pulsing when
  reconnecting), meta actions. At `<=480px` labels shed in priority order.
- **Sidebar roster**: two-line pane rows (mark, editable title / status chip + place),
  amber 3px selection rail, numbered foldable workspace headers, drag reorder with
  keyboard equivalent (Alt+arrows), arm-then-confirm close (3s window), directory-title
  collapsing (a title that is a cwd shows its last folder).
- **Badges**: READY/RUN/INPUT/DONE text badges with tinted bg; RUN has a breathing dot
  before the word, word never fades.
- **Command palette**: `Mod+Shift+K`, searches panes AND actions, `.kbd` hints, recent
  panes on empty query. Ours searches workspaces/files/folders/content only
  (`docs/ux-flow-proposal.md` P2 already wants actions).
- **Composer/chat lens**: centered `--content-w` transcript over the still-attached
  terminal surface (no second connection when switching lens); user turns as neutral
  right-aligned cards; auto-follow stops on scroll-up, "New messages" pill.
- **Prompt cards**: while an agent is blocked, an interactive form of its question
  (options, multi-select, custom input) translated to keypresses. Big functionality gap
  in ours.
- **Mobile key bar**: Esc, Tab, one-shot Ctrl, arrows, `^C`; never steals terminal
  focus. Ours has keyboard-open handling but no dedicated key bar.
- **In-app alert ("droplet")**: pane needing input / turn finished drops a card from the
  top; one at a time; safe-area aware; reduced-motion fade fallback. Ours has
  `attention.js` counters but no equivalent visual.
- **Mobile drawer with edge swipe** (24px edge open, 56px travel close), scrim,
  safe-area insets, focus removed from tab order when closed.
- **Modal = bottom sheet at `<=640px`** with safe-area padding.
- **Breakpoints**: 768px (sidebar drawer), 640px (bottom sheet), 480px (label
  shedding), plus `pointer: coarse` for touch targets. Ours has one 760px layout split
  plus scattered rules.
- **Accessibility contract**: WCAG 2.2 AA target; `aria-label` on icon buttons,
  `aria-pressed` on toggles, `aria-current` on selected pane, `role="status"`/`alert`,
  state always labeled, accepted-debt table. Ours has some aria attributes (`app.html`
  header buttons) but no systematic contract.

## 5. Our current state (verified)

- Tokens exist but scattered: `base.css` body block (desktop), duplicated block in
  `mobile/app.css` (200+ lines of near-copy), `colors.css` only holds 9 lines of
  search/content tokens. Palette is Catppuccin with raw hexes in many rules.
- Buttons: three button families with separate styling (`btn`, `mini`, `git-ui-btn`,
  `mobile-btn`) sharing hover-lift (`translateY(-1px)`) and focus-ring conventions, but
  no unified variant system (primary/danger/ghost is ad hoc: `.mini.danger` hardcodes
  `#5a2734`, `.mobile-btn.danger` hardcodes `#f38ba8`).
- Desktop shell: sidebar (330px) + toggle + main with tabs, project dashboard,
  terminal shell; sidebar header has theme/shortcuts/settings/actions buttons.
- Mobile shell: header + screen + horizontal scrolling bottom nav (Home/Search/Terminal/
  More + status chip), `mobile-more-grid` 2-col cards; 44px min touch targets already.
- `docs/ux-flow-proposal.md` already diagnoses tool-first navigation, dense worktree
  flows, passive empty states; parts are implemented (nav simplification, project
  dashboard exists in `app.html`).
- Terminal UX has solid mechanics (paste chunking with progress bar, follow/tail
  button, links, resize fitting) but is visually utilitarian (loading text "Loading
  panel", plain buttons).
- No density, palette, or motion settings. Light theme exists (hardcoded light token
  blocks).

## 6. Gaps summary (feeds plan)

1. No unified design-token layer; mobile/desktop duplicate token blocks; raw hexes leak
   into component rules.
2. Four+ button families, inconsistent variants, no ghost/icon-button primitive.
3. Status colors double as chrome; no tinted badge system with written labels.
4. No connection state chip, no working/reconnecting pulse language.
5. No command-palette actions, no `.kbd` shortcut hints inline.
6. No prompt cards / chat lens / composer over terminal.
7. No mobile key bar, no edge-swipe drawer, no bottom-sheet modals, no droplet alert.
8. Motion: hover lift everywhere but no reduced-motion handling, no pulse tokens.
9. Density/palette settings absent; one hardcoded light theme.
10. A11y: no systematic aria contract or focus-visible ring tokens (we use box-shadow
    rings per selector).
11. Terminal transport robustness: per-client PTY, no replay buffer, queued input on
    reconnect risk, no backpressure to PTY (wterm slices client-side only).
