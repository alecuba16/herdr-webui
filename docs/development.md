# Development guide

## Project Layout

- `Cargo.toml`: Rust crate manifest for `herdr-webui`.
- `src/main.rs`: WebUI server, auth, JSON proxy, WebSockets, terminal bridge, install helpers.
- `src/assets.rs`: embedded frontend asset responses.
- `src/compat.rs`: backend compatibility checks.
- `src/file_browser.rs`: authenticated file-browser API for trees, file read/write, rename, and delete.
- `src/git_ui/mod.rs` and `src/git_ui/`: embedded Git UI API split into modules (cleanup, diff, branch, stash, conflict, file, log) for maintainability.
- `src/protocol.rs`: Herdr direct terminal attach wire types and frame codec.
- `src/service.rs`: OS service helpers.
- `src/assets/`: embedded HTML/CSS/JS and frontend tests.
- `src/assets/desktop/`: desktop UI bundle chunks and desktop-only CSS.
- `src/assets/desktop/app_css/`: desktop shell CSS modules concatenated into `/assets/desktop/app.css`.
- `src/assets/desktop/app_js/`: desktop shell JS modules concatenated into `/assets/desktop/app.js`.
- `src/assets/desktop/file_browser.js` and `src/assets/desktop/file_browser.css`: desktop file explorer and editor shell.
- `src/assets/desktop/git_ui/`: embedded Git UI modules for settings, syntax highlighting, log actions, drawer shell CSS, diff CSS, log CSS, and layout CSS.
- `src/assets/icons/`: SVG icons served as static assets and referenced from CSS/markup.
- `src/assets/mobile/`: mobile UI bundle chunks and mobile-only CSS.
- `src/assets/shared/`: browser helpers shared by desktop and mobile bundles.
- `src/assets/shared/colors.css`: shared cross-layout theme extension tokens for search highlights, focus rings, and editor-style panels.
- `src/assets/shared/content_search.css`: shared content-search visual rules for match highlighting and Git-style context arrows.
- `src/assets/shared/file_tree.js`: shared file-tree renderer, search helpers, parent-path helpers, Git status application, and go-up entry helpers.
- `src/assets/shared/file_icons.js` and `src/assets/shared/file_icons.css`: shared neutral file icon map and styling.
- `src/assets/shared/workspace_search.js`: shared unified search settings, backend request helpers, path tree rendering, content picker rendering, and match highlighting.
- `src/assets/shared/file_content_search.js`: shared grouped content-search renderer used by desktop and mobile controllers.
- `src/assets/shared/editor.js`: shared lightweight editor abstraction around CodeMirror and fallback rendering.
- `src/assets/vendor/codemirror_entry.mjs`: CodeMirror bundle source entry; `src/assets/vendor/codemirror.bundle.js` is the checked-in generated browser bundle.
- `.github/workflows/webui-ci.yml`: WebUI CI.
- `.github/workflows/webui-release.yml`: WebUI release builds for SemVer `v*.*.*` tags.
- `Makefile`: local build, run, install, update, uninstall commands.

The Rust binary embeds frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

## Frontend Notes

- Desktop and mobile UI are embedded vanilla HTML/CSS/JS assets. The main shell has no frontend build step; the optional CodeMirror editor bundle is generated from `src/assets/vendor/codemirror_entry.mjs` and checked in.
- Desktop shell and Git UI assets are split into plain JS/CSS modules and concatenated by `src/assets.rs`; public URLs stay `/assets/desktop/app.js`, `/assets/desktop/app.css`, `/assets/desktop/git-ui.js`, and `/assets/desktop/git-ui.css`.
- Desktop Git UI and desktop file browser controller code are lazy-loaded when those panels are opened. Shared helpers, color tokens, shared content-search CSS, file tree rendering, file icons, unified search helpers, content-search rendering, terminal scroll helpers, and the CodeMirror/editor shell load during boot so file previews and search results mount immediately with the final style.
- The shared editor uses CodeMirror for read-only previews and editable file views, with a lightweight numbered HTML fallback only if CodeMirror fails to load.
- Desktop terminal output is frame-batched in the browser so bursts of WebSocket terminal frames are coalesced before xterm rendering. Pending frames are flushed before reconnect or close to avoid dropping final output.
- Large terminal paste input bypasses xterm `paste()` and uses bounded WebSocket input chunks with backpressure, so very large clipboards do not block the renderer or become one huge browser frame.
- Terminal links are optional in Settings. When enabled, desktop and mobile xterm instances detect `http`/`https` URLs and open them in a new browser tab.
- Blocking browser confirmation dialogs count as input delay in Chrome traces. Git bulk section actions defer their API/render work until after the confirmation returns so dialog wait time is not mixed with mutation/render cost.
- Unified search is header-driven. Do not add separate file explorer search inputs; add sections to the header search and keep section enablement/order in Settings.
- Content-search controllers should call backend routes and shared rendering. Do not scan repository content in browser code.
- Shared color/theme additions belong in `src/assets/shared/colors.css` when they apply to both desktop and mobile. Shared visual rules belong in a shared CSS file when both layouts use them. Avoid duplicated literal palettes in desktop and mobile CSS.
- Prefer moving behavior out of inline handlers into delegated JS listeners and shared CSS classes when touching UI code.
- SVG icons should live under `src/assets/icons/` and be referenced from CSS or markup, not embedded inline in JS templates.
- File tree navigation helpers (`parentPath`, `parentDirectory`, `upEntry`, `searchTreeEntriesByKind`) are shared via `window.HerdrFileTree` and used by desktop file browser, mobile file browser, and directory picker so go-up and search behavior stays consistent across all three.

