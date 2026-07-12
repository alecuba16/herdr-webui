# Features

## WebUI Features

The browser UI provides workspace navigation, top panel tabs, agent status, terminal attach, Git views, file browsing/editing, and local-only convenience settings stored in browser storage.

Sidebar:

- The sidebar can collapse via the divider; state is stored in browser `localStorage` and collapsed mode keeps compact blocked/working/idle/done counters.
- The header exposes unified Search, Theme, No-sleep, Worktree, New workspace, Git, and Files controls. The footer exposes session info, shortcut help, and Settings.
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
- Unified search settings are stored in browser `localStorage` under `herdr-web-options`. They enable/disable workspace, file, folder, and content sections independently, and `searchSectionOrder` controls the order of sections in the search palette.
- Opening Settings clears the previous search, refreshes option values, reloads server settings, and focuses the search box. Settings → Backend controls `backend_mode`; fresh settings default to built-in, while external Herdr and auto modes remain available for compatibility.

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

- Built-in backend mode owns `worktree.list`, `worktree.open`, and `worktree.create` with local Git commands. Built-in `worktree.remove` is intentionally blocked until destructive safety validation lands.
- With external Herdr `0.7.1` and newer, WebUI uses Herdr's native `worktree.create` support for existing local branches and deferred Git work.
- With external Herdr `0.7.0`, WebUI keeps a legacy fallback for creating a checkout from an existing branch when a checkout path is supplied.
- Desktop worktree creation uses `Worktree default directory` to generate checkout paths from repo name and branch. Relative defaults resolve from the repo root, for example `../worktrees`.
- With event-capable external Herdr backends, WebUI subscribes to `worktree.created`, `worktree.opened`, and `worktree.removed` and refreshes workspace/agent state quickly after these events. Built-in mode currently acks the event subscription and relies on snapshot refresh fallback until the event hub lands.
- `worktree.removed` events from Herdr `0.7.1` may include a workspace snapshot. This is additive; WebUI refreshes from the backend state instead of relying only on the event payload.
- Linked worktree cards use the branch name as the main title and show a custom worktree label as a small label chip when one exists.
- Agent rows prefer the linked worktree custom label, so running agents are easier to scan across many branches.
- Worktree groups avoid duplicate repo headers when the parent workspace card is already visible.
- Removing a linked worktree is available from the worktree actions and from the keyboard prefix `Delete` shortcut when the active backend supports safe removal. Built-in mode currently returns an explicit unsupported error for worktree remove until destructive validation is implemented.

File browser:

