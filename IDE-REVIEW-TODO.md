# IDE / File-editor review — working list

Branch `ide-review`. Review scope: file editor + IDE functionality, mobile vs
desktop parity, performance, and moving JS processing to the Rust backend.
Iterate over this list, marking each item `[x]` when done and verified. Delete
this file when the list is fully landed (it is a working scratch file, not
shipped docs).

Legend: **D** = desktop, **M** = mobile, **B** = backend, **P** = performance.
Priority: P0 must land in this review, P1 should land, P2 next iteration.

---

## A. File editor / IDE functionality gaps (desktop)

- [ ] **A1 (P0, D)** Toggle `⌕`/Find button is missing on mobile file preview, and
  desktop `toggleFind` depends on `parent._herdrEditorApi.toggleFind` which only
  exists after `wireFindToolbar`; on markdown preview mounts the toolbar exists
  but `api.selectRange` is a no-op, so "0/0 matches" states can get stuck. Make
  the find toolbar always functional (fall back to window.find or scroll-based
  highlight for readonly previews) and expose a Find affordance on mobile.
- [ ] **A2 (P0, D)** No unsaved-changes guard when closing a tab via the tab `✕`:
  desktop uses `confirm()` for the lock-discard path but the tab close path only
  checks `dirty` in some flows. Verify: dirty tab close asks to save/discard,
  split panes included. Add a regression test.
- [ ] **A3 (P1, D)** `loadFile` opens a duplicate fetch when the same path is
  opened from content-search twice (`openFile` mode "append" pushes a second
  file object with same path, `state.files.some(...)` only short-circuits the
  non-append path). Dedupe by path; reuse the existing tab.
- [ ] **A4 (P1, D)** Binary/truncated (>1 MB) files show a bare placeholder with
  no "open anyway (first N KB)" or "download" affordance. Add a backend range
  read (`?offset=&limit=`) and a "Load first 256 KB" button; keep write blocked
  with a clear reason.
- [ ] **A5 (P1, D)** No goto-line / goto-symbol affordance in the editor. Add
  `Ctrl+G` goto-line (CodeMirror `gotoLine` extension is already available via
  `@codemirror/search` or a minimal keymap prompt), plus a "line:col" status
  readout in the editor header.
- [ ] **A6 (P2, D)** Diff awareness: an externally-changed file (hash mismatch
  on save is handled, but no reload prompt on tab focus). On `visibilitychange`
  or tab refocus, re-hash open files cheaply and offer "File changed on disk —
  reload?".

## B. Mobile ↔ desktop parity

- [x] **B1 (P0, M)** Mobile file preview is strictly read-only: no unlock/edit
  toggle, no save, no dirty state, no Cmd+S equivalent ("Save" button). The
  backend write API (`POST /api/file-browser/file`) is already used by desktop
  and snippet editing on mobile proves the plumbing exists. Add edit mode with
  a visible Save action + unsaved-changes guard on screen switch.
  DONE: `editing/draft/dirty/saving/saveError` state + `startEdit/cancelEdit/saveFile`
  exported as `filesStartEdit/filesCancelEdit/filesSaveFile`; Edit/Cancel/Save(●)
  buttons with hash-checked save; discard guards on toggle/select/openAt/backToTree/
  refreshFile; `deps.confirm` wired in mobile app.js. 6 tests in
  `src/assets/mobile_file_browser.test.mjs`. Also fixed: `select()` did not await
  `openFile()` (fire-and-forget race).
- [x] **B2 (P0, M)** No rename/delete/new-file actions in mobile file browser.
  Backend endpoints exist (`/api/file-browser/rename`, `/delete`). Add a
  long-press (or ⋯ row button) action sheet: rename, delete (with confirm),
  and "new file" when in a directory listing.
  DONE: ⋯ row action on every tree row (new `rowActionMethod` option in
  shared/file_tree.js) + ⋯ on the preview header; bottom-sheet with
  Rename/Delete (+ "New file here" for dirs); inline rename modal with Enter/
  Esc handling and inline errors; delete with confirm + open-preview cleanup;
  "+ File" header action; sheets respect dirty drafts. 6 new unit tests +
  9 new e2e checks (25/25 total).
