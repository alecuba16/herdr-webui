# Herdr WebUI

Standalone browser UI for an official Herdr backend session.

`herdr-webui` is not a Herdr fork and does not ship the Herdr terminal multiplexer. It connects to a running Herdr backend through Herdr's JSON API socket and direct terminal attach socket, then exposes workspace navigation, agent status, and terminal attach in a local web app.

## Requirements

- Rust toolchain for local builds.
- Git CLI for worktree features.
- Official Herdr binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.

Compatibility:

| WebUI | Herdr | Protocol | Status | Notes |
| --- | --- | --- | --- | --- |
| `0.2.5` | `0.7.2` | `15` with `14` fallback | Current | Marks Herdr 0.7.2 protocol 15 as tested while preserving protocol 14 fallback for older compatible servers. |
| `0.2.4` | `0.7.1+` | `15` with `14` fallback | Tested | Prefers Herdr direct attach protocol 15 and retries protocol 14 when an older compatible server rejects the initial handshake. |
| `0.2.3` | `0.7.1` | `14` | Tested | Expands Help & Shortcuts with a separated Functionality map section and more detailed area rows. |
| `0.2.2` | `0.7.1` | `14` | Tested | Renames the `?` modal to Help & Shortcuts, with a functionality map and action flows for creating workspaces/panels, opening Files/Git, worktree actions, terminal scroll/follow, search palette, and settings. |
| `0.2.1` | `0.7.1` | `14` | Tested | Restores native xterm.js wheel scrolling by removing the custom shell wheel handler, enables xterm viewport scrolling, uses dynamic terminal shell sizing without inline height/width, removes the custom terminal context menu, and deduplicates terminal CSS/JS into modular helpers. |
| `0.2.0` | `0.7.1` | `14` | Tested | Unifies file browser go-up and search across desktop, mobile, and directory picker with shared tree helpers. Adds Git status colors to file browser entries (yellow modified, green new, red deleted, blue changed directories) with theme-aware contrast for light and dark. Adds unified Git diff layout (GitHub-style) with staged hunk restore. Fixes tab/panel rename focus loss during terminal updates. Fixes terminal wheel scroll in normal buffer mode. Replaces file browser Refresh text button with animated icon button. Splits Git UI into modules for maintainability. Fixes worktree duplication in cleanup. Adds worktree prune endpoint, ahead/behind upstream status, structured log output, and error warnings collection. Bundles JetBrainsMono Nerd Font Mono. |
| `0.1.9` | `0.7.1` | `14` | Tested | Splits Git UI into modules, fixes worktree duplication in cleanup, unifies file tree go-up and search across desktop/mobile/directory picker, adds directory picker search, adds worktree prune endpoint and ahead/behind upstream status, and bundles JetBrainsMono Nerd Font Mono. |
| `0.1.8` | `0.7.1` | `14` | Tested | Adds mobile read-only Git file diffs with horizontally scrollable hunks so long diff lines stay inside the mobile app shell. Bundles JetBrainsMono Nerd Font Mono for terminal icons and shared monospace UI rendering. |
| `0.1.7` | `0.7.1` | `14` | Tested | Improves Git cleanup results with nested repo lists, aligned visible checkboxes, group/repo selection, hidden primary worktrees, and stable scroll while selecting. |
| `0.1.6` | `0.7.1` | `14` | Tested | Adds Files search focus/typing UX, terminal URL links, current-panel close affordances, Git file filtering, cleanup layout fixes, and bulk cleanup refinements. |
| `0.1.5` | `0.7.1` | `14` | Tested | Adds Git branch/worktree cleanup, separate worktree and exploration default directories, and safer bulk cleanup selection. |
| `0.1.4` | `0.7.1` | `14` | Tested | Adds configurable default directory and local notification tone volume, documents browser notification permission handling, and keeps desktop/mobile Settings parity for these options. |
| `0.1.3` | `0.7.1` | `14` | Tested | Lazy-loads CodeMirror, desktop Git UI, and desktop file browser JavaScript so initial terminal loads avoid unused heavy feature bundles. |
| `0.1.0` | `0.7.1` | `14` | Tested | Unifies workspace/worktree opening, enriches workspace cwd metadata from backend pane data, restores Settings search, and reduces browser CPU/memory load for terminal output, large paste, no-sleep polling, and large Git diffs. |
| `0.0.57` | `0.7.1` | `14` | Tested | Fixes worktree creation source handling, adds optional base-branch pull, improves worktree deletion, Git directory loading, directory picker navigation, and terminal scroll follow controls. |
| `0.0.49` | `0.7.1` | `14` | Tested | Adds file browser/editor, shared file trees, CodeMirror editing, large Git change-set placeholders, browser notifications, themed favicons, and local snapshot versioning. |
| `0.0.46` | `0.7.1` | `14` | Tested | Adds configurable WebUI/Git prefix shortcuts, keeps Git drawer keyboard input isolated, and raises Rust line coverage above 70%. |
| `0.0.45` | `0.7.1` | `14` | Tested | Improves embedded Git UI navigation with Escape handling, all-changes return behavior, split frontend assets, scoped file history controls, keyboard-owned drawer input, and per-file large diff loading. |
| `0.0.45` | `0.7.0` | `14` | Minimum supported | Uses WebUI's legacy existing-branch worktree fallback when needed. |

