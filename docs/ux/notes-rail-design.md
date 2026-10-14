# Notes rail feature: implementation examination

Date: 2026-10-14. Branch: sync_notes. Design document, implementation pending approval.

## How the rail works today

- Rail markup: `src/assets/app.html:47-51`. Three buttons: `rightRailFiles`, `rightRailGit`, `rightRailSearch`.
- Wiring: `setupRightSidebarRail()` in `src/assets/desktop/app_js/core.js:2791`, active-state sync in `syncRightSidebarRail()` at 2808. Click handlers follow the "toggle collapse if active, expand if collapsed" contract, implemented in wrappers `openWorkspaceFileBrowser` / `openWorkspaceGitUi` / `openWorkspaceSearchPanel` in `render.js:616-700`.
- Panel hosting: `right_sidebar.js` claims a drawer panel node into `#rightSidebarContent` via `HerdrRightSidebar.openView(mode, wsId, ensurePanel)`. Modes are whitelisted in `RIGHT_SIDEBAR_PANES` and `rightSidebarModeFor()`.
- Mode persistence: per-workspace, localStorage, session-only. `loadWorkspaceShellStates()` deletes the store on boot (boot-clean rule: fresh boot never auto-opens a panel).
- Lazy loading: drawer code loads on first open (`ensureFileBrowserLoaded` / `ensureGitUiLoaded`, `render.js:587-614`).

## Design decisions

### 1. Storage: server-side JSON sidecar

`notes.json` sidecar in the config dir next to `webui-settings.json`, written with the existing `atomic_write` (temp + rename, `server_settings.rs:394`).

- Notes are user content with high write frequency. Putting them in `webui-settings.json` rewrites auth/bind/LSP config on every debounced save and forces every reader to parse notes to get settings.
- localStorage is per-browser, never synced, and the boot-clean pattern deliberately wipes view state. Wrong layer for content.
- Same config dir means test isolation via `XDG_CONFIG_HOME` keeps working (`assert_test_settings_isolation`, `server_settings.rs:541`).
- Survives resets: browser reloads, backend restarts (builtin backend state is unrelated), WebUI process restarts, auth session resets (`reset_sessions` touches tokens, not files).

Structure: `{ "notes": [ { id, title, content, language, created_at, updated_at, updated_by } ] }`. Global per server. "Sync between all the clients" reads as one shared scratchpad.

### 2. Sync: one-shot broadcast over the events socket, full snapshot

Same pattern as `server_settings_changed`: handler mutates state, persists, `notes_tx.send(json!({...}))`, and `events_socket` (`main.rs:6108-6111`) forwards the frame to every connected `/ws/events` client. Client dispatch in `connectEvents` (`terminal.js:31`).

Why full snapshot and not deltas:

- LSP diagnostics already use full-state snapshots ("receivers that lag a burst simply miss those batches", `main.rs:5977-5979`). Notes are the same shape: small, bursty, no ordering requirement.
- Deltas need sequence numbers, gap detection, replay. At note scale that is complexity with no user-visible win.
- A client that misses a broadcast self-heals on the next `GET /api/notes` (panel open loads it).

Performance guard: a `notes_changed` frame must NOT trigger the global `scheduleRefresh` that unknown event kinds cause. One `else if` branch, repaint panel only when hosted. No polling.

### 3. Selectable syntax highlighting: CodeMirror bundle, per-note language field

The vendored entry (`src/assets/vendor/codemirror_entry.mjs`) already bundles markdown, js/ts, rust, python, go, json, yaml, css, html, xml, java, sql. The shared editor (`src/assets/shared/editor.js`) lazy-loads the bundle on first use and derives the language from `opts.path`.

Each note carries a `language` field. The note editor header gets a `<select>` with the bundled set. Pass `path: "note." + extFor(language)` to `HerdrEditor`. Zero new dependencies, no bundle rebuild. `HerdrGitSyntax` stays out: it is escape-order-sensitive and not selectable per language the way CodeMirror is.

CodeMirror parse cost is paid only when a note is opened for editing (established lazy contract).

### 4. Cleanup: per-note delete + clear-all with confirm

- Per note: trash button on the row, `DELETE /api/notes/{id}`.
- All: "Clear all" in the panel head through the existing `askQuestion({ danger: true })` modal (`core.js:2763`). Per-note delete stays confirm-free; open decision recorded below.

### 5. Rail button: pencil icon, fourth hosted mode

