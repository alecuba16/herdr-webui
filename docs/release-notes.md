# Release notes

## 0.2.80 Release Notes

### Browser terminal renderer migration

- Replaces xterm.js with the shared wterm terminal renderer adapter across desktop, mobile, and temporary terminals.
- Adds Settings-backed renderer selection between wterm and Ghostty, with embedded wterm JS/CSS and Ghostty WASM assets.
- Preserves terminal theme/font behavior, URL link detection, bounded paste chunking, Tail/follow behavior, and terminal query-reply filtering on the new renderer stack.
- Detects unsupported iTerm2, Kitty, and SIXEL inline image graphics sequences in wterm output and replaces them with a short chafa fallback hint instead of leaking raw control/base64 data into terminal scrollback.
- Makes terminal mouse reporting opt-in, strips accidental mouse reports by default, and keeps normal text selection safe.
- Improves terminal wheel, trackpad, PageUp/PageDown, scrollback, and viewport fitting behavior for main and temporary terminals.
- Removes stale xterm/static scroll loading from the current boot path while keeping a compatibility shim for cached older boot scripts.
- Documents the browser terminal feature set in docs and Help, including renderer selection, Tail behavior, scroll semantics, copy/paste, mouse reporting, and temporary terminal shortcuts.

### Workspace shell and file explorer UX

- Restores the valuable PR #90 workspace shell improvements on top of the wterm code path: Terminal, Git, and Files shell modes are remembered per workspace/worktree, with minimize/restore state scoped to that workspace.
- Adds focused editor find routing: `Cmd/Ctrl+F` opens the active file editor find/replace when focus is inside a file editor, opens global WebUI search elsewhere, and leaves terminal `Ctrl+F` as terminal input.
- Shares file tree styling across desktop file browser and directory picker, keeps search result opens additive as file tabs, and avoids Git branch lookup for non-Git browse folders.

## 0.2.78 Release Notes

### Browser hot-path and terminal reply filtering

- Reduces desktop browser work on frequent refreshes by memoizing the workspace sidebar render signature and reusing the previous sidebar HTML when workspace, worktree, panel, shortcut, and selection inputs have not changed.
- Moves terminal renderer OSC color-query reply filtering into the shared terminal helper and applies it to desktop, mobile, and temporary terminal input paths. This strips `OSC 10/11/12` and palette color replies, including split and bare `10;rgb...`/`11;rgb...` fragments, before they can echo into shell input.
- Keeps ordinary terminal input safe while filtering query replies, with regressions for numeric keys and Escape so normal shell/TUI input is not delayed.

### Temporary terminal and Git cleanup

- Keeps temporary terminals focused while visible by trapping Escape, Tab, and Backspace before browser focus shortcuts, global shortcuts, or the Git drawer can consume them.
- Starts temporary terminals in the current, single, or visible workspace/worktree when possible. WebUI creates a temporary workspace from the configured default folder only when no workspace is available.
- Makes the temporary terminal body and xterm layers fill the modal height without the previous padding gap.
- Allows Git Cleanup to select the primary repository's current non-`main`/`master` branch. The backend checks out `main` or `master` first, then deletes the selected branch, while keeping the current `main`/`master` branch protected.
- Shows whether each cleanup branch or worktree branch appears to have been pushed before (`pushed before`, `not pushed`, or `push status unknown`).
- Shows conflict resolution actions (`Use HEAD`, `Use parent`, `Use remote`, and `Mark resolved`) in conflicted file headers for both unified and side-by-side Changes diffs.
- Keeps unified and side-by-side diff mutation behavior aligned by hiding block-restore controls in large diff previews until the full diff is rendered.
- Keeps the Git file toolbar visible while scrolling diff/editor content and adds per-conflict-block `Use HEAD`, `Use parent`, and `Use remote` controls inside the side-by-side hunk editor.

## 0.2.77 Release Notes

### File explorer tabs, worktrees, and Git cleanup polish