Newer Herdr builds may work when protocol stays compatible, but WebUI reports them as untested. WebUI 0.2.5 treats Herdr 0.7.2 protocol 15 as tested and retries protocol 14 for compatible older Herdr 0.7.x servers.

## 0.2.5 Release Notes

### Compatibility

- Marks Herdr 0.7.2 as the maximum tested backend so current protocol 15 installs report as compatible.

### Sidebar and agents

- Agents sidebar sorting is configurable in Settings → Agents and alerts. Status groups can be reordered with up/down controls and are saved in browser-local settings.
- File browser search now supports file or folder mode with `Alt+F` / `Alt+D` switching. Folder search uses breadth-first backend traversal so shallow matching folders are found before deep unrelated trees exhaust the search cap. File/folder searches keep parent breadcrumbs, match highlighting, scroll/focus preservation, and paginated loading.
- File browser rename/delete updates the visible tree in place where possible instead of forcing a full list reload. The editor uses a dedicated `--editor-bg` theme color so syntax highlighting, especially YAML in dark mode, stays readable independently from panel surfaces.
- Agent status groups use explicit colors in settings: idle green, working yellow, blocked red, done blue, and others gray.
- The Workspaces/Agents sidebar split is resizable by dragging the separator, snaps to whole percent values, and can also be set directly in Settings → Agents and alerts.

### Terminal

- Terminal scrollback wheel/touch behavior is centralized in `src/assets/shared/terminal_scroll.js` as `window.HerdrTerminalScroll`.
- The helper owns normal-buffer detection, xterm row-height lookup, wheel/touch delta-to-line conversion, and local scrollback movement through `term.scrollLines()` or `term.scrollToLine()` fallback.
- Desktop and mobile terminal modules keep only DOM event binding and follow-button state updates, so scroll mechanics stay shared while platform-specific event wiring remains local.
- Alternate-screen terminal apps still receive scroll input because local scrollback handling is gated to xterm's normal buffer.

## 0.2.4 Release Notes

### Compatibility

- WebUI now prefers Herdr direct attach protocol 15 and automatically retries protocol 14 when a compatible older Herdr server rejects the initial protocol 15 handshake.
- `/api/versions` reports the current WebUI protocol and the minimum fallback protocol so clients can display the supported range.

## 0.2.3 Release Notes

### Help & Shortcuts

- Functionality map is separated from Keyboard shortcuts.
- More detailed rows for Sidebar, Header, Panels, Terminal, Files, Git, Worktrees, Search, and Settings.
- Added CSS layout for the expanded help section.

## 0.2.2 Release Notes

### Help & Shortcuts

- Renamed the `?` modal to Help & Shortcuts.
- Sidebar/Header/Panels/Terminal/Files/Git/Worktrees/Search/Settings rows now give concise function map entries.
- Lists button/action flows for creating workspaces and panels, opening Files/Git, worktree actions, terminal scroll/follow, search palette, and settings.

## 0.2.1 Release Notes

### Terminal

- Restored native xterm.js wheel scrolling by removing the custom terminal shell wheel handler.
- Enabled xterm viewport scrolling so terminal scrollback uses xterm's own viewport behavior.
- Switched terminal shells to dynamic sizing with no inline shell height or width.
- Removed the custom terminal context menu so browser/xterm defaults handle context actions.
- Deduplicated terminal CSS and JavaScript into shared modular helpers for desktop and mobile.

## 0.2.0 Release Notes

### File browser