- [x] **B3 (P1, M)** Mobile Git screen exposes only `status` + per-file `diff`
  (2 of ~25 desktop git APIs). Ship a minimal parity set: stage/unstage file,
  discard file changes (confirm), branch list + checkout. Keep heavy actions
  (rebase, stash, conflict resolution) desktop-only but list them as
  "Desktop only" in the UI so parity expectations are explicit.
  DONE: git state (`gitBranches/gitBranchesError/gitBusy/gitMutating`, cleared by
  `resetGitForCwd`) + `gitMutate(label, run)` helper; file detail gains Stage
  (M/?), Unstage (S), Discard (M/S, confirm-gated, disabled while mutating);
  Branches toggle renders Local/Remote lists via `renderGitBranchList` with the
  current branch disabled and confirm-gated `gitSwitchBranch`. Fixed a real bug
  found by the test: `toggleGitBranches` was fire-and-forget so callers could not
  await the branches fetch (now async, returns the load promise). Heavy actions
  listed under a "Desktop only" note in the screen. 6 new unit tests (36 total
  in mobile_load) + 9 new e2e checks against a real git repo (34/34 total:
  status renders, Stage/Discard buttons, staged-on-disk via API, Unstage flip,
  branch list, real checkout to feature/e2e and back, discard reverts the file).
- [x] **B4 (P1, M)** `shared/lsp.js` is loaded on mobile but never used, and
  `editorOptions()` (word wrap, tab size, folding, bracket matching) is
  desktop-only. Either wire LSP diagnostics into the mobile editor (with a
  settings toggle default-off) or lazy-load lsp.js on desktop only; expose
  word-wrap toggle on mobile settings.
  DONE: chose full wiring — LSP is now used on mobile. `editorOptions()` in
  mobile file_browser mirrors desktop (word wrap, tab size, bracket matching,
  folding, active line, whitespace) and is passed to BOTH editor mounts
  (readonly + editing), matching desktop `mountEditors` exactly. LSP
  integration: `lspEnabled()` (same `lspEnabled` option key, default off),
  didOpen on mount, didChange on edit, didClose on back/switch/reset, and a
  diagnostics list rendered under the preview (message + line, severity
  colors, 50-item cap). New mobile Settings "Editor" group: enhancements,
  word wrap, tab size, LSP diagnostics (persisted via the same
  herdr-web-options store; setters exported on HerdrMobile). 5 new unit tests
  (17 total) + settings render/persist test in mobile_load (37) + 8 new e2e
  checks (41/41: CM mounts, wrap on→off via Settings changes live white-space,
  tab size 4 lands in cm-content, LSP toggle persists).
- [x] **B5 (P2, M)** Mobile search screen has no file/folder path search scope
  toggle parity check: verify `HerdrWorkspaceSearch.settings()` section order
  and enabled scopes behave identically on mobile, including the "Content"
  scope chips; add a mobile_load test asserting the shared helper is used.
  DONE: verified mobile already routes through the shared helper (settings,
  pathSearchAvailable, normalizePathKind, section order). Found and fixed a
  real gap: mobile search had NO "Load more" for path results (desktop has
  loadMorePaths) even though pathDone/pathOffset were tracked. Added the
  Load-more button (renders when truncated, preserves scroll on append,
  guards against concurrent loads) + HerdrMobileSearch.loadMorePaths.
  New mobile_load test asserts: shared helper usage, custom section order
  (content,files,workspaces), disabled scopes hide sections + disable chips,
  kind normalization, truncated button renders, and a second page appends
  (uses ctx.settle microtask helper; added focus() to the element stub).
  E2e extended to 49/49: order files-before-content, Load more button with
  page size 10 + 12 bulk files, real append verified via section-scoped row
  counts (first page 10, after click 12).

## C. Performance — move JS processing to Rust backend