- Restores File Explorer multi-file tabs and keeps opening files from search additive, preserving the current folder and existing open files while supporting matched-line jumps.
- Compacts File Explorer open-file tabs, removes the duplicated pane header, adds horizontal scrolling for many tabs, and shows hover paths relative to `~` when inside the home directory or absolute from `/` otherwise.
- Sorts discovered worktrees by recent activity, shows latest commit dates, and switches Git branch selection to an existing worktree directory when that branch is already checked out there.
- Reduces browser work by moving worktree activity sorting/enrichment to the backend and caching repeated frontend search/render helpers.
- Improves Git log labels and commit handling with full hover labels and a copy-commit-id action.
- Updates Git Cleanup so branches checked out in linked worktrees appear only as worktree removal entries, avoiding duplicate branch-delete choices.

## 0.2.76 Release Notes

### File explorer, Git actions, and terminal selection fixes

- Adds right-click Copy permalink actions to the File Explorer and Git file views for immutable remote links.
- Fixes File Explorer context menu clicks so Rename, Copy permalink, and other actions execute reliably.
- Shows loading states while Git and worktree operations run.
- Makes terminal mouse reporting opt-in and keeps normal terminal text selection available by default, including after TUIs such as Jcode enable terminal renderer mouse mode.
- Moves the file find magnifier to the file editor pane and keeps editor search shortcuts focused on file contents.

## 0.2.75 Release Notes

### Git side-by-side editor polish

- Fixes the Git side-by-side hunk editor to keep horizontal scrolling synchronized between previous and current panes inside each hunk.
- Uses CodeMirror line decorations for original red/green diff indicators instead of post-render DOM line class mutation.
- Keeps yellow highlighting limited to lines changed during the current edit session, while preserving the original red/green change markers.
- Removes the pane-wide yellow left border from the editable current side so the left border continues to represent the original diff state.

## 0.2.61 Release Notes

### Frontend parity and hot path efficiency

- Adds shared frontend search-order normalization so desktop and mobile settings use one implementation and the behavior stays aligned.
- Fixes mobile multi-backend routing parity by sending the selected backend for HTTP requests and WebSocket connections.
- Reduces hot-path overhead in built-in backend process-tree traversal by using set-based visited tracking.
- Documents the code-quality audit baseline, remediated issues, and deferred risks for follow-up refactors.

## 0.2.60 Release Notes

### Built-in backend detection docs

- Documents the expanded built-in backend agent identity and screen-status detection coverage in the README, feature docs, and technical docs.
- Clarifies that the built-in backend mirrors Herdr screen-manifest visible `blocked`, `working`, and `idle` signals where terminal text exposes them, while OSC-only or metadata-only Herdr signals remain outside the screen-text fallback.

## 0.2.59 Release Notes

### Built-in backend agent detection parity

- Expands built-in backend screen detection beyond Jcode and OpenCode to cover the same visible blocker, working, and idle patterns used by Herdr's screen-manifest agents where those signals are available from terminal text.
- Aligns Jcode and OpenCode edge cases with Herdr: Jcode background task cards no longer stay `working` after the prompt returns, Jcode braille spinners require spinner-plus-space text, and OpenCode interrupt hints now match the stricter `opencode ... esc interrupt` shape.
- Adds focused detection coverage for Amp, Antigravity, Claude, Cline, Codex, Cursor, Devin, Droid, Gemini, GitHub Copilot, Grok, Hermes, Kilo, Kimi, Kiro, Maki, OpenCode, Pi, Qoder CLI, and Jcode.

### Default folder startup hotfix

- Prevents WebUI startup from blocking before the listener binds when macOS stalls while checking the configured default folder, for example protected folders like `~/Documents`. Startup now uses a bounded readability check and falls back to `~`; explicit settings changes can still trigger the normal permission prompt.

### Zed-style Git log

- Rebuilds the desktop Git log into a Zed-inspired four-column table with graph lanes, description/ref chips, date, and author. The configured default branch is shown first and colored blue; the current branch is highlighted in red.
- Adds hover details with full hash, exact commit date/time, author, branches/tags, and title, plus local filters for description, date, and author. The graph column is intentionally not filterable so lane context stays stable.
- Keeps the log scope row, table header, and filter row sticky while scrolling so selected refs and column meaning remain visible.
- Moves selected-commit actions into one compact action strip: `Compare`, `Tag`, `Worktree…`, `Reset`, `Rebase…`, and `Clear`. `Worktree…` creates a linked worktree from the selected branch after confirming branch, base, and directory details.
- Adds a bottom `Load more changes` button. The backend returns `has_more` and `limit` by fetching one extra commit, and the UI increases history in 80-commit pages up to a safe cap. File browser `Show history` opens the Git log scoped to the file, and selecting a commit shows a `Committed files` side preview that opens commit-vs-parent diffs.

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