- Unified file tree navigation helpers (`parentPath`, `parentDirectory`, `upEntry`, `searchTreeEntries`) shared across desktop file browser, mobile file browser, and directory picker via `window.HerdrFileTree`.
- The `...` go-up entry is always visible when a parent directory exists, on desktop, mobile, and the directory picker. No longer gated behind a setting.
- The directory picker includes debounced search and the same go-up behavior as the file browser, with home-to-root transition from `~` to `/`.
- File browser Refresh button replaced with a rounded icon button that spins while loading.
- File browser Close button removed; file browser is toggled via the tabbed selector.
- File browser title row right-justifies actions; path subtitle wraps below on its own line.

### Git status colors in file browser

- File browser entries are colored by Git status when the current directory is inside a Git repository.
- Yellow for modified files, green for new and untracked files, red for deleted files, orange for conflicts.
- Directories containing any changed files are marked blue, with propagation up to all parent directories.
- Colors are theme-aware: dark themes use pastel colors, light themes use saturated colors with appropriate contrast.
- Toggle in Settings under `File browser` → `File browser git status colors` (enabled by default).
- Git status paths are adjusted server-side so they match the browsed subdirectory, not the repo root.

### Git UI improvements

- `src/git_ui.rs` (2981 lines) split into `src/git_ui/` module: `mod.rs`, `cleanup.rs`, `diff.rs`, `branch.rs`, `stash.rs`, `conflict.rs`, `file.rs`, `log.rs`.
- Worktree dedup in cleanup: linked worktrees resolve to their base repository and no longer appear as separate entries.
- Worktree prune endpoint (`POST /api/git-ui/worktree-prune`) with dry-run and expiry options, capturing pruned paths from Git verbose output.
- Git status reports `ahead` and `behind` counts relative to upstream using porcelain v2 branch tracking.
- Status and conflict endpoints collect non-fatal Git warnings instead of silently dropping errors.
- Git log returns structured commit data (`hash`, `author`, `date`, `message`) alongside graph lines, with null-byte separators handled server-side.
- All 28 Git UI handlers wrapped in `spawn_blocking`.
- Auth checks unified via `check_auth!` macro.
- Unified (GitHub-style) Git diff layout option in Settings → Git UI → Git diff layout. Side-by-side remains default. Unified view shows compact old/new line numbers, `+`/`-` signs, and inline content in a single column. Staged hunk restore now supported (`reverse + cached`).

### Terminal

- Bundles `JetBrainsMonoNerdFontMono-Regular.ttf` for terminal icons and shared monospace UI rendering.
- Font loaded via `@font-face` and served from `/assets/fonts/`.
- Desktop and mobile terminal refresh font family after Nerd Font loads.
- Fixed wheel scroll in normal buffer mode: wheel events now call `term.scrollLines()` with the same scroll batching as alternate screen mode.
- Fixed `xterm-viewport` overflow from `visible` to `hidden` to prevent unwanted vertical scrollbar.

### Focus preservation

- Tab and panel rename inputs no longer lose focus when terminal output triggers a re-render. The workspace sidebar `innerHTML` update is now guarded when any rename input is active (`editingTab` or `editingWorkspace`).

### Settings