- `app.html`: add `rightRailNotes` button.
- `appIcon("pencil")` already produces the class hook; add `.app-icon-pencil { mask-image: url("/assets/icons/pencil.svg"); }` in `base.css`. The SVG is already served (`main.rs:1529`).
- `right_sidebar.js`: `notes: "notesPanel"` in `RIGHT_SIDEBAR_PANES`, accept `"notes"` in `rightSidebarModeFor` and `openRightSidebarView`.
- `workspace_shell.js`: `isHostedShellMode` adds `"notes"` (its 4 call sites are mode-agnostic, one edit covers them); `applyWorkspaceShellForSelection` gets a branch. Boot-clean rule untouched.
- `render.js`: `ensureNotesLoaded()` + `openWorkspaceNotesPanel()` wrapper copying the search panel wrapper contract.
- `core.js`: `syncRightSidebarRail` fourth entry; icon + click in `setupRightSidebarRail`; fourth branch in the `rightSidebarToggle.onclick` expand fallback at core.js:327-329 (initial draft missed this site, caught in the re-check sweep); `showTerminalShellMode` closes the notes panel like the others.
- Drawer-close sweeps: the three `openWorkspace*` wrappers that call `HerdrSearchPanel.close()` (render.js:545, 638, 676) each gain a `HerdrNotesPanel.close()` sibling so modes stay mutually exclusive.

### 6. Writes: debounce + per-note PUT + LWW

- Client debounces ~600ms (heavier than the 180ms search precedent at `search_panel.js:117` because payloads are bigger), sends `PUT /api/notes/{id}` with the changed note.
- Server validates (id, title <= 200 chars, content <= 32KB, language in allowlist, max 200 entries), merges, stamps `updated_at`, persists via `spawn_blocking` (file-I/O offload precedent, `main.rs:2395`), broadcasts.
- Concurrency: last-write-wins by `updated_at`. CRDT or `expected_hash` optimistic guard (file browser precedent, `file_browser.rs:147`) is overkill for a scratchpad.

## Concrete file map

Backend:
1. `src/notes.rs` (new): `NotesState`, `routes()` (`GET/POST /api/notes`, `PUT/DELETE /api/notes/{id}`, `POST /api/notes/clear`), `load_notes()`/`save_notes()` using `atomic_write` + `assert_test_settings_isolation`, payload fns. No socket_dispatch (notes are WebUI-owned, not a builtin-backend feature).
2. `main.rs`: `notes: Arc<Mutex<NotesState>>` + `notes_tx` in `WebState` and `main()`, `.merge(notes::routes())`, `notes_rx` in the `events_socket` select loop, asset routes for notes.js/notes.css.
3. `WebState` literal constructors to update: `main.rs:983` (runtime), `src/tests.rs:23`, `src/git_ui/mod.rs:1373`, `src/tui_parity_e2e_tests.rs:166` (the `..state` update at `tui_parity_e2e_tests.rs:2206` needs no change).

Frontend:
4. `src/assets/app.html`: rail button.
5. `core.js`, `right_sidebar.js`, `workspace_shell.js`, `render.js`: mode plumbing per section 5.
6. `src/assets/desktop/notes.js` (new): IIFE on the `search_panel.js` model. Own `panelState`, `panelNode()` creating `#notesPanel`, `open`/`close`/`isOpen`, list render, editor via `HerdrEditor`, language select, delete/clear actions, `applyRemote(notes)` for broadcasts, debounced save.
7. `src/assets/desktop/notes.css` (new): hosted-panel contract copied from `.right-sidebar-content > .search-panel` rules (`panes.css:354`).
8. `terminal.js`: `notes_changed` branch in `connectEvents`.
9. `base.css`: pencil mask class.
10. `assets.rs`: consts + handlers for the two new assets.

Docs and tests:
11. `src/assets/notes_panel.test.mjs`: vm-harness test on the `desktop_search_panel.test.mjs` model. Pins: mode claiming, debounce, remote apply, cleanup calls.
12. `src/tests.rs`: route tests (auth, validation caps, persistence isolation under `XDG_CONFIG_HOME`), broadcast test mirroring `events_socket_broadcasts_server_settings_changed` (`src/tests.rs:10830`).
13. `app_load.test.mjs`: static assertions (button in app.html, rail wiring, events handler).
14. `docs/development.md` parity list (desktop-only, explicit), `docs/features.md`, release notes, help modal if a shortcut gets added.

## Performance rationale

