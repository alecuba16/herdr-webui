# Herdr WebUI Architecture / Feature Inventory

## Purpose
Standalone browser UI for official Herdr backend sessions. Rust server proxies Herdr JSON API, direct terminal attach sockets, Git/file APIs, auth, and service install helpers. Frontend is embedded vanilla JS/CSS with split desktop/mobile assets and shared helpers.

## Core Areas To Preserve
- Sessions/workspaces: named Herdr sessions, session manager when backend offline, workspace create/open/close, workspace ordering, cwd enrichment from pane data, stale pane/tab cleanup from Herdr events.
- Worktrees: native Herdr worktree create/open/remove for Herdr 0.7.1+, legacy fallback for 0.7.0, linked worktree labels, branch/source handling, parent workspace close policy, worktree grouping and actions.
- Terminal desktop: xterm attach WebSocket, backend resize, configurable font/theme/scroll speed, optional terminal link detection, capture-phase paste sanitization, Shift+Enter newline, keyboard prefix isolation, normal scrollback pause/follow Tail button, alternate-screen backend scroll, PageUp/PageDown behavior.
- Terminal mobile: xterm attach, optional terminal link detection, capture-phase paste sanitization, bounded large-input chunks, normal scrollback pause/follow Tail button, viewport preservation when output arrives while paused.
- Performance safeguards: desktop terminal output frame coalescing per requestAnimationFrame, pending frame flush before close/reconnect, bounded paste frames/backpressure, adaptive no-sleep polling, Git drawer DOM blanking while hidden, large changes placeholders, per-file load-on-demand, large selected-file preview before full render, disabled hunk/block actions in preview mode.
- Load-time safeguards: CodeMirror, desktop Git UI, and desktop file browser JavaScript are lazy-loaded. Initial desktop/mobile terminal loads should not fetch editor/Git/File feature code until needed. Directory picker stays boot-loaded because workspace/worktree path inputs attach browse buttons during app binding.
- Git UI: status groups, filterable file trees with yellow match highlighting, staged/unstaged/untracked/conflicted lists, commit/stash/log/blame/file history/conflict routes, cleanup scanning for branches/worktrees, side-by-side diffs, hunk/block actions, syntax highlighting, shortcuts, destructive confirmations, path/ref validation.
- Git cleanup: desktop Git UI includes a cleanup tab for scanning a chosen directory for nested Git repositories. Backend scan discovers `.git` directory/file markers without following symlinked directories, returns local branches and `git worktree list --porcelain` rows, protects the primary worktree, and requires explicit confirmation for branch delete and worktree remove. Bulk cleanup uses safe delete first and retries force only when Git reports force is required.
- File browser/editor: authenticated tree/read/write/rename/delete APIs, backend search/filter with pagination, hash guard, dirty-close confirmation, lazy folders, split preview panes, parent-folder setting, shared indentation setting, mobile Files tab.
- Settings/search/shortcuts: grouped settings modal, Settings search field, local browser options, server access settings, no-sleep modes, browser notifications/sounds with configurable local tone volume, theme/accent vars, terminal font, terminal links, shortcut prefix editor/collision checks, search palette over loaded workspaces/worktrees/panels/agents.
- Notifications: desktop and mobile use browser-local options for `sound`, `soundScope`, `browserNotifications`, and `notificationVolume`. Permission is requested only from Settings when enabling browser notifications and is stored as enabled only on `granted`. Local attention tone defaults to gain `0.24`, clamps `0-1`, and keeps a tiny gain floor for Web Audio exponential ramps when slider is 0. `Sound` remains the true mute switch.
- Default directories: `worktreeDefaultDirectory` only drives generated worktree checkout roots; relative paths resolve from repo root and blank falls back to backend/default worktree directory. `explorationDefaultDirectory` prefills desktop new/open workspace paths, desktop worktree discovery paths, desktop Git cleanup scan roots, and mobile worktree discovery paths.
- Mobile UI: Workspaces, Agents, Panels, Worktrees, Files, Git, Terminal tabs; route compaction/expansion; terminal recreation after leaving/returning; agent attention sorting; 100dvh app shell; one-row horizontally scrolling bottom nav; min-width/min-height guards to keep terminal/file content inside screen. Mobile has read-only parity for Git status, Git file diffs, and file preview, but not full desktop Git mutations/log/stash/blame/history or editable split file panes. Mobile Git diff hunks must scroll horizontally inside the hunk body so long lines do not widen the app shell.
- Security/auth/service: localhost bypass setting, credential requirement for public bind, login cookie, auth checks on APIs/assets, macOS LaunchAgent and Linux systemd install/update/start/stop helpers.

## Recent Browser Load Optimisation Decisions
- Avoid idle /api/no-sleep polling when Off/server healthy; keep active/error retry paths.
- Coalesce rapid terminal output before xterm rendering to reduce script/layout CPU.
- Preserve terminal scrollback viewport when follow is paused; expose Tail button on desktop and mobile.
- Chunk large paste/input frames with WebSocket bufferedAmount backpressure.
- Guard large Git diffs with preview/full-render flow and disable mutating hunk/block actions for hidden lines.
- Keep mobile bottom navigation as a horizontal scroll strip, not a wrapping grid; wrapping creates a two-line bar and apparent page overflow on narrow screens.
- Avoid blocking initial load with CodeMirror/Git/File Browser bundles; use shared lazy script loader and feature-level lazy loading.
- Defer Git bulk action post-confirmation work with setTimeout so Chrome traces do not blend human confirm wait with API/render CPU.
- Split default directories so checkout generation and exploration/open/discovery/cleanup roots can be tuned separately.
- Run file search/filter in backend with bounded traversal, pagination, debounced UI input, result highlighting, and stable scroll/focus.
- Terminal links use xterm `registerLinkProvider`; desktop and mobile detect `http`/`https` URLs and open them in a new tab with `noopener,noreferrer`. Disabling `terminalLinks` disposes the provider.
- When a selected panel/pane disappears, refresh normalizes the browser route to the backend-selected fallback and resets terminal connection state. This prevents stale terminal views after panel close or terminal exit.
- Keep README compatibility/features/perf notes updated when changing behavior.

## Verification Baseline
Use node --check for touched JS, node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs, cargo check --target-dir target, cargo test --target-dir target, and git diff --check.
