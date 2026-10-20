# File browser expand jump: findings and fix design

Examination notes for the second examine request: expanding a folder in a
large file list visibly shifts the rows on screen, sometimes pushing the
row the user is reading out of the viewport. Traced through the desktop
file browser render path and reproduced live against an isolated server
plus headless Chrome. Both user-visible shifts and their two independent
mechanisms are measured below. The examination itself changed no product
code; after the findings were confirmed, the section 3 fix was
implemented in product source on this branch (see the validation block in
section 3) and every probe now measures delta 0.

## 0. What exists today (verified)

**Expand renders twice on first open** (`src/assets/desktop/file_browser.js`):
`toggleDir` (1231-1250) sets `expanded[path]`, renders once with the
folder marked expanded but no children yet (`state.loading[path]` gates
only the fetch; no renderer reads it, so the first render differs from
the collapsed state only in the caret icon), awaits the fetch, then
renders again with the children. Collapse and any already-cached expand
render once.

**Scroll restore is pixel-anchored**: `renderPreservingScroll` (311-321)
saves `.file-browser-side` scrollTop, `render()` replaces
`panel.innerHTML` wholesale (1158), then writes the same pixel value
back. `overflow-anchor: none` (desktop/file_browser.css:22) is set so
Chrome's own scroll anchoring does not fight that restore. The tree
container is `.file-browser-side` in both hosted and legacy layouts; the
old `.file-browser-pane-body` surface exists only in chrome.css scrollbar
styling and a test fixture list, with zero JS references.