- Desktop workspaces and linked worktrees include a file explorer opened from the sidebar Files button. Git, Files, and terminal views are mutually exclusive foreground modes.
- Desktop uses authenticated `/api/file-browser/*` routes for tree, preview, edit/save with hash guard, rename, delete, and contextual open/split/copy actions. Mobile has read-only browse/preview parity.
- Folders are lazy-loaded and collapsed by default. Double-click enters a folder as root; `...` moves upward and is always visible when a parent directory exists, on desktop, mobile, and the directory picker. File rows use license-safe type glyphs based on special filenames and file extensions. Folder rows keep the plain folder icon and only change color when backend Git status marks them changed. The file browser Refresh button is a rounded icon that spins while loading.
- Files open in the active preview pane; Shift-click or context `Open in split` opens another pane. Dirty edited files ask before closing. The file explorer keeps an in-memory state per open workspace/worktree, including selected file, search selections, split panes, and unsaved edit drafts while switching panels. Closing that workspace/worktree forgets the cached state.
- Desktop and mobile use the header magnifier and the WebUI search shortcut as the single search entry point. The palette can show collapsible sections for workspaces/worktrees/panels, file names, folder names, and file contents for the focused workspace/worktree. The workspace/worktree section appears only after a non-empty query and matches repo names, tags, branches, panel names, agents, and labels. Section enablement, default content-result expansion, and section ordering are configurable in Settings.
- File/folder sections always call `/api/file-browser/tree?q=&offset=&limit=` in the backend, lazy-load pages, highlight matches, show parent folder context as an expanded tree, and preserve the file tree path instead of flattening results. `fileBrowserSearchPageSize` controls the backend page size. `Alt+F` switches the active path section to files, `Alt+D` switches it to folders, and `Alt+1/2/3` collapses or expands the workspace, files, and content sections.
- Content search runs only after the configured minimum characters, scans in the backend, supports Settings-backed match-case and regex modes, groups results once per file, shows matching lines expanded or collapsed according to Settings, lazy-loads additional file groups and full per-file matches, shows colored match text plus colored matched-line context, and uses Git-diff-style arrow controls to request more context above or below. `Alt+↑` and `Alt+↓` expand context for the selected content match. Expanded context rows merge when they overlap adjacent matches, similar to Git diff context expansion. Opening a match opens the file in the file explorer at the matched line with editor highlight.
- File browser Git status colors are enabled by default and can be toggled in Settings under `File browser git status colors`. When enabled, the backend colors file and directory entries by propagated Git status: red for deleted, yellow for modified/conflicted, and green for new/untracked, with priority red > yellow > green for parent folders.
- The directory picker (Browse buttons in Git UI) includes the same debounced search and always-visible `...` go-up entry as the file browser. Go-up transitions from home (`~`) to filesystem root (`/`) when at the top of the home directory.
- File tree indentation is configurable with `Tree indentation` and shared with Git file trees. Search defaults are configurable: search section enablement, section order, file/folder lazy page size, content-search minimum characters, content-search page size, context lines, auto-collapse threshold, initial matches per file, match-case mode, and regex mode.
- Text previews include an editor find bar with next/previous, match-case, and regex search. Edit mode enables replacement controls for one match or all matches; read-only preview keeps replace disabled.

Git UI:

- Desktop has an embedded Git drawer backed by Rust API routes and the system `git` CLI; no Node/React/Vite runtime is needed. Mobile has read-only grouped Git status.
- The drawer blanks hidden DOM to reduce browser work and owns keyboard input while visible so terminal keystrokes do not leak through.
- Core views cover status, commit, commit & push, pull, push/force-push, log, stash, cleanup, file history, conflicts, blame, hunk editing, side-by-side diffs, branch switching, and worktree actions.
- File lists are collapsible trees with optional filename-only mode, line counts, filtering, yellow match highlighting, and stable scroll while filtering/expanding. The file filter sits below the Git action toolbar so the exclusive view selector and actions stay visually grouped. Right-click and section actions support stage/unstage/discard/stash with confirmations.
- Changes, log, stash, and cleanup use a segmented exclusive toggle like the workspace shell-mode controls because only one Git view is shown at a time.
- Cleanup scans `Exploration default directory` or a chosen root for Git repositories, does not follow symlinked directories, caps traversal, and reports truncation. Results render as a nested repo list (`repo -> branches/worktrees -> items`) with checkbox multi-select, one confirmation modal, and the shared broom cleanup icon.
- Cleanup deduplicates worktrees: linked worktrees that share a base repository resolve to that repository and no longer appear as separate entries.
- Cleanup supports worktree pruning via a dedicated API endpoint with dry-run and expiry options, capturing pruned paths from Git verbose output.
- Cleanup uses safe delete first: `git branch -d` or `git worktree remove`. It retries force only when Git says force is required. Current branches are disabled, and primary/main worktrees are hidden from cleanup results.
- Large diffs use placeholders, per-file lazy loading, selected-file line limits, and safe previews before full DOM-heavy render. Mutating hunk/block actions are disabled while hidden lines are omitted.
- Diffs include collapse/show-all, change grouping, inline word highlights, context expansion, hunk stage/unstage/restore, blame, syntax highlighting for common languages, and side-by-side hunk editing with hash guard saves.
- Git status reports `ahead` and `behind` counts relative to the upstream branch using porcelain v2 branch tracking.
- Status and conflict endpoints collect non-fatal Git warnings instead of silently dropping errors, returning a `warnings` array so the UI can surface partial failures.
- Git log returns structured commit data (`hash`, `author`, `date`, `message`) alongside graph lines, with null-byte separators handled server-side so desktop graph rendering stays clean.
- Pull, push, force-push, and rebase actions use modal flows with branch selectors. Rebase can pull the selected branch first, and commit view can commit then push with a force-push retry modal on rejection. The Git refresh action is a theme-aware spinning icon beside the Git title. File view includes an inline Unified/Side-by-side toggle, and unified diffs use the same intra-line word highlighting as side-by-side diffs.
- Conflicts expose `Use HEAD`, `Use branch`, and `Mark resolved` per file, plus rebase continue, skip, and abort controls when resolving a rebase.
- Log supports single-commit compare/reset/rebase and shift-click two-commit compare. File history can show a temporary read-only commit diff or jump to the log commit.
- Git shortcuts share the WebUI prefix (`Ctrl+B` by default) and have collision-checked recording. Main defaults: `1` changes, `2`/`C` commit, `3`/`L` log, `4` stash, `R` refresh, `G` stage/unstage all, `Y/U/D/Z` selected file actions, `H/M/E/O/V/I/0` history/blame/edit/compare/branch/focus/help.
- Mutating/destructive operations require confirmation and backend path/ref validation. API routes cover status, diff/compare, branches, cleanup, log, blame, file read/write/history, stashes, conflicts, stage/unstage/discard/stash, switch/reset/rebase/pull/push/commit, apply-patch, and conflict actions.

