# Release notes

### Zed-style Git log

- Rebuilds the desktop Git log into a Zed-inspired four-column table with graph lanes, description/ref chips, date, and author. The configured default branch is shown first and colored blue; the current branch is highlighted in red.
- Adds hover details with full hash, exact commit date/time, author, branches/tags, and title, plus local filters for description, date, and author.
- Adds a bottom `Load more changes` button. The backend returns `has_more` and `limit` by fetching one extra commit, and the UI increases history in 80-commit pages up to a safe cap.

## 0.2.50 Release Notes

### Startup and default folder behavior

- Built-in backend sessions now start empty. Opening WebUI no longer creates a default workspace, shell, tab, or pane until the user explicitly opens a workspace/worktree, starts an agent, or opens a temporary terminal.
- Empty built-in snapshots render cleanly in the browser: terminal loading stops and stale tabs, panes, agents, and terminal selection are cleared.
- Workspace/worktree opening, worktree discovery, Git directory picking, file browser, and temporary terminals consistently use the configured default folder when no workspace/worktree is selected, instead of falling back to `/`.

### Git directory picker and help

- Simplifies the Git directory selector to one folder action. Choosing a folder moves the Git drawer to that folder and refreshes; branch checkout is now a separate `Switch branch` action inside that selected Git directory.
- Adds a `↩` action next to the Git Refresh button when the Git drawer is looking at a folder different from the current workspace/worktree. It returns Git to the active workspace/worktree folder, clears stale diff/file selection state, and refreshes.
- Updates the global `?` Help & Shortcuts modal and the Git shortcut help popup with the new Git folder semantics, return-to-workspace action, and default-folder startup behavior.

## 0.2.39 Release Notes

### Built-in backend and TUI foundation

- Makes the built-in backend the default for fresh WebUI settings while keeping external Herdr as an explicit compatibility mode.
- Adds the first-party `herdr-webui-tui` binary over the reusable `backend_client` layer and built-in sockets. It supports workspace/agent navigation, live terminal attach, input, paste, resize, detach, summary smoke output, and one-shot text snapshots.
- Installs both `herdr-webui` and `herdr-webui-tui` from the macOS and Linux install/update targets.
- Improves Jcode detection with Herdr `jcode-support` manifest-style screen detection, process-tree fallback, and active background-task markers so status remains `working` while tasks are still running.
- Adds TUI terminal rewrite handling for Jcode progress/status lines plus ANSI SGR rendering for foreground/background colors, bold, dim, italic, and underline.
- Adds TUI theme modes matching Jcode's `system`, `light`, and `dark` shape. `system` follows terminal background detection and falls back to dark when unsupported.
- Documents current Herdr TUI parity gaps: layout mutation, scrollback copy/search, mouse/touch, worktree dialogs, configurable keymaps, notification integrations, typed TUI event wrappers, and durable built-in session persistence.

## 0.2.28 Release Notes

### Unified search and file explorer polish

- Unifies the header search across workspaces, worktrees, files, folders, and file-content search. Search sections are enabled, ordered, and persisted through browser settings so desktop and mobile share the same behavior.
- Moves file and folder filtering out of the file explorer input and into the shared header search. Backend file/folder/content APIs do the traversal and matching work, while the frontend renders filtered trees, grouped content results, and editor jumps.
- Content search results group matches by file, lazy-load expanded matches when needed, open the complete file at the matching line, and support snippet editing with explicit save controls.
- Match previews now use Git-diff-style arrow controls for expanding context above or below and stronger highlighted match text with shared theme tokens.
- Content search styling is centralized in `src/assets/shared/content_search.css` and `src/assets/shared/colors.css`, keeping desktop and mobile CSS focused on layout instead of duplicated palette rules.
- Adds Settings-backed match-case and regex modes for backend file-content search, plus a shared editor find bar with match-case/regex search and edit-mode replace controls.

## 0.2.13 Release Notes

### Protocol 16 support

- Bumps the direct terminal attach protocol to 16 to match Herdr 0.7.3 and adds the `ServerMessage::PrefixInputSource` variant to `src/protocol.rs` so the new macOS prefix-mode ASCII input-source switch deserializes without breaking the stream. The web client ignores it because it has no host keyboard to switch.
- The terminal attach fallback now tries protocols 16, 15, and 14 in descending order. A protocol-15 Herdr server rejects a protocol-16 client with "newer than server version", and WebUI retries protocol 15, then 14, so a single WebUI build attaches to 0.7.3, 0.7.2, and 0.7.0+ servers.
- `/api/versions` reports protocol 16, min protocol 14, and max tested backend 0.7.3.

### Live layout snapshots

- Subscribes to the new `layout.updated` socket event so the desktop frontend keeps a per-tab `PaneLayoutSnapshot` cache current after pane split, resize, swap, move, zoom, and focus changes. Terminal sizing reads the cached layout first and only falls back to the per-pane `pane.layout` request when no cache exists, which avoids an extra round trip on every refresh.
- Exposes `/api/session-snapshot` proxying the backend `session.snapshot` method so the frontend can bootstrap workspaces, tabs, panes, layouts, and agents in one request.