- [x] **C1 (P0, B/P)** LSP diagnostics use a 2 s HTTP poll
  (`/api/lsp/notifications`) that drains a global queue for all servers and
  ships `servers` status on every call. The backend already has a websocket
  hub (`/ws/events`) with per-subscription filtering. Push
  `lsp.diagnostics` events over the existing events WS (new subscription
  type `lsp.diagnostics`), keep the HTTP endpoint for compat, and make the
  frontend prefer push with poll fallback. Removes per-2s JSON parse of the
  full server registry on the UI thread.
  DONE: LspRegistry now carries a tokio broadcast channel (128 slots); the
  server stdout reader publishes an LspDiagnosticsEvent {language, root,
  notification} for every publishDiagnostics(/Thin) batch alongside the
  legacy per-server queue. /ws/events subscribes to the registry and
  forwards events as {type:"event", event:{type:"lsp.diagnostics"}} — same
  envelope as workspace/pane events, zero extra backend round trips.
  shared/lsp.js opens its own /ws/events push socket on first didOpen,
  applies pushed diagnostics immediately, resets the slow-drain clock on
  each live push, and degrades to a 30s safety drain while the socket is
  live (catches broadcast lag; diagnostics are full snapshots). On socket
  loss it reconnects with capped backoff while the fast 2s poll covers the
  gap (older backends keep the fast poll permanently). applyNotifications
  now also accepts the Thin variant. Measured in the real-browser
  acceptance with a real vscode-json-language-server: 1 push event,
  0 /api/lsp/notifications calls in a 5s window (old behavior: 2-3),
  20/20 checks. 2 Rust tests (broadcast reach, lagged receiver) + 1 WS
  forwarding test via a real axum server + 2 JS transport tests (push
  applied + poll fallback on drop).
- [x] **C2 (P0, B/P)** DONE: the backend now builds merged chunks and
  per-row highlight HTML for both `/api/file-browser/content-search` and
  `.../content-search/file`. `ContentSearchFile.chunks` carries
  `{start, end, match_ids, rows:[{line, matched, match_id, highlight_html}]}`
  where `highlight_html` is escaped server-side with
  `<mark class="herdr-content-search-hit">` around the hit. The shared
  renderer consumes them verbatim and caches the normalized shape on the
  file object (re-renders rebuild nothing); older backends without chunks
  keep the old client-side `lineChunks`/`mergeChunk` fallback. Bonus fix:
  highlight offsets are byte-correct in Rust, so multibyte lines highlight
  the exact hit (the legacy JS sliced byte offsets over UTF-16 indices).
  Measured: 10-file page (30 matches each) 7.4ms → 1.0ms per render (~7x).
  7 Rust tests (merge overlap/adjacent/gap, escaping, multibyte,
  stale-offset fallback, response shape via content_search_file) + 7 JS
  renderer tests (backend chunks verbatim, no
  double-escape, openMatch/expand wiring from backend ids, cache reuse,
  fallback merge, line>0 filter). New no-browser e2e
  `scripts/e2e/run-content-search-e2e.sh` (21 checks: real backend sends
  pre-merged chunks for overlapping matches, escaping, served renderer
  consumes them, single-file route too).
- [x] **C3 (P1, B/P)** DONE: added `shared/options.js` (`HerdrOptions`:
  parse-once cache, shallow-copy `read()`, `write()`/`update()`, `storage`-event
  invalidation, corrupt/missing localStorage tolerated). Served by the backend
  (`/assets/shared/options.js`) and loaded by `app_boot.js` before all
  consumers. Migrated all 26 baseline read sites (desktop file_browser 7,
  mobile file_browser 8, git_ui, desktop search, directory_picker, app_js core
  loadOptions, mobile app 3, mobile settings, mobile terminal, shared editor,
  shared temp_terminal 3, workspace_search which previously had its own
  private raw-string cache) and all 3 writers (git_ui setGitUiOption, core
  saveOptions, mobile settings writeOptions) so the in-page cache can never go
  stale. Readers keep a direct-parse fallback when the module is absent
  (older bundles, partial vm harnesses). Measured with a vm-harness
  parse-counting script (3 stable runs): desktop file-browser session
  (10 tree refreshes + 5 file opens) 65 -> 1 parses; mobile session
  (10 loads + 5 previews) 22 -> 1. Tests: 9 new unit tests in
  `src/assets/options.test.mjs` (parse-once, shallow-copy isolation,
  write/update persistence, storage-event invalidation, unrelated-key ignore,
  no-localStorage fallback, corrupt JSON); vm-harness bundles in
  app_load/mobile_load/mobile_file_browser/app_boot tests boot options.js
  first. Full suites: 410 JS pass, 377 Rust pass; git, content-search,
  main (18), mobile-edit (49), LSP e2e all pass. Bonus: fixed the
  theme-acceptance CDP harness never closing its WebSocket (node hung after
  passing all checks; committed separately).