- New `File browser` settings section with tree indentation, parent folders toggle, and Git status colors toggle.
- `fileBrowserGitStatus` stored in browser `localStorage`, defaults to enabled.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
```

Runtime version:

- Local builds report `snapshot-<shortsha>`.
- GitHub Actions tag builds report the release tag.
- `Cargo.toml` keeps the next static WebUI SemVer for package metadata; product version still comes from `build.rs` and is exposed by `herdr-webui --version` and `/api/versions`.

## Run Locally

Start Herdr separately:

```sh
herdr server
```

Run WebUI without login on loopback:

```sh
make run-web-local
```

Open:

```text
http://127.0.0.1:8787
```

Use a specific Herdr binary when WebUI launches backend sessions:

```sh
HERDR_WEB_HERDR_BIN=/opt/homebrew/bin/herdr make run-web-local
```

## CLI

```text
herdr-webui [--verbose] [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]
herdr-webui --version
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--session NAME]
herdr-webui update-mac [--verbose]
herdr-webui install-linux [--bind HOST:PORT] [--session NAME]
herdr-webui update-linux
herdr-webui start-mac | start [--verbose]
herdr-webui stop-mac | stop [--verbose]
herdr-webui restart-mac | restart [--verbose]
herdr-webui start-linux | start
herdr-webui stop-linux | stop
herdr-webui restart-linux | restart
herdr-webui uninstall-mac [--verbose]
herdr-webui uninstall-linux
```

Use `--verbose`, `-v`, or `HERDR_WEB_VERBOSE=1` with macOS service commands to print LaunchAgent diagnostics, including UID/EUID, launchctl domain, service target, plist path, and launchctl stderr.

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
- `src/assets/shared/file_tree.js` and `src/assets/shared/editor.js`: shared file-tree renderer and lightweight editor abstraction.
- `src/assets/vendor/codemirror_entry.mjs`: CodeMirror bundle source entry; `src/assets/vendor/codemirror.bundle.js` is the checked-in generated browser bundle.
- `.github/workflows/webui-ci.yml`: WebUI CI.
- `.github/workflows/webui-release.yml`: WebUI release builds for SemVer `v*.*.*` tags.
- `Makefile`: local build, run, install, update, uninstall commands.

The Rust binary embeds frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

## Frontend Notes

- Desktop and mobile UI are embedded vanilla HTML/CSS/JS assets. The main shell has no frontend build step; the optional CodeMirror editor bundle is generated from `src/assets/vendor/codemirror_entry.mjs` and checked in.
- Desktop shell and Git UI assets are split into plain JS/CSS modules and concatenated by `src/assets.rs`; public URLs stay `/assets/desktop/app.js`, `/assets/desktop/app.css`, `/assets/desktop/git-ui.js`, and `/assets/desktop/git-ui.css`.
- CodeMirror, desktop Git UI, and desktop file browser JavaScript are lazy-loaded. Initial desktop/mobile terminal loads should not download editor or Git/File feature code until those features are opened.
- The shared editor uses lightweight read-only previews by default and loads CodeMirror only for editable file views.
- Desktop terminal output is frame-batched in the browser so bursts of WebSocket terminal frames are coalesced before xterm rendering. Pending frames are flushed before reconnect or close to avoid dropping final output.
- Large terminal paste input is chunked with WebSocket backpressure instead of being sent as one very large browser frame.
- Terminal links are optional in Settings. When enabled, desktop and mobile xterm instances detect `http`/`https` URLs and open them in a new browser tab.
- Blocking browser confirmation dialogs count as input delay in Chrome traces. Git bulk section actions defer their API/render work until after the confirmation returns so dialog wait time is not mixed with mutation/render cost.
- File search inputs preserve focus and cursor selection while async results render. Prefer `renderPreservingScroll`/focus-preserving render paths when refreshing filter-driven lists so typing does not get interrupted by DOM replacement.
- Prefer moving behavior out of inline handlers into delegated JS listeners and shared CSS classes when touching UI code.
- SVG icons should live under `src/assets/icons/` and be referenced from CSS or markup, not embedded inline in JS templates.
- File tree navigation helpers (`parentPath`, `parentDirectory`, `upEntry`, `searchTreeEntries`) are shared via `window.HerdrFileTree` and used by desktop file browser, mobile file browser, and directory picker so go-up and search behavior stays consistent across all three.

## Desktop And Mobile Parity

- Both layouts support workspace selection, agent list/attention status, panel selection/creation/closing, linked worktree listing/creation/opening, terminal attach, terminal paste sanitization, terminal scrollback follow/Tail behavior, terminal links, Files browsing with backend search/filter, Git status viewing with file filtering, read-only Git file diffs, Settings, theme choice, browser notifications, local attention tone volume, file tree indentation, and layout preference.
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
- Mobile paste/input uses bounded WebSocket chunks with backpressure, matching the desktop large-paste protection.
- Mobile Git file diffs render hunks inside horizontally scrollable code blocks so long lines do not widen the app shell.

TODO:

- Evaluate a small progressive templating layer, with `petite-vue` as the leading option, to reduce inline JavaScript and string-template complexity.
- Keep the migration incremental if adopted: start with isolated islands such as settings, modals, sidebar workspace rows, and Git file lists.
- Avoid adding a heavier framework unless it removes more code than it adds. `jQuery` is not expected to help much here because the main pain is templating/state, not DOM selection.

## Authentication

Server access settings are stored in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.
- No-sleep Auto cooldown.

Non-localhost binds require both username and password. WebUI rejects `0.0.0.0` or any other non-loopback bind until both credentials are configured.

## Sessions

By default, WebUI targets Herdr's default session sockets.

Use a named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

When Herdr is offline, WebUI shows a session manager. It can launch Herdr using `HERDR_WEB_HERDR_BIN` or `herdr` from `PATH`, retry connection, reset workspaces, or close the current Herdr session.

If `--session NAME` is supplied, launched Herdr processes receive `HERDR_SESSION=NAME`.

## WebUI Features

The browser UI provides workspace navigation, top panel tabs, agent status, terminal attach, Git views, file browsing/editing, and local-only convenience settings stored in browser storage.

Sidebar:

- The sidebar can collapse via the divider; state is stored in browser `localStorage` and collapsed mode keeps compact blocked/working/idle/done counters.
- The header exposes Search, Theme, No-sleep, Worktree, New workspace, Git, and Files controls. The footer exposes session info, shortcut help, and Settings.
- Theme colors are browser-local and shared with shell controls and embedded Git UI.
- No-sleep supports Off, Auto, 1 hour, 2 hours, 4 hours, and Infinite from a compact dropdown.
- No-sleep status polling is adaptive: WebUI does not keep polling while no-sleep is Off and the server is healthy. Active modes and transient errors still retry so the control stays accurate without idle browser/network churn.

Settings:

- The Settings modal includes a `Search settings` field in the header.
- Settings search filters grouped settings sections and individual option rows locally in the browser.
- `Worktree default directory` is stored in browser `localStorage` as `worktreeDefaultDirectory`. It is used only as the base for generated worktree checkout paths. Relative values resolve from the source repo root, for example `../worktrees`.
- `Exploration default directory` is stored in browser `localStorage` as `explorationDefaultDirectory`. It prefills desktop new/open workspace paths, desktop worktree discovery paths, desktop Git cleanup scan roots, and mobile worktree discovery paths.
- The notification volume setting is stored in browser `localStorage` as `notificationVolume`, a decimal gain from `0` to `1`. Desktop and mobile expose it as a 0-100 slider and default it to `0.24`.
- The terminal links setting is stored in browser `localStorage` as `terminalLinks`. It defaults to enabled and controls xterm URL link detection on desktop and mobile.
- The file browser Git status colors setting is stored in browser `localStorage` as `fileBrowserGitStatus`. It defaults to enabled and controls whether the file browser tree shows Git status colors for files and directories.
- Opening Settings clears the previous search, refreshes option values, reloads server settings, and focuses the search box.

Notifications and attention sounds:

- Agents entering `blocked` or `done` are treated as attention events. WebUI tracks known attention agents locally and only alerts for newly attentioned agents.
- The local attention tone is generated with Web Audio using a short two-note sine tone. Browsers require a user gesture before audio can play, so WebUI unlocks audio after interaction and skips sound until the audio context is running.
- The `Sound` toggle disables the local attention tone. `Notification volume` controls the tone gain only; set `Sound` off for full mute.
- `Notification volume` is clamped to `0-100%` in Settings and `0-1` in stored options. A saved `0%` uses a near-silent Web Audio gain floor because exponential ramps cannot target absolute zero.
- `Notification scope` controls whether local tone alerts fire for all new attention events or only for the currently selected agent panel.
- `Browser notifications` asks the browser for Notification API permission only when enabled from Settings and the current permission is `default`. WebUI stores the option as enabled only when permission returns `granted`.
- Browser notifications are sent only when the option is enabled, the browser supports the Notification API, and permission is still `granted`. If permission is denied or unavailable, the Settings checkbox is disabled or returns to off.
- Desktop browser notifications include the agent status, workspace context, favicon attention icon, and a click handler that focuses WebUI and navigates to the agent panel. Mobile browser notifications include the agent status and agent label/body, using the same permission gate.

Panels:

- The selected workspace or worktree is pinned at the top of the workspace list.
- The selected row includes compact actions for worktree creation, opening, workspace/worktree closing, and worktree removal.
- The current panel selector supports switching, creating, renaming, and closing the current panel. Desktop has a visible current-panel `✕`; mobile exposes close from Panels and the terminal tab strip.
- WebUI subscribes to `pane.closed`, `pane.exited`, and `tab.closed`, clears stale terminal selection immediately, and auto-closes exited panes before switching to the next available panel.

Worktrees:

- With Herdr `0.7.1` and newer, WebUI uses Herdr's native `worktree.create` support for existing local branches and deferred Git work.
- With Herdr `0.7.0`, WebUI keeps a legacy fallback for creating a checkout from an existing branch when a checkout path is supplied.
- Desktop worktree creation uses `Worktree default directory` to generate checkout paths from repo name and branch. Relative defaults resolve from the repo root, for example `../worktrees`.
- WebUI subscribes to `worktree.created`, `worktree.opened`, and `worktree.removed` and refreshes workspace/agent state quickly after these events.
- `worktree.removed` events from Herdr `0.7.1` may include a workspace snapshot. This is additive; WebUI refreshes from the backend state instead of relying only on the event payload.
- Linked worktree cards use the branch name as the main title and show a custom worktree label as a small label chip when one exists.
- Agent rows prefer the linked worktree custom label, so running agents are easier to scan across many branches.
- Worktree groups avoid duplicate repo headers when the parent workspace card is already visible.
- Removing a linked worktree is available from the worktree actions and from the keyboard prefix `Delete` shortcut.

File browser:

- Desktop workspaces and linked worktrees include a file explorer opened from the sidebar Files button. Git, Files, and terminal views are mutually exclusive foreground modes.
- Desktop uses authenticated `/api/file-browser/*` routes for tree, preview, edit/save with hash guard, rename, delete, and contextual open/split/copy actions. Mobile has read-only browse/preview parity.
- Folders are lazy-loaded and collapsed by default. Double-click enters a folder as root; `...` moves upward and is always visible when a parent directory exists, on desktop, mobile, and the directory picker. The file browser Refresh button is a rounded icon that spins while loading.
- Files open in the active preview pane; Shift-click or context `Open in split` opens another pane. Dirty edited files ask before closing.
- Desktop and mobile Files include debounced backend search through `/api/file-browser/tree?q=&offset=&limit=`. Search is bounded, paginated, highlights matches, shows parent folder context as an expanded tree, and preserves scroll/focus while results render.
- Search can be scoped to files or folders from the search pill. Files are the default; `Alt+F` switches to files and `Alt+D` switches to folders. Folder search uses breadth-first traversal so nearby matching folders are returned before deep unrelated trees exhaust the search visit cap.
- File search is attached to the file list. Focusing the list and typing starts filtering, moves focus to the filter input, and keeps typing uninterrupted across loading, Backspace, and clearing.
- File browser Git status colors are enabled by default and can be toggled in Settings under `File browser git status colors`. When enabled, the file tree queries Git status for the current directory and colors file entries: yellow for modified, green for new and untracked, red for deleted, and orange for conflicts. Directories containing any changed files are marked blue, propagating up to all parent directories so changed subtrees are visible from any level.
- The directory picker (Browse buttons in Git UI) includes the same debounced search and always-visible `...` go-up entry as the file browser. Go-up transitions from home (`~`) to filesystem root (`/`) when at the top of the home directory.
- File tree indentation is configurable with `Tree indentation` and shared with Git file trees.

Git UI:

- Desktop has an embedded Git drawer backed by Rust API routes and the system `git` CLI; no Node/React/Vite runtime is needed. Mobile has read-only grouped Git status.
- The drawer blanks hidden DOM to reduce browser work and owns keyboard input while visible so terminal keystrokes do not leak through.
- Core views cover status, commit, log, stash, cleanup, file history, conflicts, blame, hunk editing, side-by-side diffs, branch switching, and worktree actions.
- File lists are collapsible trees with optional filename-only mode, line counts, filtering, yellow match highlighting, and stable scroll while filtering/expanding. Right-click and section actions support stage/unstage/discard/stash with confirmations.
- Cleanup scans `Exploration default directory` or a chosen root for Git repositories, does not follow symlinked directories, caps traversal, and reports truncation. Results render as a nested repo list (`repo -> branches/worktrees -> items`) with checkbox multi-select and one confirmation modal.
- Cleanup deduplicates worktrees: linked worktrees that share a base repository resolve to that repository and no longer appear as separate entries.
- Cleanup supports worktree pruning via a dedicated API endpoint with dry-run and expiry options, capturing pruned paths from Git verbose output.
- Cleanup uses safe delete first: `git branch -d` or `git worktree remove`. It retries force only when Git says force is required. Current branches are disabled, and primary/main worktrees are hidden from cleanup results.
- Large diffs use placeholders, per-file lazy loading, selected-file line limits, and safe previews before full DOM-heavy render. Mutating hunk/block actions are disabled while hidden lines are omitted.
- Diffs include collapse/show-all, change grouping, inline word highlights, context expansion, hunk stage/unstage/restore, blame, syntax highlighting for common languages, and side-by-side hunk editing with hash guard saves.
- Git status reports `ahead` and `behind` counts relative to the upstream branch using porcelain v2 branch tracking.
- Status and conflict endpoints collect non-fatal Git warnings instead of silently dropping errors, returning a `warnings` array so the UI can surface partial failures.
- Git log returns structured commit data (`hash`, `author`, `date`, `message`) alongside graph lines, with null-byte separators handled server-side so desktop graph rendering stays clean.
- Log supports single-commit compare/reset/rebase and shift-click two-commit compare. File history can show a temporary read-only commit diff or jump to the log commit.
- Git shortcuts share the WebUI prefix (`Ctrl+B` by default) and have collision-checked recording. Main defaults: `1` changes, `2`/`C` commit, `3`/`L` log, `4` stash, `R` refresh, `G` stage/unstage all, `Y/U/D/Z` selected file actions, `H/M/E/O/V/I/0` history/blame/edit/compare/branch/focus/help.
- Mutating/destructive operations require confirmation and backend path/ref validation. API routes cover status, diff/compare, branches, cleanup, log, blame, file read/write/history, stashes, conflicts, stage/unstage/discard/stash, switch/reset/rebase/commit, apply-patch, and conflict actions.

Panel and workspace close:

- Closing the last panel in a workspace closes the workspace with Herdr's `workspace.close` API instead of calling `tab.close`, because Herdr rejects closing the last tab.
- Closing a workspace or linked worktree uses `workspace.close` to close all panels in that workspace.
- Closing a normal non-last panel still uses `tab.close`.
- When Herdr reports `pane.exited`, WebUI closes that pane through Herdr's `pane.close` API and switches away from it after refresh.

Panel tab activity:

- Enable `Show panel last update` in Settings under `Agents and alerts`.
- When enabled, top panel tabs show the last WebUI-observed update age next to the tab label.
- Activity is tracked locally in the browser from tab, pane, and agent list changes.
- Labels use coarse buckets to avoid constant recalculation: `<1m`, exact minute values such as `5m ago`, `>1h`, and `>1d`.
- WebUI does not poll a timer to update these labels continuously. Labels refresh when WebUI renders after normal refreshes or Herdr events.
- The timestamp is not persisted by Herdr and is not a backend audit timestamp. Reloading the page starts local tracking again.

Agent sorting:

- Configure in Settings under `Agents and alerts` with the `Agent sorting` dropdown.
- `Default order` shows agents in Herdr's natural order.
- `Attention (blocked first)` sorts blocked agents first, then idle agents, done agents, unknown agents, ignored working agents, and working agents.
- `Attention (working first)` keeps blocked agents first, then working agents, ignored working agents, unknown agents, and done/idle agents.

Stuck working agents:

- Enable `Ignore stuck working agents` in Settings under `Agents and alerts`.
- When enabled, working agents that appear stuck can be locally dismissed with a `Dismiss` button.
- Dismissed agents show as `ignored` and do not trigger attention sounds.
- Dismissals clear automatically when Herdr reports a status change via `pane.agent_status_changed` events, or after a configurable timeout (`Ignore stuck working for` minutes).
- Dismissals are stored in browser `localStorage` and are local-only overrides, not backend truth mutations.

Parent workspace close with linked worktrees:

- Configure in Settings under `Agents and alerts` with the `Parent workspace close` dropdown.
- `Close panels only` (default): closes all panes in the parent workspace via the Herdr API. Linked worktrees keep running. The last pane is blocked by Herdr's confirmation guard, so the parent workspace stays with an idle shell.
- `Full close + re-open worktrees`: closes the parent workspace entirely. Herdr cascades the close to all linked worktrees, stopping their processes. WebUI then re-opens each linked worktree via the `worktree.open` API. Re-opened worktrees start with fresh shells; running processes are lost.

Terminal paste:

- Pasted text is sanitized before reaching the terminal. Newlines (`\r\n`, `\r`, `\n`) are converted to spaces, and trailing spaces are trimmed.
- This prevents pasted multiline text from auto-submitting terminal input via implicit Enter.
- Both desktop and mobile terminals capture paste events in the capture phase before xterm or native handlers process them.
- Desktop paste sends small input directly and chunks larger paste payloads into bounded frames with WebSocket backpressure, reducing browser main-thread stalls from large clipboard pastes.

Terminal rendering performance:

- Desktop terminal output from Herdr is queued and coalesced once per animation frame before being written to xterm.
- This reduces CPU use for rapid terminal refresh workloads, spinner-like carriage-return updates, and command output bursts.
- Browser scroll-follow state and terminal resize/focus work are also scheduled with the terminal frame batch instead of every raw WebSocket message.

Terminal scroll:

- Wheel scroll speed is configurable in Settings under `Terminal input` with the `Scroll speed` slider.
- Small trackpad wheel deltas are accumulated before sending scroll commands, preventing tiny events from each scrolling a full line batch.
- In normal terminal scrollback, scrolling up pauses follow mode and keeps the same viewport position even when new output arrives.
- When follow mode is paused, a `Tail` button appears. Clicking it scrolls to the latest output and re-enables follow mode.
- Mobile terminal uses the same scrollback follow behavior and `Tail` button as desktop.
- In alternate-screen terminal apps, wheel and PageUp/PageDown scroll events are sent to the backend terminal application instead of local browser scrollback.

Terminal font:

- Configure in Settings under `Terminal input` with `Terminal font`.
- Use any installed CSS font family, including Nerd Fonts commonly used by Neovim, for example `JetBrainsMono Nerd Font, monospace` or `MesloLGS NF, monospace`.
- Browsers can only render fonts installed on the local machine.

Search palette:

- Open search from the top-right `⌕` button or with the keyboard prefix then `/`.
- Search is local and in-memory over currently loaded workspaces, repos, worktrees, labels, panels, and agents.
- Results include workspace (`ws`), worktree (`wt`), panel (`pn`), and agent (`ag`) entries.
- Use `Enter` to open the selected result, arrow keys to move selection, and `Esc` to close.
- Search result navigation always targets a concrete panel when one is available.

Keyboard shortcuts:

- Enable or disable from Settings under `Agents and alerts` with `Global keyboard shortcuts`.
- Press configured prefix (`Ctrl+B` by default) to open the WebUI shortcut prefix overlay. The next shortcut key is handled by WebUI and not sent to the terminal; `Esc` cancels.
- Change the prefix in Settings with `Shortcut prefix` → `Record`.
- Prefix shortcuts work from the terminal and UI and can be remapped from the shortcuts window with collision detection. Defaults are: prefix then `/` search, `?` shortcuts help, `S` settings, `B` sidebar, `N` new workspace, `P` new panel, `W` worktrees, `T` create worktree, `X` close panel, `Shift+X` close workspace/worktree, `Delete`/`Backspace` remove linked worktree, `A` next agent by blocked/done/idle/working priority, `Shift+A` previous agent by reverse priority, `J/K` workspace navigation, `[/]` panel navigation, `F` terminal focus, and `,/.` focus navigation.
- Optional direct search shortcuts can be configured in Settings. They are disabled by default to avoid conflicts with terminal applications.

## Install

Install as a per-user macOS LaunchAgent:

```sh
make install-mac
```

Run macOS LaunchAgent commands as your normal user, not with `sudo`. LaunchAgents load into the current user's `gui/$UID` launchctl domain; running with `sudo` targets root's domain and is rejected.

Install as a per-user Linux systemd service:

```sh
make install-linux
```

Release binaries can install themselves too:

```sh
./herdr-webui install-mac
./herdr-webui install-linux
```

For macOS service troubleshooting:

```sh
./herdr-webui install-mac --verbose
./herdr-webui uninstall-mac --verbose
```

Update installed binary and restart service:

```sh
make update-mac
make update-linux
```

Uninstall service:

```sh
make uninstall-mac
make uninstall-linux
```

## FAQ

### `herdr rejected terminal connection: client version 15 is newer than server version 13; please upgrade the herdr server`

This means WebUI is using a newer terminal attach protocol than the Herdr server process handling the session. WebUI retries protocol 14 automatically when a protocol 15 handshake reaches a compatible protocol 14 server, so seeing this error usually means the running Herdr server is older than WebUI's fallback range or failed after the fallback retry.

Check two things:

- Verify the `herdr` binary version in `PATH`, or the binary set through `HERDR_WEB_HERDR_BIN`.
- Make sure old Herdr server sessions are not still running. Updating the `herdr` binary does not upgrade already-running session processes; close all running Herdr sessions, then start them again with the updated binary.

### macOS blocks the downloaded binary

If macOS blocks the release binary because it was downloaded from the internet, remove the quarantine attribute and make it executable:

```sh
sudo xattr -d com.apple.quarantine herdr-webui
chmod +x herdr-webui
```

Run those commands from the directory containing the downloaded `herdr-webui` binary, or pass the full path to the file.

## Release Policy

WebUI releases use SemVer `v*.*.*` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