### Legacy polling bootstrap moved to `legacy_polling.js`

- The pre-protocol-16 multi-request polling bootstrap (separate `workspace.list`, `tab.list`, `pane.list`, `agent.list`, and `pane.layout` requests plus the 5s events-socket polling snapshot) is moved to `src/assets/desktop/app_js/legacy_polling.js` with a deprecation annotation and a TODO to remove it once the official Herdr release with protocol 16 ships and `session.snapshot` + `layout.updated` are confirmed stable. The new snapshot-based bootstrap path lives in `core.js`.

### Git hunk editor compare alignment

- Uses the shared CodeMirror editor for both previous and current hunk panes so text metrics, wrapping, and syntax highlighting align.
- Keeps the previous pane read-only and moves its line numbers to the right side to match side-by-side compare expectations.
- Hides the backing textareas that store hunk values so the current pane does not show duplicated plain text below the highlighted editor.

## 0.2.11 Release Notes

### Terminal Nerd Font icons

- Uses the bundled JetBrainsMono Nerd Font stack when creating desktop xterm terminals so powerline and language icons render by default.
- Migrates the old desktop monospace terminal default to the bundled Nerd Font stack while preserving custom user font-family settings.
- Refreshes the desktop terminal after the web font loads so glyph metrics and icon rendering settle without reconnecting.

## 0.2.10 Release Notes

### HTTPS by default

- Serves WebUI over HTTPS by default.
- Generates and reuses a per-user app self-signed certificate at `~/.config/herdr/tls/self-signed-cert.pem` and `self-signed-key.pem` when no certificate files are available.
- Keeps generated certificates independent from repos and worktrees, so restarts and reinstalls reuse the same local certificate until those files are deleted.
- Adds `--https off|auto|self-signed|files` plus `--tls-cert` and `--tls-key` for opting out or using external certificates such as Let’s Encrypt files.
- Persists TLS options in macOS LaunchAgent and Linux systemd install/update flows.

## 0.2.9 Release Notes

### Workspace and worktree opening

- Replaces separate workspace/worktree entry points with one `open-worktrees` action that opens the unified workspace/worktree modal.
- Prefills the modal from the current workspace or linked worktree path and immediately discovers Git worktrees and branch options when the folder is a Git repo.
- Keeps branch suggestions populated for Git repos so creating a linked worktree has base-branch options without needing a separate create modal.
- Moves the workspace creation form below worktree creation and places the workspace name field inside the workspace section for clearer flow.

### Worktree creation safety

- Renames and compacts the pull-before-create checkbox to clarify that it only attempts a fast-forward base update.
- When Git reports diverging branches or another fast-forward-only failure, WebUI now shows a confirmation modal to continue creating the worktree without pulling instead of suggesting merge or rebase commands.

### Shared refresh controls

- Extracts the refresh icon styling into an app-wide `app-refresh-icon` component and uses it in the Git drawer, file browser, and worktree modal refresh control.

## 0.2.8 Release Notes

### Terminal paste

- Restores browser paste in desktop and mobile terminals when the connected Herdr backend does not process semantic paste input events.
- Keeps the large-paste performance fix by continuing to capture browser `paste` events before xterm native paste handling, avoiding xterm's synchronous `terminal.paste(text)` path.
- Sends pasted text through the existing bounded raw input queue with 16 KiB chunks and WebSocket backpressure, so large clipboards do not become one huge browser frame.
- Preserves pasted newlines while normalizing CRLF/CR to LF before forwarding to the terminal.
- Leaves server-side semantic paste message parsing in place for compatible clients, but WebUI's browser terminal path now uses the backend-compatible raw input transport.

## 0.2.7 Release Notes

### Panel and workspace close

- Closing the last panel in a workspace now closes the workspace through Herdr's `workspace.close` API instead of calling `tab.close`, which Herdr rejects for the last tab.
- WebUI reconciles the active panel after panel or workspace close events so it switches to a valid remaining pane instead of keeping stale selected panel state.
- When Herdr reports `pane.exited`, WebUI closes the pane through the backend and refreshes the active route so terminal exits do not leave dead panels selected.

### Terminal scroll and follow

- Desktop terminal scrolling now preserves browser/xterm layout ownership while explicitly handling wheel input where needed.
- Scrolling up pauses follow mode, new output preserves the current viewport, and the `Tail` button jumps back to latest output and resumes follow.
- Wheel scroll speed is configurable in Settings → Terminal input. Small trackpad deltas are accumulated before sending scroll commands.
- Alternate-screen terminal apps receive wheel and PageUp/PageDown scroll events through the backend instead of local browser scrollback.
- Mobile terminal mirrors the same scrollback follow behavior and `Tail` button as desktop.

### Terminal paste

- Large terminal paste avoids xterm `paste()` and sends bounded WebSocket input chunks so very large clipboards do not freeze the browser.
- Desktop and mobile paste paths share this behavior. Normal typed input, Shift+Enter, scroll, and resize keep their existing paths.

## 0.2.6 Release Notes

### Sidebar and agents