- [x] **C4 (P1, D/P)** `mountEditors()` re-creates CodeMirror instances on
  every `render()` because `renderPreviewShell()` rewrites `innerHTML` for the
  whole panel. Keep a per-path editor instance cache keyed by
  `fileBrowserEditor-<hash>`; on render, reattach existing DOM nodes instead of
  rebuilding, and only create/destroy editors on tab add/remove/editability
  change. This is the biggest desktop typing-latency win for large files.
  DONE: module-level `editorCache` Map in desktop `file_browser.js` keyed
  `${activeKey}|${path}` storing `{api, mount, signature}` where signature
  covers content/draft, editing, previewSource, searchHighlight, lineNumbers,
  and editor options. `mountEditors()` prunes closed paths, reattaches the
  cached `.herdr-editor` wrapper via `parent.appendChild(cached.mount)` when
  the signature matches (sets `parent._herdrEditorApi`), else forgets and
  recreates. Invalidations: `closeFile` forgets, `forgetWorkspace` wipes the
  workspace prefix, `mutateTreeForRename` remaps via `Tree.replacePathPrefix`
  (exact-prefix match so `src` never matches `srcfoo.py`), `mutateTreeForDelete`
  drops the subtree; editing/lock/preview/searchHighlight flips change the
  signature and recreate; save (content=draft) reuses. `pruneEditorCache`
  only touches the current workspace's keys so switching workspaces back and
  forth keeps the other workspace's editors. Measured (vm-harness counting
  `HerdrEditor.create` calls, session = 2 files open + 10 focus-switch
  renders, 3 stable runs): 44 -> 2 creations. Real-browser e2e (acceptance.mjs
  2 new checks): the same `.cm-editor` DOM node survives re-renders with its
  API attached (mark attribute + re-render + identity assert). 411 JS +
  377 Rust pass, fmt clean, 20/20 acceptance e2e. Out of scope:
  `mountContentSearchEditors` (snippet editing) is unreachable dead code —
  see D6.
