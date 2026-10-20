# File explorer filter: yellow matches, jump to first, arrow cycling

Examination and design notes for the file-explorer filter feature: yellow
highlights on name matches, auto-jump to the first match, and ↑/↓
navigation between matches, with the shortcut configurable in settings.
Scope covers both surfaces: the TUI file explorer and the desktop webui
file browser. Requested as an examination first; no code written yet.

Sibling doc: `docs/ux/backlog-features-design.md` (same format: scope
decisions + implementation notes per item).

## 0. What exists today (verified)

**TUI file explorer (`src/tui/panels/files/mod.rs`):** the filter is
already a full search mode, not a local type-to-filter:

- `/` calls `start_filter()` (mod.rs:435), which sets `filter_active`.
- While active: Enter commits, Esc cancels, Backspace pops, any Char pushes
  (`src/tui/mod.rs:2433-2441`).
- Commit runs a server-side search: `refresh()` (mod.rs:135) calls
  `api.file_search(cwd, root, filter, 0, 200, dirs_only)` when the filter is
  non-empty (mod.rs:141-152), replacing `entries` with the result rows.
  The render header shows `search results for 'q' in Files` while
  results are up (render/mod.rs:503-510) plus a `searching <kind>` line
  pre-commit (render/mod.rs:491-505); the tree route already returns
  only matching entries (verified against a live isolated server, see
  section 3). No matched/total counter is rendered for the files list
  (the overlay `filter_query_line` at render/mod.rs:1899 is a different
  code path, help/worktree overlays only).
- So the TUI already filters (via server) and shows the query; it has **no
  substring highlight in the tree rows, no match-jump/cycle state, and
  no matched/total count in the files list**. `commit_filter` only flips
  flags (mod.rs:450-452); `refresh()` clamps selection down but never
  moves it to row 0, so jump-to-first is genuinely a to-build item.
  The gaps for this feature: yellow match highlight, jump-to-first on
  commit, and optionally a matched/total count line.

**Webui desktop file browser (`src/assets/desktop/file_browser.js`):**
per-workspace `stateCache`, `flattenEntries`, `loadTree`, and **no filter
at all today**. The shared tree renderer (`src/assets/shared/file_tree.js`)
already supports a `filterTerm` option consumed by `highlight(entry.name,
opts.filterTerm)` at lines 142 and 192, emitting
`<mark class="herdr-tree-hit">`. Two production callers pass it today:
git side tree (`git_ui/side_tree.js:51`, `view.fileFilter`) and workspace
search results (`workspace_search.js:269`, `opts.query`). So the yellow
mark rendering path is proven; the file browser just never passes it.

**Mobile file browser (`src/assets/mobile/file_browser.js`) already has
the filter itself**, and it is the strongest precedent for the desktop
cut:

- Filter state on `local`: `filter`, `filterVisible`, `filterTimer`,
  `filterOffset`, `filterDone`, `filterKind` (line 10).
- Input wiring: 500ms debounce (350ms for content search), Enter commits
  immediately, Esc clears (lines 847-856).
- Search runs server-side: `loadFiltered` (lines 220-243) calls the tree
  route with `q=` + `search_kind` + `offset`/`limit` pagination, appends
  pages, and tracks `filterDone` from `truncated`.
- `filterKind` cycles file/dir/content scopes.
- It does **not** pass `filterTerm` to `Tree.renderEntries` (line 634):
  mobile filters without yellow marks. Desktop adding `filterTerm` would
  be the delta on top of this pattern.
- Server payload constraint: the tree route returns `entries`,
  `truncated`, and `query` but **no total match count**
  (file_browser.rs:1600-1607), so an "n/total" display cannot be fed from
  the payload as-is; mobile shows no count for this reason.

**Webui shortcut infrastructure:**

- Global prefix default `Ctrl+B` (`DEFAULT_GLOBAL_SHORTCUT_PREFIX`,
  core.js:169), with a 5s prefix window and overlay
  (`showShortcutPrefixOverlay`, shortcuts.js:213 area).
- `DEFAULT_WEBUI_SHORTCUTS` (core.js:170): prefix+F is already
  `focusTerminal`; prefix+S settings; prefix+/ search. Single-stroke
  prefix+key entries, no multi-key sequences.