- Agents sidebar sorting is configurable in Settings → Agents and alerts. Status groups can be reordered with up/down controls and are saved in browser-local settings.
- Agent status groups use explicit colors in settings: idle green, working yellow, blocked red, done blue, and others gray.
- The Workspaces/Agents sidebar split is resizable by dragging the separator, snaps to whole percent values, and can also be set directly in Settings → Agents and alerts.

### File browser and editor

- File browser search now supports file or folder mode with `Alt+F` / `Alt+D` switching. Folder search uses breadth-first backend traversal so shallow matching folders are found before deep unrelated trees exhaust the search cap.
- File/folder searches keep parent breadcrumbs, match highlighting, scroll/focus preservation, and paginated loading. Filtered file results render the folder chain above matching files, not a flat list, so users can see each result path in context.
- File browser rename/delete updates the visible tree in place where possible instead of forcing a full list reload.
- Text file previews open immediately in the same CodeMirror-backed editor shell as edit mode, including syntax colors, line numbers, fold gutter, keyboard folding, selection, and active-line styling. The preview instance is read-only, so editing text and saving remain available only after pressing Edit. Users can toggle line numbers with Settings → File browser → File browser line numbers, and the lightweight HTML preview is only used if CodeMirror fails to load.
- CodeMirror-backed file editors expose a fold gutter and folding shortcuts for languages that provide fold ranges, including common brace/block-based modes like JavaScript, TypeScript, Rust, Go, JSON, CSS, HTML, XML, YAML, Java, SQL, Markdown, and Python.
- The editor uses dedicated `--editor-bg` and `--editor-syntax-*` theme colors so syntax highlighting stays readable independently from panel surfaces. Dark mode uses a high-contrast Catppuccin-style palette: keywords mauve, functions blue, strings green, numbers peach, types yellow, comments light slate, properties cyan, and invalid tokens red. Light mode uses matching Latte-style colors.

### File browser Git status propagation

- `src/file_browser.rs` computes Git file and directory status before sending tree/search data. It runs one `git status --porcelain=v1 --untracked-files=all` refresh per API request when status colors are enabled, normalizes paths from repo-relative to workspace-relative, and sends a status map consumed by desktop and mobile file trees.
- Directory status is propagated on the backend by walking each changed path's parent folders. The priority is `deleted` red > `modified` yellow > `added`/`untracked` green, so one deleted file keeps every parent red even if sibling folders contain modified or new files.
- Refreshing the file browser triggers a new backend tree request and recalculates the Git status map. The frontend only applies returned statuses, avoiding duplicate client-side propagation logic.

### Git UI

- Git drawer actions now include pull and push modals. Pull supports regular, rebase, fast-forward-only, no-fast-forward, and force pull options. Push supports regular, force-with-lease, and force push options.
- Commit view adds `Commit & Push`; if the push is rejected, WebUI opens the force-push modal so the user can choose a safer force-with-lease retry or explicit force push.
- Rebase now opens a branch selector and includes a `First pull selected branch before rebasing` checkbox before running the rebase.
- Conflict resolution buttons use clearer `Use HEAD`, `Use branch`, and `Mark resolved` labels. Conflict view also exposes rebase continue, skip, and abort controls.
- Git diffs can be toggled between side-by-side and unified layouts globally. Unified diffs preserve add/delete highlighting and compare mode stays selected across refreshes.
- The Git drawer refresh control moved beside the Git title as a rounded icon and spins for two seconds after pressing. Styling uses theme variables so light/dark/custom themes inherit the right colors.

### Terminal

- Desktop terminal scrolling now prefers Herdr backend scroll messages over local xterm scrollback. Wheel, touch, PageUp, and PageDown send `{type:"scroll"}` over the terminal WebSocket first, then fall back to local `term.scrollLines()` only when the backend path is unavailable.
- The desktop terminal shell keeps browser scrolling disabled with `.terminal-shell { overflow: hidden; }` and leaves xterm internals to the vendor stylesheet. `fitTerminalSurface()` resets stale shell scroll offsets during reconnect/resize so tab switches attach at the live bottom instead of a browser-scrolled offset.
- The Tail button appears after the user scrolls up. Pressing it sends a backend tail burst, hides the button, focuses the terminal, and resumes the latest output view without any write-time viewport preservation.
- Settings → Terminal → Scroll speed controls desktop wheel sensitivity. Trackpad pixel deltas are accumulated to row height before scroll messages are sent, which avoids one backend scroll for every tiny trackpad event.
- Mobile keeps its existing shared `src/assets/shared/terminal_scroll.js` local-scroll helper and follow-button path. Desktop and mobile remain separate because desktop needs backend-first scrolling for Herdr/Jcode terminal rendering while mobile still uses xterm local scrollback behavior.

## 0.2.5 Release Notes

### Compatibility

- Marks Herdr 0.7.2 as the maximum tested backend so current protocol 15 installs report as compatible.

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
- `fileBrowserLineNumbers` stored in browser `localStorage`, defaults to enabled, and applies to desktop and mobile file previews.

## Release Policy

WebUI releases use SemVer `v*.*.*` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