Panel and workspace close:

- Closing the last panel in a workspace closes the workspace with the active backend `workspace.close` API instead of calling `tab.close`, because Herdr-compatible backends reject closing the last tab.
- Closing a workspace or linked worktree uses `workspace.close` to close all panels in that workspace.
- Closing a normal non-last panel still uses `tab.close`.
- When the active backend reports `pane.exited`, WebUI closes that pane through `pane.close` and switches away from it after refresh.

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

- Both desktop and mobile terminals capture browser `paste` events in the capture phase before xterm or native handlers process them.
- WebUI intentionally does not call xterm.js `terminal.paste(text)`. xterm parses that string synchronously on the browser main thread, which can freeze the UI for large code snippets.
- Browser paste is normalized through the shared helper in `/assets/shared/core.js`, preserving newlines while converting CRLF/CR to LF.
- Pasted text is sent through the same binary raw-input WebSocket path as typed input, but with bounded 16 KiB chunks and backpressure instead of one large frame.
- WebUI still accepts `{"type":"paste","text":"..."}` text WebSocket messages in `terminal_text_messages()` and maps them to semantic Herdr paste events for compatible clients. The browser terminal path uses bounded raw input for backend compatibility.
- Raw typed input, Shift+Enter, scroll, and resize messages keep their existing paths.
- The served bundles containing this logic are `/assets/desktop/app.js` for desktop and `/assets/mobile/terminal.js` for mobile.

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
- Prefix shortcuts work from the terminal and UI and can be remapped from the shortcuts window with collision detection. Defaults are: prefix then `/` search, `?` shortcuts help, `S` settings, `B` sidebar, `N` new workspace, `P` new panel, `W` worktrees, `T` create worktree, `X` close panel, `Shift+X` close workspace/worktree, `Delete`/`Backspace` remove linked worktree, `A` next agent by blocked/done/idle/working priority, `Shift+A` previous agent by reverse priority, `J/K` workspace navigation, `[/]` panel navigation, `F` terminal focus, and `,/.` focus navigation. Inside search, use arrows, Enter, Esc, `Alt+F`, `Alt+D`, `Alt+1/2/3`, and `Alt+↑/↓` for full keyboard access.
- Optional direct search shortcuts can be configured in Settings. They are disabled by default to avoid conflicts with terminal applications.