- Uses the bundled JetBrainsMono Nerd Font stack when creating desktop browser terminals so powerline and language icons render by default.
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
- Keeps the large-paste performance fix by continuing to capture browser `paste` events before native terminal paste handling, avoiding terminal renderer's synchronous `terminal.paste(text)` path.
- Sends pasted text through the existing bounded raw input queue with 16 KiB chunks and WebSocket backpressure, so large clipboards do not become one huge browser frame.
- Preserves pasted newlines while normalizing CRLF/CR to LF before forwarding to the terminal.
- Leaves server-side semantic paste message parsing in place for compatible clients, but WebUI's browser terminal path now uses the backend-compatible raw input transport.

## 0.2.7 Release Notes

### Panel and workspace close

- Closing the last panel in a workspace now closes the workspace through Herdr's `workspace.close` API instead of calling `tab.close`, which Herdr rejects for the last tab.
- WebUI reconciles the active panel after panel or workspace close events so it switches to a valid remaining pane instead of keeping stale selected panel state.
- When Herdr reports `pane.exited`, WebUI closes the pane through the backend and refreshes the active route so terminal exits do not leave dead panels selected.

### Terminal scroll and follow

- Desktop terminal scrolling now preserves browser/terminal renderer layout ownership while explicitly handling wheel input where needed.
- Scrolling up pauses follow mode, new output preserves the current viewport, and the `Tail` button jumps back to latest output and resumes follow.
- Wheel scroll speed is configurable in Settings → Terminal input. Small trackpad deltas are accumulated before sending scroll commands.
- Alternate-screen terminal apps receive wheel and PageUp/PageDown scroll events through the backend instead of local browser scrollback.
- Mobile terminal mirrors the same scrollback follow behavior and `Tail` button as desktop.

### Terminal paste

- Large terminal paste avoids terminal renderer `paste()` and sends bounded WebSocket input chunks so very large clipboards do not freeze the browser.
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

- Desktop terminal scrolling now prefers Herdr backend scroll messages over local terminal scrollback. Wheel, touch, PageUp, and PageDown send `{type:"scroll"}` over the terminal WebSocket first, then fall back to local `term.scrollLines()` only when the backend path is unavailable.
- The desktop terminal shell keeps browser scrolling disabled with `.terminal-shell { overflow: hidden; }` and leaves terminal renderer internals to the vendor stylesheet. `fitTerminalSurface()` resets stale shell scroll offsets during reconnect/resize so tab switches attach at the live bottom instead of a browser-scrolled offset.
- The Tail button appears after the user scrolls up. Pressing it sends a backend tail burst, hides the button, focuses the terminal, and resumes the latest output view without any write-time viewport preservation.
- Settings → Terminal → Scroll speed controls desktop wheel sensitivity. Trackpad pixel deltas are accumulated to row height before scroll messages are sent, which avoids one backend scroll for every tiny trackpad event.
- Terminal scroll handling now lives with the active terminal renderer adapter and fit helpers. New boot scripts no longer load the old standalone scroll helper, while the route remains as a compatibility shim for cached older boot scripts.

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

- Restored native terminal wheel scrolling by removing the custom terminal shell wheel handler.
- Enabled terminal renderer viewport scrolling so terminal scrollback uses terminal renderer's own viewport behavior.
- Switched terminal shells to dynamic sizing with no inline shell height or width.
- Removed the custom terminal context menu so browser/terminal renderer defaults handle context actions.
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
- Fixed terminal viewport overflow from `visible` to `hidden` to prevent unwanted vertical scrollbar.

### Focus preservation

- Tab and panel rename inputs no longer lose focus when terminal output triggers a re-render. The workspace sidebar `innerHTML` update is now guarded when any rename input is active (`editingTab` or `editingWorkspace`).

### Settings

- New `File browser` settings section with tree indentation, parent folders toggle, and Git status colors toggle.
- `fileBrowserGitStatus` stored in browser `localStorage`, defaults to enabled.
- `fileBrowserLineNumbers` stored in browser `localStorage`, defaults to enabled, and applies to desktop and mobile file previews.

## Release Policy

WebUI releases use SemVer `v*.*.*` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
