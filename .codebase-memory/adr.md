# Herdr WebUI Architecture / Feature Inventory

## Purpose
Standalone browser UI for official Herdr backend sessions. Rust server proxies Herdr JSON API, direct terminal attach sockets, Git/file APIs, auth, and service install helpers. Frontend is embedded vanilla JS/CSS with split desktop/mobile assets and shared helpers.

## Core Areas To Preserve
- Sessions/workspaces: named Herdr sessions, session manager when backend offline, workspace create/open/close, workspace ordering, cwd enrichment from pane data, stale pane/tab cleanup from Herdr events.
- Worktrees: native Herdr worktree create/open/remove for Herdr 0.7.1+, legacy fallback for 0.7.0, linked worktree labels, branch/source handling, parent workspace close policy, worktree grouping and actions.
- Terminal desktop: xterm attach WebSocket, backend resize, configurable font/theme/scroll speed, capture-phase paste sanitization, Shift+Enter newline, keyboard prefix isolation, normal scrollback pause/follow Tail button, alternate-screen backend scroll, PageUp/PageDown behavior.
- Terminal mobile: xterm attach, capture-phase paste sanitization, bounded large-input chunks, normal scrollback pause/follow Tail button, viewport preservation when output arrives while paused.
- Performance safeguards: desktop terminal output frame coalescing per requestAnimationFrame, pending frame flush before close/reconnect, bounded paste frames/backpressure, adaptive no-sleep polling, Git drawer DOM blanking while hidden, large changes placeholders, per-file load-on-demand, large selected-file preview before full render, disabled hunk/block actions in preview mode.
- Git UI: status groups, file trees, staged/unstaged/untracked/conflicted lists, commit/stash/log/blame/file history/conflict routes, side-by-side diffs, hunk/block actions, syntax highlighting, shortcuts, destructive confirmations, path/ref validation.
- File browser/editor: authenticated tree/read/write/rename/delete APIs, hash guard, dirty-close confirmation, lazy folders, split preview panes, parent-folder setting, shared indentation setting, mobile Files tab.
- Settings/search/shortcuts: grouped settings modal, Settings search field, local browser options, server access settings, no-sleep modes, browser notifications/sounds, theme/accent vars, terminal font, shortcut prefix editor/collision checks, search palette over loaded workspaces/worktrees/panels/agents.
- Mobile UI: Workspaces, Agents, Panels, Worktrees, Files, Git, Terminal tabs; route compaction/expansion; terminal recreation after leaving/returning; agent attention sorting; 100dvh app shell; one-row horizontally scrolling bottom nav; min-width/min-height guards to keep terminal/file content inside screen.
- Security/auth/service: localhost bypass setting, credential requirement for public bind, login cookie, auth checks on APIs/assets, macOS LaunchAgent and Linux systemd install/update/start/stop helpers.

## Recent Browser Load Optimisation Decisions
- Avoid idle /api/no-sleep polling when Off/server healthy; keep active/error retry paths.
- Coalesce rapid terminal output before xterm rendering to reduce script/layout CPU.
- Preserve terminal scrollback viewport when follow is paused; expose Tail button on desktop and mobile.
- Chunk large paste/input frames with WebSocket bufferedAmount backpressure.
- Guard large Git diffs with preview/full-render flow and disable mutating hunk/block actions for hidden lines.
- Keep mobile bottom navigation as a horizontal scroll strip, not a wrapping grid; wrapping creates a two-line bar and apparent page overflow on narrow screens.
- Keep README compatibility/features/perf notes updated when changing behavior.

## Verification Baseline
Use node --check for touched JS, node --test src/assets/app_core.test.mjs src/assets/app_load.test.mjs src/assets/app_boot.test.mjs src/assets/mobile_load.test.mjs, cargo check --target-dir target, and cargo test --target-dir target.
