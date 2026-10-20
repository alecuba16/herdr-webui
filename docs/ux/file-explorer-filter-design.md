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
  non-empty (mod.rs:141-152), replacing `entries` with the result rows. The
  render header shows `search results for 'q' in Files` plus a matched/total
  count (`src/tui/render/mod.rs:508,578`); `t` cycles the search kind and
  content search has its own results view with j/k cycling.
- So the TUI already filters (via server) and shows counts; it has **no
  substring highlight in the tree rows and no match-jump/cycle state**.
  The two gaps for this feature are exactly: yellow match highlight and
  ↑/↓ (or n/N) match cycling with jump-to-first.

**Webui desktop file browser (`src/assets/desktop/file_browser.js`):**
per-workspace `stateCache`, `flattenEntries`, `loadTree`, and **no filter
at all today**. The shared tree renderer (`src/assets/shared/file_tree.js`)
already supports a `filterTerm` option consumed by `highlight(entry.name,
opts.filterTerm)` at lines 142 and 192, emitting
`<mark class="herdr-tree-hit">`. Two production callers pass it today:
git side tree (`git_ui/side_tree.js:51`, `view.fileFilter`) and workspace
search results (`workspace_search.js:269`, `opts.query`). So the yellow
mark rendering path is proven; the file browser just never passes it.

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
- Known dead UI: the Search section's `optSearchShortcutCapture`/`Clear`
  buttons have no click listener anywhere (checked bindings.js,
  settings_sections.js, all assets). Not caused by this feature; backlog
  item.

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

**Decision: webui filters the visible flattened tree (flattenEntries
output), client-side. The TUI keeps its server-side search.**

- Webui trees load lazily (children fetched on expansion), so a
  full-subtree match would require server round-trips per keystroke.
  Client-side filtering over the loaded tree is instant and matches the
  git filterFiles precedent.
- Deep search already exists in the palette (`runPathSearch` via
  workspace_search.js) and in the TUI's server-side file_search. The
  filter's job is the visible tree; the palette's job is deep search.
- Follow-up: server `search_kind` support already exists in the tree route
  (file_browser.rs:126, 844), so a recursive mode could reuse it later.

### 1.3 Hide vs. highlight

**Decision: hide non-matching rows, and yellow-mark the matched substring
in matching rows. Plus a distinct treatment for the active match row.**

- The shared renderer's `filterTerm` already does the mark; passing
  `filterTerm: filterText` when rendering gives yellow marks for free.
- Hiding non-matches matches git filterFiles, settings search, and the
  TUI's filtered entries list (server already returns only matches).
- Hide-vs-mark is a data flow difference, not a rendering one: hidden rows
  stay in state, the flatten step skips them, and the render only sees
  matching rows. Cleared filter = full list restored, nothing re-fetched.

### 1.4 Filter input placement and behavior (webui)

**Decision: a filter row at the top of the file browser panel, styled
after `.git-ui-file-filter` (git_ui/layout.css:497-522), between the tree
header and the tree list. Contains: input, live match count ("3/7" or "No
matches"), and a clear (×) button.**

- Input events debounce (~150ms, git filterFiles cadence) then recompute
  matches and re-render the tree with `filterTerm`.
- Match computation: indices into the flattened visible rows where the
  entry name contains the query, case-insensitive. Same normalizer family
  as the palette path search.
- Jump to first: on commit (debounced recompute), select the first
  matching row and `scrollIntoView({block:"nearest"})`.
- Empty state: "No matches" inline; the input keeps focus so the user can
  fix the query.
- Esc inside the input clears the filter and restores the full list (TUI
  parity: Esc cancels the filter).
- Active match row gets a class (e.g. `.herdr-tree-row.filter-active`)
  on top of the yellow mark, so the current match is distinguishable from
  other matches.

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
- ‹ › pointer fallback buttons next to the count for pointer users, same
  cycling, wiring through the existing click-delegation pattern in
  file_browser.js (no new global listener).
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
  (theme.rs:102; same yellow as the webui token). Active filter header
  already shows matched/total.
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

1. Webui: filter row + debounce + hide-non-matches + yellow marks (pass
   `filterTerm` to the shared renderer; the yellow tokens already exist).
2. Webui: match list + jump-to-first + ↑/↓ cycling + count display +
   pointer buttons.
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
  state, match collection, cycling wraparound, clear/Esc restore, count
  text. The shared renderer path has no dedicated test file today; its
  output is covered indirectly via desktop_file_browser.test.mjs and
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
  load; this branch's two commits are markdown-only, so they cannot
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