## Structure Rules For New Features

- Backend first for expensive repo work: file traversal, Git state, content matching, diff generation, and mutation validation.
- Shared frontend module first for cross-layout rendering or data maps.
- Desktop/mobile controllers should stay thin: read settings, call APIs, store UI state, and render with shared helpers.
- Settings must be clamped at read/write boundaries and documented in [Technical details](technical-details.md#settings).
- Help text must be updated when a user-visible feature changes.
- Add or update tests for asset loading, static feature assertions, backend edge cases, and panel-state behavior.

## Desktop And Mobile Parity

- Both layouts support workspace selection, agent list/attention status, panel selection/creation/closing, linked worktree listing/creation/opening, terminal attach, bounded terminal paste, terminal scrollback follow/Tail behavior, terminal links, Files browsing with backend search/filter, Git status viewing with file filtering, read-only Git file diffs, Settings, theme choice, browser notifications, local attention tone volume, file tree indentation, and layout preference.
- Desktop is the full power-user layout. It includes the embedded Git drawer with mutations, diffs, log, stash, cleanup, blame, file history, hunk actions, conflict actions, shortcuts, and the editable file browser with split panes.
- Mobile is intentionally narrower. It keeps navigation, agents, worktrees, terminal, Files preview with go-up navigation, Git status, and read-only Git file diffs usable on small screens, but does not yet expose desktop Git mutations/log/stash/cleanup/blame/history or file editing/split panes.
- When adding a desktop feature, decide explicitly whether mobile needs full parity, read-only parity, or documentation as desktop-only. Keep this section updated so mobile gaps are intentional.

## Mobile Layout Notes

- Mobile uses a fixed `100dvh` app shell with three rows: header, scrollable content, and bottom navigation.
- `html`, `body`, `#app`, and `.mobile-app` keep overflow hidden so only the intended content areas scroll.
- Grid children that can contain wide terminal/file content set `min-width: 0` and `min-height: 0`; without these guards, CSS grid/flex intrinsic sizing can make the whole app overflow the viewport.
- The bottom navigation is one horizontal scrolling row, not a wrapping grid. This avoids a two-line bottom bar when there are more tabs than fit on narrow screens.
- Bottom navigation buttons use `flex: 0 0 auto` and a small minimum width so labels stay tappable while the bar can scroll sideways.
- Terminal panel tabs also scroll horizontally, and terminal output scrolls inside `.mobile-terminal-shell` instead of pushing the app wider or taller.
- Mobile terminal tabs include `+` to create a panel and `✕` to close the current panel. The Panels screen also exposes `Close current panel` for discoverability.
- Mobile terminal scrollback mirrors desktop behavior: scrolling up pauses follow, new output preserves the current viewport, and `Tail` jumps to latest output and resumes follow.
- Mobile paste uses the same bounded WebSocket input queue as desktop, with backpressure for large clipboards.
- Mobile Git file diffs render hunks inside horizontally scrollable code blocks so long lines do not widen the app shell.

TODO:

- Evaluate a small progressive templating layer, with `petite-vue` as the leading option, to reduce inline JavaScript and string-template complexity.
- Keep the migration incremental if adopted: start with isolated islands such as settings, modals, sidebar workspace rows, and Git file lists.
- Avoid adding a heavier framework unless it removes more code than it adds. `jQuery` is not expected to help much here because the main pain is templating/state, not DOM selection.
