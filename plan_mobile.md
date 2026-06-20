# Mobile Frontend Plan

## Goal

Make Herdr WebUI usable on smartphones without mixing mobile layout logic into the current desktop frontend.

The mobile UI should use the same backend APIs, route state, terminal protocol, theme/options model, and socket behavior, but render through an independent mobile shell.

## Current Frontend Shape

- `webui/src/assets/app.html` defines a desktop shell: sidebar with workspaces/agents plus main area with tabs and terminal.
- `webui/src/assets/app.css` uses a fixed desktop grid: sidebar width `330px` plus flexible main column.
- `webui/src/assets/app.js` mutates the desktop DOM at startup, builds the sidebar split, and renders workspaces, agents, tabs, and terminal chrome in one desktop-oriented flow.
- There are no responsive `@media` rules today.
- URL state already carries selected session/workspace/tab/pane, so mobile can reuse deep links and browser refresh behavior.

## Design Principles

- Do not use user-agent sniffing.
- Do not add mobile conditionals throughout the existing desktop `app.js`.
- Use viewport/media-query detection plus an explicit user override for layout selection.
- Keep desktop and mobile layout/rendering independent.
- Share protocol/API/state helpers between desktop and mobile where practical.
- Use media queries for styling and placement only, not business logic.

## Target Architecture

### Boot Layer

Add `webui/src/assets/app_boot.js`.

Responsibilities:

- Read saved layout preference: `auto`, `desktop`, or `mobile`.
- In `auto`, choose by `matchMedia("(max-width: 760px)")`, not user agent.
- Load exactly one layout bundle:
  - Desktop: existing `app.css` + `app.js`.
  - Mobile: new `mobile.css` + `mobile.js`.
- Watch viewport changes only if we decide live switching is safe. Initial implementation can require reload after layout preference/viewport class changes to avoid socket/terminal churn.

### Shared Runtime

Add `webui/src/assets/app_runtime.js` after the boot layer proves useful.

Move shared non-layout logic out of `app.js` incrementally:

- API helper and error handling.
- Route helpers: session prefix, selection path, route parsing.
- Options loading/saving/normalization.
- Theme application and theme color variables.
- Refresh/data loading pipeline.
- Event WebSocket setup.
- Terminal socket/input helpers where both layouts need same behavior.

Desktop and mobile should call runtime functions instead of duplicating API/socket semantics.

Keep extraction small and verified step by step. Do not rewrite the desktop UI just to make it prettier.

### Desktop Bundle

Keep current files as desktop implementation:

- `webui/src/assets/app.js`
- `webui/src/assets/app.css`

Desktop behavior should remain unchanged except for calling shared runtime functions after extraction.

### Mobile Bundle

Add:

- `webui/src/assets/mobile.js`
- `webui/src/assets/mobile.css`

Mobile bundle owns its markup and render flow. It should not depend on desktop classes such as `.side`, `.tabs`, or `.sidebar-split`.

## Mobile UX Model

### Screens

1. `Home`
   - Workspaces list.
   - Agents list.
   - Primary tap selects and opens terminal screen.
   - Row overflow menu handles secondary actions.

2. `Terminal`
   - Top header with current context.
   - Terminal fills remaining screen.
   - Bottom nav or header action opens panels/workspaces/agents.

3. `Panels`
   - Current workspace tabs/panels.
   - New panel button.
   - Close/rename actions in overflow menu.

4. `Worktrees`
   - Full-screen worktree discover/open/create flow.
   - Reuse existing backend behavior.

5. `Settings`
   - Full-screen mobile modal.
   - Same browser-local options as desktop.

### Collapse Behavior

- Home shows workspaces and agents.
- Selecting a workspace or agent navigates to the terminal screen.
- Terminal header shows selected context so the sidebar is not needed.
- Back/Home button returns to Home.
- Browser URL still tracks workspace/tab/pane selection.

### Terminal Header

Header should show compact current context:

- Session.
- Workspace label.
- Worktree/repo/branch chip when available.
- Current tab/panel label.
- Agent status chip when attached to an agent panel.

Suggested placement:

- Left: Back/Home button.
- Center: context summary, truncated with chips.
- Right: menu/settings button.

### Bottom Navigation

Use bottom navigation on narrow phones:

- Workspaces.
- Agents.
- Panels.
- Terminal.

On wider mobile/tablet widths, media queries can move these actions into the top header or side drawer.

### Button Placement Rules

- Primary row tap opens/selects.
- Secondary row actions move into `...` overflow menus.
- Create actions move into one `+` menu per screen, not scattered across every row.
- Touch targets should be at least `44px` high/wide.
- Avoid hover-only controls.
- Use `env(safe-area-inset-*)` for notches/home indicator.

## Media Query Policy

Media queries control position and styling only:

- Button sizes.
- Header height.
- Bottom nav visibility.
- Drawer vs full-screen modal placement.
- Spacing and typography.
- Safe-area padding.
- Terminal viewport height.

Media queries must not control:

- Which backend data to fetch.
- Selected workspace/tab/pane.
- WebSocket behavior.
- Terminal protocol behavior.
- Worktree API behavior.

Example:

```css
@media (max-width: 480px) {
  .mobile-header {
    min-height: 52px;
    padding: 8px max(12px, env(safe-area-inset-left));
  }

  .mobile-action {
    min-width: 44px;
    min-height: 44px;
  }

  .mobile-bottom-nav {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@media (min-width: 481px) and (max-width: 900px) {
  .mobile-bottom-nav {
    display: none;
  }

  .mobile-header-actions {
    display: flex;
    margin-left: auto;
  }
}
```

## Terminal Behavior On Mobile

- Default to browser-fit terminal size on mobile.
- Use `visualViewport` when available to handle soft keyboard height.
- Keep horizontal scroll available when terminal content is wider than screen.
- Keep paste batching and bracketed-paste behavior from shared runtime.
- Provide touch-friendly copy/paste menu.
- Retain existing terminal scroll behavior where possible, but avoid relying on mouse wheel interactions.

## Routing

Keep current URL structure:

- `/workspace/:workspace_id/tab/:tab_id/pane/:pane_id`
- `/session/:session/workspace/:workspace_id/tab/:tab_id/pane/:pane_id`

Mobile screen state should be UI-local:

- `home`
- `terminal`
- `panels`
- `worktrees`
- `settings`

Initial mobile screen rules:

- URL has selected pane: open `terminal`.
- URL has workspace only: open `panels` or `terminal` after backend selects default tab/pane.
- No selection or backend offline: open `home` or session manager.

## Testing Plan

Add no-browser tests first:

- `mobile_load.test.mjs`: load `app_core.js`, shared runtime, and `mobile.js` in a VM with a minimal DOM stub.
- Layout selection tests for `app_boot.js`: auto desktop/mobile and explicit override.
- Mobile context summary tests: workspace/worktree/tab/agent labels.
- Route-to-initial-screen tests.

Keep existing default test path browser-free:

```sh
make test-js
make test
```

Manual smoke checklist:

- iPhone-like width: `390px`.
- Android-like width: `360px`.
- Tablet width: `768px`.
- Portrait and landscape.
- Terminal attach works.
- Soft keyboard does not hide terminal input area.
- Workspaces/agents select and collapse to terminal.
- Header shows correct current workspace/worktree/panel.
- Panels switcher works.
- Worktrees modal opens and create/open flow remains usable.
- Desktop layout still loads and behaves unchanged.

## Implementation Phases

### Phase 1: Boot And Asset Routes

- Add `app_boot.js`.
- Add `mobile.css` and `mobile.js` as empty/minimal shell.
- Update `app.html` to load boot script instead of directly loading desktop CSS/JS.
- Update Rust asset routes and embedded assets.
- Add load tests for boot path.
- Verify desktop still unchanged.

### Phase 2: Shared Runtime Boundary

- Extract smallest reusable API/route/options helpers.
- Keep desktop behavior unchanged.
- Add tests for extracted helpers.

### Phase 3: Mobile Home And Navigation

- Render mobile Home with workspaces/agents.
- Selecting rows updates URL and opens Terminal screen.
- Header summary shows current context.

### Phase 4: Mobile Terminal

- Attach terminal in mobile shell.
- Browser-fit terminal sizing by default.
- Touch-safe copy/paste.
- Keyboard-safe viewport handling.

### Phase 5: Mobile Panels And Actions

- Add Panels screen.
- Add new/close/rename panel actions through mobile-safe controls.
- Add workspace create/rename/close actions via overflow menus.

### Phase 6: Mobile Worktrees And Settings

- Port worktree discover/open/create UI to full-screen mobile flow.
- Port settings to full-screen mobile modal.
- Add layout override setting.

### Phase 7: Docs And Release

- Update README with mobile architecture and manual smoke checklist.
- Run full checks.
- Tag release when stable.

## Risks

- Current `app.js` is monolithic. Extract runtime carefully to avoid desktop regressions.
- xterm sizing with mobile soft keyboard can be browser-specific.
- Mobile Safari viewport units and safe-area handling need manual verification.
- Live switching between desktop and mobile layouts may leak sockets/terminal state. Prefer reload-on-layout-change until lifecycle is clean.

## Success Criteria

- Desktop UI remains unchanged.
- Phone-sized viewport does not show squeezed desktop sidebar.
- Mobile starts on Home or Terminal based on route.
- Workspaces/agents fit phone screen and collapse after selection.
- Terminal usable on phone with clear current context in header.
- No user-agent sniffing.
- Default tests remain browser-free and pass.