**Rows are CSS-virtualized** (shared/file_tree.css, added in
commit 00a3b572; state before this branch's fix):

```css
.herdr-tree-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 26px;
}
```

`content-visibility: auto` skips layout and paint for offscreen rows and
uses `contain-intrinsic-size` as the height estimate until the row comes
near the viewport. The commit comment assumes a "stable single-line
height".

**Rows are single-line by construction**: the name cell is
`white-space: nowrap` with ellipsis (shared/file_tree.css:65-69), the meta
badge is one 11px span. So row height is genuinely uniform per row kind.

**Measured row geometry** (live, 900px viewport, border-box):
realized dir row 29px = 17px content + 10px padding + 2px border.
A row that has never been near the viewport reports the placeholder
38px = 26px intrinsic content + 10px padding + 2px border. The intrinsic
constant is 9px taller than the realized content box, so every
not-yet-rendered row overestimates by 9px. The current-directory row
measures 31px realized (wrapped by `.herdr-file-tree-current`,
shared/file_tree.css:38-42) and 38px as a placeholder.

## 1. Live reproduction

Harness: `scripts/e2e/run-expand-jump.sh` (committed alongside this
doc) boots an isolated server (own XDG_CONFIG_HOME under a
temp dir, unique `--session` and port, `--backend-mode builtin`, self-signed
HTTPS) plus `chrome-headless-shell` over CDP, builds a fixture repo of 200
dirs x 20 files, opens the workspace through the real funnel
(`POST /api/recent-workspaces` from node, then the routed
`/session/default/workspace/<id>` URL), expands the sidebar, scrolls, and
clicks the real caret of `dir-5`. `dir-5` sorts lexicographically at row
146 of 200 (after `dir-49`, before `dir-50`: the `dir-1xx` block takes
indices 0-110, so `dir-5` lands in the `dir-5x` region), doc offset
~5490px. The marker is the
mid-viewport row; the metric is the marker's viewport-Y from caret click
to settled state. Row-level instrumentation samples heights at every
mutation and scroll event through a panel-level observer: listeners on
the scroller itself die with the first `innerHTML` wipe, which is how
the early runs in this session produced bogus zero and "+61px transient"
readings. The corrected harness reproduces a real +61px settled shift for
the first expand at 3000 (481 to 542px), so the figure itself was right
even though the first measurement of it was not; all numbers below come
from the corrected runs.

Evidence JSONs (setup, both passes, full event log with per-row heights,
settled height distribution):
`$JCODE_SCRATCH_DIR/expand-jump/expand-jump-{1200,3000,6500}.json`,
one per scroll offset.

| E2E_SCROLL | dir-5 vs viewport | Pass | Marker at click | Marker settled | Shift |
|---|---|---|---|---|---|
| 1200 (control) | below | first expand | 475px | 475px | 0 |
| 1200 (control) | below | cached expand | 475px | 475px | 0 |
| 3000 | below | first expand | 211px | 542px | +331px |
| 3000 | below | cached expand | 542px | 542px | 0 |
| 6500 (canonical) | above | cached expand | 482px | 1208px | +726px |
| 6500 (canonical) | above | first expand | 255px | 1402px | +1147px |

Notes on the table:

- The canonical row is the reported bug: expanding a folder **above** the
  viewport with the marker below the insertion point. The cached expand
  (single render, no network) shifts the mid-viewport row down 726px,
  which matches the settled height of the 21 inserted child rows
  (children settle at 29px realized or 38px placeholder, plus the 3px
  grid gap; the run's logged height distribution shows both
  populations). The 900px viewport loses that row entirely: it ends
  308px below the fold. The first expand measures larger (1147px). The
  original passes are not directly comparable: the first runs two renders
  at a clamped scrollTop (6252) while the cached pass sits at 6500, so
  part of the difference is geometry, not render count. Controlled
  re-runs with the pre-click drift fully settled before the click
  measure +1147px (marker 447 to 1594 at scrollTop 6252, reproduced
  across four settled-baseline runs) and on one later re-run +1120px
  (marker 447 to 1567 at scrollTop 6279): the settled pre-click mix
  varies by a few realized rows, moving the clamp and the picked
  marker row slightly, and the landed marker document offset is the
  same 7846px in every run. The finding is robust either way: the
  settled baseline contributes nothing to the delta, so the extra
  ~421px belongs to the first-expand pass itself (the second wipe
  lands on a tree with a taller placeholder mix above the viewport),
  while the exact 421px row-level split stays unobserved because the
  stored evidence samples only the first 30 indices of each height band.
- The 3000 rows show a shift with **no insertion above the marker at
  all** in the first expand: `dir-5` sits below the viewport there, so
  the marker is above the insertion point, and the visible content
  still moved 331px. That shift is mechanism B operating alone. The
  cached expand at 3000 measures 0 at settle because the same rows
  re-realize to the same heights around the same viewport; the wipe
  still resets the band (the render-time sample shows the marker at
  1082px mid-pass) and the position reconverges, so the flash
  mechanism below applies there too, just with a zero net landing.
- Baselines drift before the click (211px and 255px vs the 475-482px
  settled baseline) because the tree was still realizing rows; the drift
  itself is mechanism B and is detailed below.
- Scrollbar churn across one first expand at 6500: scrollHeight goes
  7152 (click) to 8392 (wipe frame, 202 rows all placeholder) to 9253
  (children wipe, 223 rows all placeholder) to 8299 settled. The thumb
  resizes through every step.

## 2. Mechanisms

### A. Pixel anchor versus insertion (the reported bug)

scrollTop is a distance from the top of the content, not a pointer to a
row. `renderPreservingScroll` puts the same pixel value back, so any
height inserted above the viewport pushes every visible row down by
exactly that height. The cached-expand 726px measurement is the direct
proof. The same failure moves content **up** on collapse when the
collapsed folder is above the viewport, and applies to every re-render
that inserts or removes rows above the fold, not just expand.

### B. Virtualization reset on every render (independent of insertion)

`content-visibility: auto` remembers the last rendered size per element.
`render()` wipes `panel.innerHTML`, so all rows are new elements on every
render: the entire tree resets to the 26px intrinsic estimate, which is
9px taller per row than reality. Rows near the viewport re-realize
asynchronously in the following frames; rows far above or below stay
placeholder until scrolled to. Consequences, all measured:

- **Content moves under a constant scrollTop.** In the 3000 run the
  marker sat at 1082px in every mutation sample and settled at 542px
  with no scroll event between them, purely from rows above it
  switching between placeholder and realized heights. In the 6500 run
  the scroller was asked for scrollTop 6500 in setup but read 6252 at
  click time: the tree measured 7152px while partially unrealized
  (6252 + 900 client height), so the browser clamped the scroll
  position 248px with zero user interaction.
- **Every re-render churns the placeholder mix.** The +331px at scroll
  3000 with the insertion below the marker shows the reset shifting
  settled content on its own. After the restore the visible band sits
  at placeholder-geometry positions and slides while rows re-realize:
  in the 6500 run the post-wipe samples show the marker at 1928px
  (cached pass) and 2176px (children render of the first pass) against
  settled positions of 1208px and 1402px. Mutation samples fire
  during the DOM churn, so the mid-wipe layout itself may never paint
  (the cached pass restores scrollTop in the same task); the
  post-restore slide and the scrollbar resize are the user-visible
  part, and the 3000 cached pass shows the same 1082px mid-pass
  sample reconverging to 542px.
- **The settled height distribution confirms the two row populations.**
  At scroll 6500 the settled tree holds 122 rows at 38px and 79 at 29px,
  and at scroll 3000 the split is 90 at 38px, 111 at 29px. In both runs
  the topmost rows measure 38px and the first 29px row appears at index
  122 (6500) and 36 (3000), tracking the viewport plus the browser's
  realization margin; the stored evidence keeps the first 30 indices of
  each population, so the band between those boundaries is inferred
  contiguous from the counts, not sampled row by row.

### C. Why only huge lists show it

The control run (scroll 1200, ~30 rows above the viewport) measures zero
shift in both passes: everything above the fold sits inside the browser's
realization margin, so the post-wipe layout matches the pre-wipe layout
immediately. Mechanism B needs a placeholder band above the viewport,
mechanism A needs insertion above the viewport, and both need a list
taller than the viewport. On short trees the bug is invisible, which is
why it reads as "expanding a folder in a huge list shifts the list".

## 3. Fix design

### 3.1 Deterministic row height (removes mechanism B)

Rows are already single-line (verified in section 0), so an explicit
height is safe and makes placeholder and realized boxes identical:

- `.herdr-tree-row { height: 29px }` (or the metric-derived value:
  12px font line box + 10px padding + 2px border; pick from measurement,
  not a magic number).
- The current-directory row needs its own explicit height (31px
  measured) because `.herdr-file-tree-current` wraps it in a padded,
  bordered block (shared/file_tree.css:38-42); leaving it auto would keep
  a 7px drift above the viewport.
- `contain-intrinsic-size` then matches the real box and virtualization
  stops changing layout at all. Scrollbar math becomes exact, the clamp,
  the pre-click drift, the transient flash, and the thumb churn all
  disappear, and mechanism B is gone for every re-render path (refresh,
  git status arrival, rename), not just expand.

Rejected alternative: correcting only the intrinsic to 17px. It reduces
the error to font-metric variance across platforms instead of removing
it, and it leaves nothing testable pinning row height to the font.

### 3.2 Row-anchored restore (removes mechanism A)

Anchor the viewport to a row, not to a pixel distance. In
`renderPreservingScroll`, before `render()`:

1. Find the anchor row: the first row intersecting the scroller's top
   edge. Record its `title` (full path, already unique per row) and its
   viewport offset: `rect.top - side.getBoundingClientRect().top`.
2. After the wipe, resolve the row by `title` and set
   `side.scrollTop = rowDocOffset - viewportOffset`, where
   `rowDocOffset = row.getBoundingClientRect().top + side.scrollTop -
   side.getBoundingClientRect().top` computed before the assignment.
3. Fallback to the current scrollTop when the anchor row no longer
   exists (filtered out, renamed, root navigation). The pixel fallback is
   exactly today's behavior, so the anchor can only improve on it.

With 3.1 in place the restore is exact in one synchronous step: rows
above the viewport have identical placeholder and realized heights, so
the doc offset is stable the moment the DOM is built. Without 3.1 the
anchor lands on the placeholder layout and realization shifts it again,
so 3.1 is the prerequisite and 3.2 the correct anchor. Collapse gets the
same guarantee through the identical path (`toggleDir` collapse renders
once): rows removed above the viewport pull the anchor's doc offset up,
and the restore pins the anchor row to the same viewport offset.

Validation status of this design. The fix is now implemented in product
source (3.1 in shared/file_tree.css, 3.2 inside renderPreservingScroll
in desktop/file_browser.js) and validated live by re-running the
committed probes against the fixed binary (build from this branch):

- 3.1 applied: `.herdr-tree-row` gets `height: 29px` with
  `contain-intrinsic-size: auto 29px`, and the current-row wrapper
  (`herdr-file-tree-current > .herdr-tree-row`) gets `height: 31px`
  with `contain-intrinsic-size: auto 31px`. `content-visibility: auto`
  stays, so the paint skip survives; only the height ambiguity dies.
  Mobile is untouched (mobile/app.css owns its own row rules and the
  mobile boot never loads file-tree.css).
- 3.2 applied: renderPreservingScroll now captures an anchor (first
  row intersecting the scroller top edge, keyed by its title) before
  render(), resolves it after the wipe, and writes
  `scrollTop = rowDocOffset - viewportOffset`; when the anchor row is
  gone (filter, rename, navigation) it falls back to the old pixel
  restore, which is exactly the pre-fix behavior.
- Measured on the fixed binary, committed probes, three scroll offsets
  (expand-jump-experiment, first + cached expand at each):
  1200 control delta 0, 3000 delta 0 both passes (was +331 first),
  6500 canonical delta 0 both passes (was +1147/+726). The canonical
  run shows the anchor doing its job: insertion above the viewport
  moves scrollTop 5676 to 6348 (+672, the exact inserted height) while
  the marker holds 447 to 447. The collapse probe (removal above the
  viewport) measures delta 0 too (scrollTop returns 6348 to 5676,
  marker 447 stable; was -672 before the fix). The first-pass repro
  scenarios (A/B/C) all report delta 0. Row heights log exactly 29px
  and 31px with no drift band, and the pre-click drift window is gone.
- Regression surface: all 47 frontend .test.mjs files pass and the
  Rust lib suite passes (398 tests) with the fix in place; the search
  palette probe still reproduces its own (unfixed, separate) 41px
  placeholder behavior, unchanged by this fix as expected, since
  the palette bullet is a separate surface listed in 3.3.

History: before implementation, each half was validated by injection
into a live boot (no product source touched, probes committed under
`scripts/e2e/`):

- 3.1 injected as page CSS (29px rows, 31px current row, 17px content
  intrinsic): row heights come out exactly 29/31, the tree stops
  drifting (marker holds to the pixel across a 2s no-interaction
  window, versus the 475-to-211-class pre-click drift today), the
  setup clamp becomes deterministic (asked 6500 lands 5676 and stays,
  because the true 29px tree is shorter than the placeholder-inflated
  one), and the cached-expand delta drops to +672px = 21 children x 29px
  + 21 x 3px gap, matching the collapse measurement exactly. Mechanism
  B is gone with 3.1 alone; the remaining 672 is pure mechanism A.
- 3.2 cannot be validated by patching the DOM from outside:
  `renderPreservingScroll` is closure-scoped, and an element-level
  scrollTop interceptor (own-property accessor installed on the
  scroller) is destroyed by the first innerHTML wipe together with the
  scroller element itself, the same listener-death mechanism documented
  in section 1. Probe runs with the interceptor installed reproduce the
  unfixed baseline (+1147/+726/-672). This confirms the fix must live
  inside `renderPreservingScroll` in product code, as designed. The
  anchor arithmetic itself is exact once 3.1 holds: with deterministic
  heights, resolving the same row post-render yields the same doc
  offset, so the restore compensates insertion above the anchor fully
  and the expected marker delta is 0. The implementation above confirms
  that prediction: all deltas measure 0.

Repo precedent: the mobile lens compensates prepended pages by
`scrollTop + (scrollHeight - anchorHeight)` (mobile/lens.js:926,
961-963). The file browser cannot use the total-height delta because the
wipe changes height in both directions and reorders rows; identity-based
anchoring is the general form.

Rejected alternatives: compensating pixel restore with inserted-height
arithmetic (fragile once filters, sorts, or the 1000-entry truncation
from file_browser.rs:25 reorder the list); re-enabling
`overflow-anchor` (the wipe destroys the browser's anchor node, so Chrome
cannot anchor across an `innerHTML` replacement).

### 3.3 Surfaces sharing the pattern

- **Search palette**: `renderSearchPalettePreservingScroll`
  (desktop/search.js:402-407) is the same pixel restore over
  `.search-result` rows that carry their own
  `content-visibility: auto; contain-intrinsic-size: auto 41px`
  (desktop/search.css:199-203). Same bug family, same fix template.
  Measured live: a content query that fills the palette, scrolled to
  3000, then a preserveScroll re-render keeps scrollTop pinned at 3000
  while the container shrinks 486px (scrollHeight 8725 to 8239), so
  content moves under a constant scrollTop exactly like mechanism B.
  One scope note from the same probe: the bulk of a content result
  list is rendered as `.herdr-content-search-*` rows, which are outside
  the `.search-result` virtualization rule, so the 41px placeholder
  error specifically needs a result set with many `.search-result`
  rows to show; the pixel-restore failure shows regardless.
- **Git log**: virtualized rows (git_ui/log.css:514-518) with pixel
  restore via `captureContentScroll` (git_ui.js:1085-1098). Log rows
  append at the bottom, so mechanism A is rare there, but mechanism B
  still perturbs the thumb on every render. Lower priority. Measured
  live at the final HEAD (git-surfaces-probe, real user path through
  the side toolbar log toggle): the pane mount surfaces at 710x865
  with `git:log` in the pane tree, 80 log rows carry computed
  `content-visibility: auto; contain-intrinsic-size: auto 30px`
  (realized rows 32px), and a content-neutral re-render under pinned
  scrollTop 600 holds the visible marker exactly (delta 0) while the
  content height shrinks 2753 to 2701 (-52px): offscreen rows below
  the proximity range reset toward the 30px placeholder, so mechanism
  B perturbs the thumb without moving visible content in this run.
  Earlier probe runs reported the mount as unsurfaceable in the
  headless shell; that was a probe bug, not a product limit: calling
  `HerdrGitUi.openViewTab` directly skips `paneEnsureGitTab`, so the
  tab never entered the pane tree and the render parked the mount
  hidden. The committed probe now goes through the toggle button.
- **Git side tree**: correction from the live run. Earlier source
  inspection said the side tree is not virtualized; that is stale:
  desktop boots load shared `file-tree.css`, whose `.herdr-tree-row`
  rule covers the git side rows too, and the live probe measured
  computed `content-visibility: auto; contain-intrinsic-size: auto
  26px` on side rows (37 rows, scrollHeight 1160). So the side tree
  has the same placeholder error exposure as the file browser. The
  measured pixel restore is still exact today (content-neutral
  re-render under pinned scrollTop 40: delta 0, marker height stable
  at the realized 27px, scrollTop restored 40 to 40), but that safety
  comes from the rows being single-height in this fixture (27px
  realized vs 26px intrinsic), not from the absence of
  virtualization; the same cv-auto/26px placeholder risk as 3.1's
  29-vs-26 gap applies as soon as realized heights diverge from the
  intrinsic guess.
- **Mobile file browser**: no content-visibility on tree rows, and the
  lens already anchors prepends. Unaffected. Confirmed live
  (mobile-tree-probe): in the mobile layout the tree rows compute
  `content-visibility: visible; contain-intrinsic-size: none` (1001
  rows, no virtualization), and expanding a directory is a navigation,
  not a splice: the row set changes wholesale (1001 rows at the repo
  root become 22 child rows in the target dir) and scroll resets with
  the new screen by design, so there is no in-place insertion above
  the viewport and no pixel-restore path to break.
- **TUI**: `toggle_expand` splices children in place below the cursor
  (tui/panels/files/mod.rs:170-200) and the list window is computed from
  the selected row (tui/render/mod.rs:527-531), so the cursor row stays
  centered by construction. Nothing to change. Verified at the final
  HEAD by the committed unit tests:
  `toggle_expand_merges_children_and_collapses_back` and
  `open_preview_on_dir_expands_and_ctrl_r_reloads` (expand merges the
  child entries below the cursor, collapse drains them, both pass;
  full tui:: suite 349 passed) plus a frame's list window start
  recomputed from `selected` every render, so insertion cannot shift
  the viewport the way the DOM surfaces do.

## 4. Tests

- **Acceptance (real browser)**: turn the committed harness
  (`scripts/e2e/run-expand-jump.sh` plus
  `scripts/e2e/expand-jump-experiment.mjs`) into an asserting e2e in
  the style of `run-keyboard-guards-e2e.sh`, asserting `|marker delta|
  <= 2px` for cached and first expand at the three scroll offsets,
  plus collapse above the viewport. The runner already isolates its
  server and Chrome; the result JSON it drops at the repo root should
  move under its temp dir (or `$JCODE_SCRATCH_DIR`) so it never lands
  in a commit.
- **Source assertions** in the `app_load.test.mjs` style: explicit
  `.herdr-tree-row` height present, current-row height present,
  `renderPreservingScroll` captures a row anchor before `render()`.
- **Perf guard**: the virtualization rule exists to keep long lists
  cheap (commit 00a3b572). The fix must keep `content-visibility: auto`;
  explicit height preserves the layout and paint skip while removing the
  height ambiguity.

## 5. Evidence

- `$JCODE_SCRATCH_DIR/expand-jump/expand-jump-1200.json` (control),
  `expand-jump-3000.json` (insert below viewport),
  `expand-jump-6500.json` (canonical insert above viewport). Each file
  holds the setup geometry, both passes with click-time and settled
  marker positions, the full mutation and scroll event log with sampled
  row heights, and the settled per-row height distribution.
- Harness scripts (committed alongside this doc, proposed as the
  acceptance test base in section 4):
  `scripts/e2e/run-expand-jump.sh`,
  `scripts/e2e/expand-jump-experiment.mjs`, and
  `scripts/e2e/run-expand-repro.sh` plus `expand-scroll-repro.mjs`
  (first-pass reproduction), and `scripts/e2e/probe-layout.mjs`
  (scroller box and ancestor probe). A second probe suite,
  `scripts/e2e/run-expand-deep-probes.sh` plus `expand-deep-probes.mjs`,
  covers the deep-validation round: listener death on the scroller, timer
  sampling of the post-restore slide, click-task atomicity of the cached
  expand, and the settled-baseline controlled first expand cited in
  section 1. `scripts/e2e/run-collapse-probe.sh` plus `collapse-probe.mjs`
  measure the collapse shift (-672px), and `scripts/e2e/`
  `run-fix-design-probes.sh` plus `fix-design-probes.mjs` and
  `run-anchor-restore-probe.sh` plus `anchor-restore-probe.mjs` validate
  the section 3 design by injection (CSS-fix measurements and the
  interceptor-death finding), and `run-search-palette-probe.sh` plus
  `search-palette-probe.mjs` measure the palette bullet in 3.3. A
  sibling-surface round covers the remaining 3.3 bullets live:
  `run-git-surfaces-probe.sh` plus `git-surfaces-probe.mjs` (git log
  pixel measurement through the side toolbar toggle, git side tree
  cv-auto/26px correction and the pinned-scrollTop delta-0 re-render)
  and `run-mobile-tree-probe.sh`
  plus `mobile-tree-probe.mjs` (mobile layout rows compute
  visible/none, expand navigates rather than splices). The TUI bullet
  is covered by the committed unit tests named in 3.3. Logs under
  `$JCODE_SCRATCH_DIR/` `expand-jump-verify/` and
  `expand-jump-final/`.
- The evidence JSONs store the first 30 row indices of each height
  population, not a full per-row dump; row-band claims above are
  bounded by that sampling.
- Source pins cited inline per section. All measurements come from the
  shipped renderer booted from `target/debug/herdr-webui` with the
  desktop layout forced (`herdr-web-layout` = `desktop`), sidebar
  expanded via `HerdrRightSidebar.setCollapsed(false)` because boot
  restores it collapsed and a collapsed sidebar renders a 0x0 scroller.