- Scoped precedent: git UI owns `DEFAULT_GIT_SHORTCUTS` with its own
  dispatch (`git_ui/shortcuts.js:160-215`) that only fires when the git UI
  is the active view, same prefix, own toast echo, own settings rows in
  the shortcut editor via the `gitShortcuts` scope.
- Ctrl+F: `isAppFindShortcut` (shortcuts.js:196) tries
  `openFocusedFileBrowserFind` first when the file browser is focused
  (shortcuts.js:485). But `HerdrFileBrowser.openFocusedFind`
  (file_browser.js:1332) opens the **editor's in-file find**
  (`openFindForPath`, file_browser.js:799-802), not a tree filter. So
  Ctrl+F is claimed for editor find in file-browser context.
- Record/Clear capture buttons delegate through
  `data-shortcut-record`/`data-shortcut-reset` (bindings.js:142-158) and
  capture via `shortcutPrefixFromEvent` (shortcuts.js:167).
- Known dead UI: the Keyboard section's Search shortcut Record/Clear
  buttons (`optSearchShortcutCapture`/`optSearchShortcutClear`, rendered
  at core.js:2090) have no click listener anywhere (the global prefix
  Record at bindings.js:215 is bound; these two are not). Not caused by
  this feature; backlog item.

**Yellow highlight styling:** `.herdr-tree-hit` gets
`background: var(--herdr-search-hit-bg)` / `color: var(--herdr-search-hit-fg)`
(shared/file_tree.css:1-4), tokens defined in shared/colors.css:3-4
(`#f9e2af` / `#11111b`) with fallbacks in git_ui/layout.css:526-528. TUI
Palette has `p.yellow` (theme.rs:102, `Rgb(249, 226, 175)` light /
`Rgb(180, 83, 9)` dark at theme.rs:137/153), the same yellow used by the
webui token. Both surfaces already share this yellow.

**Debounce-filter precedent (webui):** git UI `filterFiles`
(git_ui.js:1997) debounces a text filter over the file list; the settings
modal search (`filterSettings`, core.js:2340) is the hide-non-matching
precedent with a `.settings-filter-hidden` class and an empty state. The
git filter row styling to copy is `.git-ui-file-filter`
(git_ui/layout.css:497-522).

## 1. Design decisions

### 1.1 Shortcut choice (webui)

Constraints found by verification: Ctrl+F is taken (editor find handoff,
shortcuts.js:485), prefix+F is taken (focusTerminal), prefix+B is taken
(sidebar). Squeezing a new global chord onto the default table costs a
conflict. The options:

- **(a) Scoped table, git-style.** New `fileBrowserShortcuts` scope with
  dispatch only when the file browser panel is the active right-sidebar
  pane (`RIGHT_SIDEBAR_PANES.files`, right_sidebar.js:12) or shell mode
  `files`. Default chord inside the scope can be plain `/` (no browser
  conflict: `/` is not a tree command; the git scope already uses
  prefix-free single keys like `KeyC`).
- **(b) Global entry, default unset.** One `webuiShortcuts` row
  ("File browser filter", default disabled) that focuses the filter input
  when a workspace is open. No conflict, no new dispatch machinery, but
  off-by-default does not meet "configurable in settings" until the user
  records a chord.

**Chosen: (a) scoped table with default `/`, plus Record/Clear rows in
the shortcut editor under a "File browser" group.** Git UI proves the
pattern end to end (scoped defaults, scoped dispatch, scoped settings
rows). `/` mirrors the TUI's `/` to start the filter (start_filter), so
muscle memory carries across surfaces. The scoped dispatch gates on the
file browser being the active pane, the same way `handleGitShortcut` gates
on the git view.

### 1.2 Match scope

**Decision revised after finding the mobile precedent: the desktop
filter follows mobile's server-side `q=` pattern (debounced, paginated),
not client-side filtering.**

- Mobile already runs this exact flow in production (section 0): input
  debounces 500ms, hits the tree route with `q=`, appends pages via
  `offset`/`limit`, stops on `truncated`. Desktop copying it keeps the
  two webui surfaces consistent and gives recursive (deep) matching for
  free; the BFS already exists server-side (file_browser.rs:836-933).
