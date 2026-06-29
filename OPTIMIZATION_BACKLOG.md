# Optimization Backlog

Branch: `focus-optimise-cpu-ram`

Goal: reduce CPU, memory, bundle parse cost, and maintenance risk across backend, desktop, and mobile.

## Batch 1 Implemented

- Lazy-load CodeMirror vendor bundle from `HerdrEditor` instead of booting it for every session.
- Keep lightweight preview/textarea fallback while CodeMirror loads, then upgrade in place.
- Remove `/assets/vendor/codemirror.js` from desktop/mobile boot path.
- Avoid repeated mobile file-preview editor creation by tracking/destroying editor handles.
- Reduce mobile xterm scrollback from `10000` to `2000` rows.
- Remove terminal shell/surface fit from the desktop terminal output animation-frame path.
- Lazy-load xterm JavaScript from desktop/mobile terminal connect paths instead of parsing it at initial HTML load.
- Lazy-load desktop Git UI and file browser JavaScript on first use instead of desktop boot.
- Coalesce mobile event websocket refreshes so event bursts trigger one API refresh instead of one per message.
- Add short browser cache headers for embedded static JS/CSS/SVG assets to reduce repeated transfer and parse on reload.
- Grow xterm scrollback in blocks instead of allocating the max scrollback on terminal creation.

## P0 Performance

- Move blocking Rust work off Tokio workers:
  - `src/main.rs`: Herdr socket calls, event websocket polling, terminal socket bridge.
  - `src/git_ui.rs`: `Command::new("git")`, diff/file commands.
  - `src/file_browser.rs`: `fs::read_dir`, `fs::read`, writes, rename/delete.
  - Fix: bounded `spawn_blocking` helpers, shared timeout/concurrency guard.
- Stop full DOM replacement for high-churn desktop views:
  - `src/assets/desktop/git_ui.js` replaces whole panel on each render.
  - `src/assets/desktop/file_browser.js` replaces explorer panel and remounts editors.
  - Fix: split side/main/context render; preserve editor instances; update only changed subtree.
- Cap Git diff memory:
  - `src/git_ui.rs` parses complete diff into memory.
  - Fix: max bytes/files/lines, stream parser, return truncation metadata.
- Bound event websocket fan-out:
  - `src/main.rs` spawns per-client polling thread.
  - Fix: one session broadcaster, cached snapshots, `broadcast`/`watch` fan-out.

## P1 Performance

- File browser huge directory handling:
  - Current `read_dir` collects/stats/sorts all entries before `MAX_ENTRIES`.
  - Fix: bounded collection, partial dirs-first sort, avoid per-entry `to_lowercase` allocation unless needed.
- Git command process count:
  - Many endpoints call `rev-parse` plus command chains.
  - Fix: resolve repo once per request, batch status/ls-files checks, add git timeout.
- Git file view size caps:
  - `git_ui.rs` file route lacks file-browser binary/size guard.
  - Fix: reuse file-browser file-read helper.
- Mobile refresh selectivity:
  - `src/assets/mobile/app.js` now debounces event bursts, but refresh still fetches broad state.
  - Fix: use event type to skip worktree fetch unless Worktrees screen or current workspace changed.
- Mobile shell boot:
  - `app.html` parses desktop shell before mobile replaces body.
  - Fix: minimal boot shell, desktop/mobile render own skeleton.

## P2 Maintainability / SOLID

- Split large Rust files:
  - `src/main.rs` ~3800 LOC: routes, auth, settings, sessions, websockets, assets, tests.
  - `src/git_ui.rs` ~2250 LOC: git commands, parsing, mutations, route handlers, tests.
  - Proposed modules: `routes`, `auth`, `settings`, `sessions`, `worktrees`, `ws`, `git/{commands,diff,mutations,conflicts}`.
- Split large frontend files:
  - `desktop/app_js/core.js` ~2400 LOC: global state/options/settings/shell/session/API helpers.
  - `desktop/git_ui.js` ~1550 LOC: state/API/render/commands/shortcuts.
  - `mobile/app.js` ~700 LOC: routing/state/render/git/terminal orchestration.
  - Proposed modules: `state`, `api`, `options`, `render`, `commands`, `shortcuts`.
- Extract shared helpers:
  - duplicate `api`, `esc`, `arg`, `pathBasename`, `parentPath`, `samePath`, option parsing.
  - Move pure helpers to `src/assets/shared/core.js`; keep UI wrappers thin.
- Replace inline `onclick` strings gradually with delegated listeners and `data-*` attributes.

## P3 Dead Code / Large Files

- Verify/remove desktop tab renderer remnants in `src/assets/desktop/app_js/render.js` if no longer used.
- Add `cargo machete` or similar dependency audit.
- Add JS source-level dead-code checks after module split.
- Review checked-in vendor assets and add cache headers/content hash strategy.

## Current Size Hotspots

- `src/main.rs`: ~3829 LOC.
- `src/assets/desktop/app_js/core.js`: ~2399 LOC.
- `src/git_ui.rs`: ~2251 LOC.
- `src/assets/desktop/git_ui.js`: ~1557 LOC.
- `src/assets/vendor/codemirror.bundle.js`: ~760 KB.
- `src/assets/xterm.min.js`: ~284 KB.

## Suggested Iteration Order

1. Finish frontend boot/runtime cheap wins: event-type selective mobile refresh and content-hash/ETag asset caching.
2. Add backend blocking-operation wrappers and git/file caps.
3. Split Git/file browser rendering to preserve DOM/editor instances.
4. Refactor large files into modules without behavior changes.
5. Add lightweight benchmarks or counters for render count, diff bytes, event refresh count.