- Zero idle cost: no polling, broadcast is push-only on change. Closed panel clients do nothing with frames.
- Boot cost unchanged: module + CSS lazy-load on first rail click, CodeMirror deferred to first note edit. `app.js` gains a few lines only.
- Disk: one atomic rename per debounced save, off the async runtime. Sidecar stays tiny (caps enforced server-side).
- Network: per-note PUT payloads (~KB), snapshot broadcasts bounded by the 200-entry/32KB caps.
- Render: single panel repaint on broadcast, no global `scheduleRefresh`, no terminal touch.
- No CRDT, no vector clocks, no sequence tracking. At this scale LWW + full snapshot beats delta protocols in complexity and latency.

## Verification record (post-delivery re-check)

- Exhaustive `WebState` constructor sweep: 4 literal sites, not 3. `tui_parity_e2e_tests.rs:2206` uses `..state` spread so it needs no edit, but it was found and classified. File map corrected.
- Mode whitelists sweep: found a missed integration point, the `rightSidebarToggle.onclick` expand fallback at core.js:327-329, which branch-dispatches on the resolved hosted mode. A notes mode that misses this branch would break the expand-never-empty column contract. Added to the file map.
- Drawer-close sweep: 4 `HerdrSearchPanel.close()` call sites; each needs a notes sibling for mutual exclusion.
- Baseline evidence the plan's assumptions hold on this branch: `cargo check` clean, `node --test src/assets/desktop_right_sidebar.test.mjs src/assets/desktop_search_panel.test.mjs src/assets/workspace_shell_restore.test.mjs` 26/26 pass, `app_load.test.mjs` 241/241 pass. These pin the hosting/mode contracts the design extends.

Honest limit: this is a design deliverable, so end-to-end acceptance (server boot, two clients seeing a note sync, notes surviving a restart) cannot be exercised until the code exists. The baseline runs above prove the contracts the design builds on, they do not prove the notes feature itself. That proof lands with the implementation tests in the file map.

## Additional validation pass (round 2)

Deeper checks on the design's load-bearing claims, all verified against source:

- `HerdrEditor.create` contract: real call sites exist (file_browser.js:551, git_ui.js:1268) with `parent`/`path`/`content`/`readonly`/`onChange`, plus an editor-cache pattern with a loading-shell race guard worth copying for the notes editor mount. The `path`-drives-language claim holds: `codemirror_entry.mjs` `languageForPath` maps extensions.
- Auth pattern for the new routes: `file_browser.rs` handlers use a local `file_browser_auth` wrapper around `require_auth` plus `spawn_blocking` payload fns returning `Result<Value, (StatusCode, String)>`. That is the shape `src/notes.rs` handlers should take, matching the repo's recent blocking-offload convention (commit 2f4aa49 "offload remaining direct request_value calls to spawn_blocking").
- `RIGHT_SIDEBAR_PANES` is declared but unreferenced in `right_sidebar.js` beyond its definition: the map is documentation, the live whitelists are `rightSidebarModeFor` (right_sidebar.js:19) and `openRightSidebarView` (right_sidebar.js:100). Design correctly lists both.
- CSS concatenation: `desktop_css` concatenates `app_css/*.css` (assets.rs:49-53). A new `notes.css` needs either a route of its own (like file-browser.css) or a slot in that concat list. Design says own route + lazy load, consistent with `loadDesktopFeatureCss` precedent.
- Broadcast precedent: exactly one `tokio::sync::broadcast::channel` exists today (settings_tx, main.rs:980). Adding notes_tx doubles that count, still trivial capacity (16). The events socket loop is inbound-`socket.recv()`-only, so a client-applied note push needs no protocol change, just the select-loop arm.
- Test harness: route tests go through the real router (`test_app` = `app_router(test_state())`, tests.rs:74-80) with a `lock_env`/XDG_CONFIG_HOME isolation helper shared with the parity e2e module (tests.rs:94-104). The notes persistence tests fit this harness with no new infrastructure.
- No prior `api/notes` or `herdr-web-notes` key exists anywhere in src/ or docs/ (only this design doc). Greenfield, no conflicts.

No design changes required by this pass. Two implementation-detail notes added for the future build: reuse the editor-cache/loading-shell guard when mounting the notes editor, and shape notes.rs handlers after the file_browser auth+spawn_blocking pattern.

## Open decisions

1. Per-note delete: confirm-free trash click, or confirm modal like file delete? Plan assumes confirm-free.
2. Mobile parity: desktop-only v1 documented as a gap, or port a notes screen now? Plan assumes desktop-only.
3. Shortcut: bind one (e.g. Alt+N) or rail-click only for v1? Plan assumes rail-click only.
4. Scope: global notes vs per-workspace notes. Plan assumes global ("sync between all the clients" read as one shared scratchpad). If per-workspace was intended, storage keys and the panel header change, the rest holds.