- Client-side filtering over `flattenEntries` would restrict matches to
  the loaded tree and diverge from mobile for no gain.
- The TUI stays as is: it already uses the same route through
  `file_search` (mod.rs:141-152).
- Deep search overlap with the palette is accepted: mobile already has
  both (in-screen filter + palette), so precedent says they coexist.

### 1.3 Hide vs. highlight

**Decision: the filtered view replaces the tree with the server's match
list (mobile's model: `local.entries` becomes the results), and every
returned row gets the yellow mark on the matched substring. The active
match row gets a distinct treatment on top.**

- Passing `filterTerm: filterText` to the shared renderer gives the
  yellow marks; nothing else needs to change in the renderer.
- The server already returns only matching entries (verified live,
  section 3), so "hiding" is inherent: `entries` is the match list.
- Clearing the filter refetches the normal tree (mobile's `clearFilter`
  does exactly this).

### 1.4 Filter input placement and behavior (webui)

**Decision: a filter row at the top of the file browser panel, after the
`.file-browser-head` block (the panel is `.file-browser-side` → head →
body, file_browser.js:1157), styled after `.git-ui-file-filter`
(git_ui/layout.css:497-522). Contains: input, status text, and a clear
(×) button.**

- Input wiring copies mobile: 500ms debounce, Enter commits immediately,
  Esc clears and restores the tree (mobile file_browser.js:847-856).
- On commit, `loadTree` is called with `q=` (server-side, paginated),
  replacing entries with the match list. First page replaces, later
  pages append (mobile `loadFiltered`).
- Jump to first: on results arrival, select the first result row and
  `scrollIntoView({block:"nearest"})`.
- Match count display: the payload has no total (only `truncated`,
  file_browser.rs:1600-1607), so the count line shows what is real:
  "N shown · more" when `truncated` is true, "N shown" otherwise.
  No fabricated totals.
- Empty state: "No matches" inline; input keeps focus.
- Active match row gets a class (e.g. `.herdr-tree-row.filter-active`)
  on top of the yellow mark.

### 1.5 Cycling ↑/↓ between matches (webui)

**Decision: ↑/↓ inside the filter input cycle the active match with
wraparound, scrolling it into view and selecting it. Outside the input,
with a filter active, the tree keeps normal keyboard behavior.**

- This is find-bar behavior, matching the editor find bar
  (files/find.rs TUI precedent) and browser find bars.
- Wraparound at both ends (last match + ↓ = first, first match + ↑ =
  last).
- The selection follows the active match (selected row = active match
  row) so Enter opens the file the user is looking at.
- ‹ › pointer fallback buttons next to the status text for pointer
  users, same cycling, wiring through the existing click-delegation
  pattern in file_browser.js (no new global listener).
- The scoped chord from 1.1 (`/`) opens/focuses the filter; cycling stays
  on raw arrows in the input. If a later cut wants chord cycling from the
  tree, it is a new scoped entry (`fileBrowserMatchNav`), not built now.

### 1.6 Configurable in settings (webui)

**Decision: shortcut editor gets a "File browser" group with two rows:
"Filter" (default `/`) and "Next match" (default ArrowDown, Shift+ = prev
if ever chord-cycled; for this cut the arrows live in the input, so the
row records the down-arrow action and displays but never conflicts with
global shortcuts because the scope gate fails closed).**

Simplified: one group, two rows. "Filter" opens/focuses the input; "Next
match" is listed for discoverability, its default (ArrowDown) only applies
within the filter input, and Record/Clear works on both rows. Everything
goes through the existing `data-shortcut-record` delegation
(bindings.js:142-158) and `renderShortcutEditor` (core.js:962); no new
settings machinery.

### 1.7 TUI additions

**Decision: keep the TUI's server-side search flow untouched; add the two
missing pieces: yellow substring highlight in tree rows, and match
cycling + jump-to-first.**

- Highlight: `render_file_tree` (render/mod.rs:469) gains a highlight
  pass. Server rows carry the name; split the displayed name into
  matched/unmatched spans styled with `p.yellow` on the matched part
  (theme.rs:102; same yellow as the webui token).
- Jump to first: on commit, `selected` moves to row 0 of the filtered
  entries (server already returns only matches), status line unchanged.
- Cycling: nothing to build. With a committed filter, every visible row
  is a match (the server returns only matches), and j/k/↑/↓ already
  walk the list (mod.rs:2476-2477), so the selection is the active
  match. Wraparound exists via move_selection. Jump-to-first plus the
  existing movement covers the ↑/↓ requirement.
- Configurable: TUI shortcuts are hardcoded today (keys.rs); the TUI
  settings overlay is informational only. Rebinding in the TUI is out
  of scope for this cut. Parity note in docs/tui-shortcuts.md.

### 1.8 Open question deferred to implementation

- Whether the webui active-match row class also bumps scroll-margin or
  relies on `scrollIntoView({block:"nearest"})` alone. Implementation
  detail.
- e2e harness check for typing into the filter input; the harness
  supports text input elsewhere (settings search), so likely fine.

## 2. Implementation order

1. Webui: filter row + mobile-style wiring (500ms debounce, Enter
   commit, Esc clear) + server `q=` results replacing entries + yellow
   marks via `filterTerm` (tokens already exist).
2. Webui: jump-to-first on results arrival + ↑/↓ cycling in the input
   + status text (N shown, more indicator) + pointer buttons.
3. Webui: scoped shortcut table (`fileBrowserShortcuts`, default `/` for
   filter, gated on the file browser being the active pane) + shortcut
   editor "File browser" group + Record/Clear wiring.
4. TUI: yellow substring highlight in render_file_tree + jump-to-first on
   commit (cycling is already j/k/↑/↓ over the all-matches list).
5. Docs: tui-shortcuts.md (files: filter highlight + first-match jump),
   parity plan (close file explorer gaps 16-22 references), this doc
   updated with outcomes.

## 3. Tests

- `just test-js`: new cases in desktop_file_browser.test.mjs for filter
  state, server `q=` request shape, debounce commit, clear/Esc restore,
  jump-to-first on results, ↑/↓ cycling wraparound, status text, and
  `filterTerm` mark output. Note: the mobile filter has **no test
  coverage today** (no mobile test file covers filterTimer/loadFiltered/
  clearFilter), so the desktop cases will be the first tests for this
  pattern. The shared renderer path has no dedicated test file either;
  it is covered indirectly via desktop_file_browser.test.mjs and
  git_ui_behavior.test.mjs (both load the real renderer). Observed
  directly: `highlight('README.md','readme')` →
  `<mark class="herdr-tree-hit">README</mark>.md` in the shipped module.
- TUI: unit test for the highlight split (matched/unmatched spans) and
  the select-first-on-commit transition.
- Baseline verified on this branch before any implementation: node --test
  src/assets/*.test.mjs → 1303 pass, 0 fail; cargo test → 1157 pass
  across all suites, 0 fail (exit 0). One perf-guard test,
  `builtin_binary_input_path_is_not_the_bottleneck`, is machine-load
  sensitive: it failed intermittently in earlier full-suite runs while
  compile jobs ran concurrently, then passed isolated, in the
  single-suite run, and in the final clean full-suite run. Its failure
  mode is a wall-clock throughput assertion under concurrent compile
  load; this branch's commits are all markdown-only, so they cannot
  affect the compiled binary.
- Route behavior verified against a real isolated server instance (own
  XDG_CONFIG_HOME and --session, never touching a running instance):
  /api/file-browser/tree with q=design over docs/ux returned 6 entries,
  all name-matching, from 18 unfiltered. Server-side filtering returns
  only matches, confirming the TUI design premise that after commit
  every visible row is a match.
- e2e baseline: scripts/e2e/run-keyboard-guards-e2e.sh PASSED on both
  layouts (isolated server + headless Chrome against the real served
  app).

## 4. Merge overlap with the sibling worktree

The resizable-sidebar session owns bindings.js, core.js, render.js, and
base.css. This feature touches core.js (shortcut editor group) and
bindings.js (no changes expected: delegation already generic). Steps 1-2
touch only file_browser.js, file_tree.js options, and file_tree.css, plus
test files: no overlap. Step 3 is the collision risk: rebase after the
sibling lands, keep the shortcut editor change additive (new group only).