- [x] **C5 (P2, B/P)** The desktop preview fallback path (`previewHtml` with
  line numbers + regex highlight) is heavy JS for big files; when CodeMirror is
  available it is unused. Gate the numbered-preview path to files < 256 KB and
  add backend `?render=lines` returning pre-joined gutter/code HTML for larger
  readonly previews (reuse for mobile read-only preview too).
  DONE: `GET /api/file-browser/file?render=lines` now returns
  `lines_gutter_html` + `lines_code_html` built once in Rust
  (`numbered_lines_html`, escaping via the existing `escape_html`; unit test
  covers gutter numbering, `<` escaping, and empty-content single-line
  parity with the browser's split). Desktop `loadFile`/`reloadFile` and
  mobile `openFile` request `render=lines`, normalize it into
  `file.linesHtml`, and pass `{linesHtml, size}` into `HerdrEditor.create`;
  desktop's editor-cache signature includes `linesHtml` so a reload with
  changed prebuilt HTML recreates the view. `previewHtml` prefers prebuilt
  markup, falls back to client-side building only under 256 KB
  (`MAX_CLIENT_NUMBERED_PREVIEW_BYTES`), and renders a size hint above the
  gate (new `.herdr-editor-too-large` wrapper so the hint is
  distinguishable from real numbered markup in tests). Note: the fallback
  only renders when CodeMirror fails to load (app_boot preloads it), and
  `HerdrGitSyntax` is desktop-git-ui-lazy, so the fallback usually shows
  plain-escaped code; the 256 KB gate plus backend prebuilt HTML makes that
  path safe for large files on both layouts. Measured (vm, 512 KB / 20k-line
  file, 3 stable runs): ~5.5 ms per preview render -> ~0.01 ms with prebuilt
  inject. Real-browser e2e (new check, 21/21): `?render=lines` returns the
  numbered gutter and Rust-escaped code matching an in-page escape of the
  content. 412 JS + 377 Rust pass, fmt clean, clippy 0, mobile-edit 49/49,
  LSP 20/20, git + content-search + theme e2e green.
- [x] **C6 (P2, B/P)** Git log graph lane computation (`git_ui/log.js`,
  `log_graph.rs` exists) — verify lane assignment is computed in Rust already;
  if the JS recomputes lanes or dots, move it into `log_graph.rs` and ship
  lanes in the API response.
  DONE (verified, no migration needed): `graph_lane()` in
  `src/git_ui/log_graph.rs` computes the lane (position of `*`, else `|`) and
  `/api/git-ui/log` ships it as `row.lane` inside the `rows` array (unit
  tests in `log_graph.rs` assert lane 2 parsing; `git_ui/mod.rs:1313` asserts
  the JSON payload carries a numeric lane). The endpoint is a direct axum
  route (no backend proxy), so every current response includes rows with
  lanes. The JS `graphLane()` in `log.js` is a 6-line compatibility fallback
  for the legacy `lines`-only shape (older backends); the current backend
  always sends `rows`, so the fallback never runs in practice. Added a
  regression test (app_core.test.mjs) proving the renderer uses the
  payload lane color (row `--lane` == laneColor(2) for lane=2, not the
  graph-parsed lane 0) while legacy lane-less rows still fall back to
  graph parsing. 413 JS + 377 Rust pass.

## D. Correctness / robustness found during review (fix as encountered)

- [ ] **D1 (P0, D)** `shared/editor.js` fallback path calls
  `wireFindToolbar(parent, api, opts)` inside the `.catch()` before `api` is
  defined (TDZ/undefined at runtime if CodeMirror fails to load). Move the
  fallback wiring after the api literal.
- [ ] **D2 (P1, D/M)** `hashId` is implemented twice (desktop file_browser +
  shared file_content_search) with slightly different shapes; unify in
  `shared/core.js` and use it for editor mounts on both layouts.
- [ ] **D3 (P1, D)** `escapeRegex` + `findRanges` cap at 10 000 matches but
  still scan the whole text with a live regex on every keystroke in the find
  input; debounce matches (120 ms) and cap scan to the visible document size
  (already bounded by MAX_FILE_BYTES 1 MB, still 10k-iteration loops on huge
  files per keypress).
- [ ] **D4 (P1, B)** Content-search `regex` mode builds a Rust regex per line
  via `ContentMatcher::new` per file; hoist compiled matcher across the walk
  (already thread-local? verify) and add a walk-wide visit cap so pathological
  repos cannot exceed request budget; surface `visited` count for "searched N
  files" UI.
- [ ] **D5 (P2, M)** Mobile `renderPreservingFocus` re-renders the entire
  screen HTML per keystroke in the filter input (type-to-filter); keep the
  input node, patch only the results container (same pattern as desktop
  `renderPreservingScroll`).
- [x] **D6 (P1, D/M)** Content-search snippet editing was unreachable dead
  code since `216e13c` ("Refine unified search result UX"): the shared
  renderer stopped emitting the Edit button and the
  `contentSearchSnippet-${hashId}` container, so
  `state.contentSearch.snippets[key].editing` could never become true, yet
  both layouts kept `editSnippet`/`cancelSnippet`/`saveSnippet` handlers,
  desktop kept `mountContentSearchEditors()`, and the backend still served
  `POST /api/file-browser/content-search/snippet` (an unused file-write
  endpoint). No test or e2e exercised any of it. Removed end to end:
  desktop + mobile handlers and mount fn, `snippets` state fields in both
  layouts and workspace_search/search fallbacks, `snippetKey` export in the
  shared renderer, the Rust route + `file_browser_save_content_snippet` +
  `FileContentSnippetSaveRequest` + `replace_line_range` + its test, and the
  technical-details endpoint row. Content matches still open in the full
  editor (editable, hash-guarded save), which replaced this flow in
  `216e13c`. Bonus: clippy now reports 0 warnings (derived `Default` for
  `LogLevel`, `io::Error::other` in `main.rs`). Gates: 411 JS, 376 Rust,
  fmt clean, acceptance 20/20, mobile-edit 49/49, LSP 20/20, git + content
  search + theme e2e all pass.

## E. Verification gates (per item and at the end)

- [ ] **E1** Every touched behavior gets a `node --test` case in
  `src/assets/*.test.mjs` (fake-DOM style like existing suites).
- [ ] **E2** Backend changes get `cargo test` coverage (mirroring the
  `file_browser.rs` in-module tests pattern).
- [ ] **E3** Extend the CDP acceptance harness (`scripts/e2e/`) with an
  editor-parity script: mobile edit+save round-trip on disk, find toolbar on
  both layouts, no-console-error gate, and a perf smoke (content-search render
  count during typing ≤ N).
- [ ] **E4** Full suites green: `node --test src/assets/*.test.mjs` (370
  baseline), `cargo test` (367 baseline), `just e2e`, existing git-e2e.
- [ ] **E5** docs/release-notes.md entry under 0.4.7; commit per logical fix;
  squash-merge PR; fast-forward main worktree.

## Progress log

- 2026-09-06: audit complete (graph-indexed, coverage checked; vendor files
  read directly since they are excluded from the index). 370 JS + 367 Rust
  baseline green at 9a9a834. List drafted; starting P0 items.