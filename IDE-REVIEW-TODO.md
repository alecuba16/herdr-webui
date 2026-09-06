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
- [ ] **B3 (P1, M)** Mobile Git screen exposes only `status` + per-file `diff`
  (2 of ~25 desktop git APIs). Ship a minimal parity set: stage/unstage file,
  discard file changes (confirm), branch list + checkout. Keep heavy actions
  (rebase, stash, conflict resolution) desktop-only but list them as
  "Desktop only" in the UI so parity expectations are explicit.
- [ ] **B4 (P1, M)** `shared/lsp.js` is loaded on mobile but never used, and
  `editorOptions()` (word wrap, tab size, folding, bracket matching) is
  desktop-only. Either wire LSP diagnostics into the mobile editor (with a
  settings toggle default-off) or lazy-load lsp.js on desktop only; expose
  word-wrap toggle on mobile settings.
- [ ] **B5 (P2, M)** Mobile search screen has no file/folder path search scope
  toggle parity check: verify `HerdrWorkspaceSearch.settings()` section order
  and enabled scopes behave identically on mobile, including the "Content"
  scope chips; add a mobile_load test asserting the shared helper is used.

## C. Performance — move JS processing to Rust backend

- [ ] **C1 (P0, B/P)** LSP diagnostics use a 2 s HTTP poll
  (`/api/lsp/notifications`) that drains a global queue for all servers and
  ships `servers` status on every call. The backend already has a websocket
  hub (`/ws/events`) with per-subscription filtering. Push
  `lsp.diagnostics` events over the existing events WS (new subscription
  type `lsp.diagnostics`), keep the HTTP endpoint for compat, and make the
  frontend prefer push with poll fallback. Removes per-2s JSON parse of the
  full server registry on the UI thread.
- [ ] **C2 (P0, B/P)** Content-search snippet merging/highlight chunking is
  done per render in JS (`lineChunks` + `mergeChunk` + per-row HTML string
  building on every `render()` call). The backend already computes matches,
  context and truncation: move chunk merging and per-line HTML generation to
  the backend response (return pre-merged chunks + `highlight_html` per row)
  and cache it per (query, offset, context) in the state so re-renders do not
  rebuild strings. Keep JS escaping as the last step only.
- [ ] **C3 (P1, B/P)** 22 call sites parse `herdr-web-options` from
  localStorage on every access (some inside render loops: `gitStatusEnabled()`
  is called per tree render, `contentSearchOptions()` per search). Add a shared
  cached options module (`shared/options.js`) with a storage-event
  invalidation, migrate all call sites, and have the backend serve normalized
  defaults once (`/api/settings` already exists for server settings; browser
  settings stay local but parsed once).
- [ ] **C4 (P1, D/P)** `mountEditors()` re-creates CodeMirror instances on
  every `render()` because `renderPreviewShell()` rewrites `innerHTML` for the
  whole panel. Keep a per-path editor instance cache keyed by
  `fileBrowserEditor-<hash>`; on render, reattach existing DOM nodes instead of
  rebuilding, and only create/destroy editors on tab add/remove/editability
  change. This is the biggest desktop typing-latency win for large files.
- [ ] **C5 (P2, B/P)** The desktop preview fallback path (`previewHtml` with
  line numbers + regex highlight) is heavy JS for big files; when CodeMirror is
  available it is unused. Gate the numbered-preview path to files < 256 KB and
  add backend `?render=lines` returning pre-joined gutter/code HTML for larger
  readonly previews (reuse for mobile read-only preview too).
- [ ] **C6 (P2, B/P)** Git log graph lane computation (`git_ui/log.js`,
  `log_graph.rs` exists) — verify lane assignment is computed in Rust already;
  if the JS recomputes lanes or dots, move it into `log_graph.rs` and ship
  lanes in the API response.

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