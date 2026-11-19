# Central section v2: workspace-bound panel collector

Status: design under review. Branch: `pane_controls_bar`. Desktop only.
Supersedes the tab-leaf model in `workspace_panes.js` for the central
section; the location bar and both sidebars stay as they are.

## Decisions locked by the user

1. Every panel is always visible. Opening a workspace/worktree (or
   picking a workspace from the `+` picker) splits a new empty panel in
   beside the focused panel and focuses it.
2. A label chip sits on the leading edge of each panel's tab strip, only
   when more than one panel exists. The chip is the drag handle
   (re-dock left/right/up/down) and the click-to-focus affordance. No
   extra rows above the collector.
3. Sidebar workspace click: focuses that workspace's panel when one
   exists, else opens a fresh empty focused panel for it. The location bar
   always mirrors the focused panel.
4. `+` on the location bar: ALWAYS opens the workspace picker (one
   workspace included); picking a row creates a new empty panel bound to
   that workspace. The Ctrl+B then P chord follows the same contract.
5. Empty panel: shows the workspace path + a hint. Only Enter opens the
   terminal; typing does nothing (keyboard keeps its current behavior).
6. Right sidebar follows the selected panel (its workspace's shell mode).
7. Closing a workspace's LAST panel closes the panel's tabs and the
   workspace itself (cascade): every open workspace always has at least
   one panel, and the center and the sidebar never disagree.
8. Reuse: location bar, both sidebars, shell grid, resize/collapse, split
   tree, dividers, maximize, aux terminal surfaces.

## Model

### Panel = leaf, workspace-bound

One session tree per session (SESSION_PANES_KEY unchanged). Leaves re-bind:

```
leaf  := { kind:"pane", paneId, wsId, tabs:[tabId...], active, panelLabel? }
split := { kind:"row"|"column", sizes:[grow...], children:[leaf|split...] }
```

- `wsId` binds the panel to one workspace. One workspace may own several
  panels (the `+` flow); one panel holds exactly one workspace.
- Terminal tabs in a leaf resolve to `wsId` (checked via
  `tab.workspace_id`). Editor and git tab ids keep their identity scheme
  (`editor:<path>`, `git:<view-key>`) and the one-owner rule across the
  whole tree.
- `panelLabel` overrides the derived label when set.
- Leaf ids mint fresh as today (`p<n>` against `usedPaneIds`).

### Terminal surfaces

- `#terminalShell` stays the app's singleton surface and follows the route
  tab's leaf, exactly as today. `HerdrPaneTerminals` aux surfaces (cap 8)
  host every other visible terminal tab. Both unchanged.
- `syncTerminalTabsIntoTree` re-scopes per workspace: a ws's terminal ids
  live in leaves bound to that ws, one home per tab id across the tree.
  Dead-id prune and duplicate repair keep their current rules, applied
  globally.
- Placement of NEW backend ids (no home yet): the focused leaf bound to
  that ws, else the first leaf bound to it. If no leaf is bound to that ws,
  mint one beside the focused panel (auto-split) so the invariant holds:
  a ws with live terminals always has a panel.
- The terminal singleton at command time relaxes to "one shell per
  render": the current `terminalShellOwnerLeaf` logic already resolves one
  owner per render and every other terminal-active leaf mounts an aux
  surface. No change needed there.

### Focus and route

- The route (`state.ws`, `state.tab`) stays the global navigation truth.
  Focusing a panel (chip click, pane pointerdown via pane_focus.js, tab
  click) writes the route from that panel: its active terminal tab
  (ws+tab), or its `wsId` with tab null when empty.
- A route change (go(), boot restore, agent pick) re-focuses the owner
  leaf through the sync's route pass (unchanged mechanics:
  `lastSyncedRouteTab`, `sawExplicitActive`).
- pane_focus.js `activatePane` writes the route from the leaf's active
  tab or wsId binding.
- Right sidebar call sites pass the focused leaf's `wsId` (fallback
  `state.ws`), so its content follows the selected panel.

### Labels

- Derived label: workspace display name (`worktreeDisplayName(workspace)`
  for worktrees, else the workspace label). `panelLabel` overrides.
- Chip renders only when `paneLeaves(root).length > 1`. Single panel: no
  chip, strip shows tabs only.
- Chip markup joins the existing strip language: a `pane-panel-chip`
  button, draggable, click focuses its panel, title spells the drag and
  click affordances. Ellipsis truncation; the location bar keeps branch
  detail, the chip carries the name only.

### Empty panel

- Per-leaf empty state when `paneTabsForTree(leaf)` is empty: the content
  slot shows the workspace path (from the `state.workspaces` row) and the
  hint "Press Enter to open a terminal", styled after today's
  `#workspaceEmptyLeaf` card.
- Enter opens the terminal via `newTabForPane(leaf.paneId)` (placement map
  + fallback to discovery when no ws). One document-level keydown listener
  resolves the focused leaf and fires only when it is empty.
- Empty panels are valid states. The last close of a panel's tabs leaves
  the panel standing as an empty panel (no auto-collapse): panels die by
  explicit close only. This supersedes today's collapse-on-last-tab rule
  and the sync's prune-emptied collapse.
- The empty panel keeps focus; the location bar shows its ws chips.

### Label drag (re-dock)

- Dragging a chip moves its whole panel. Drop targets are the four edge
  zones of the collector (left/right/up/down), highlighted during
  dragover.
- Drop wraps the ROOT: left/up puts the dragged leaf before the old root,
  right/down after it. `newRoot = {kind:"row"|"column", sizes:[1,1],
  children:[dragged, oldRoot] | [oldRoot, dragged]}`. The dragged leaf
  keeps its tabs, active pointer, wsId, and panelLabel; surfaces re-parent
  on the next mount pass, nothing disposes or re-creates.
- Payload `text/herdr-panel-chip` carries the paneId; `effectAllowed`
  move. Edge zones are dragover/drop listeners on the central container,
  active only while a chip drag is in flight.
- Dropping outside the four zones cancels (no-op). Row-level re-dock
  beside a specific sibling is out of scope for v2.

### Close rules

- Tab close (terminal, editor, git): per-tab rules unchanged, except the
  emptied leaf stays standing as an empty panel (the Enter state); empty
  panels die by explicit panel close only, never by auto-collapse.
- Panel close (pane menu, pane controls bar): tabs migrate to the nearest
  surviving panel bound to the SAME workspace (`migrationTargetForClosedLeaf`
  walks same-ws survivors). Cross-workspace migration never happens (the
  wsId invariant forbids it). When no same-ws survivor exists (this was
  the ws's last panel), the panel's tabs close with the panel and the
  workspace closes too (decision 7): sidebar row leaves, backend close
  flow runs, remaining panels stay untouched.
- Workspace close (explicit sidebar close): every leaf bound to that ws
  drops from the tree with its tabs; the tree collapses as today. If the
  tree empties entirely it resets to the single default leaf and the
  dashboard state takes the center, same as today's no-workspace boot.
- The sync's auto-split mint stays as the boot/restore safety net: backend
  terminal ids for a ws with no panel (fresh boot, restored route) mint
  the missing panel beside the focused one instead of landing in a
  foreign leaf.

## Integration points

- `renderWorkspacePanes()` contract unchanged; `renderLeafInto` prepends
  the chip when >1 leaf and renders the per-leaf empty state.
- Per-strip controls: the [⋮] pane menu stays per strip; the pane controls
  bar in the location bar (paneBarControlsHtml, acts on the focused
  panel) keeps split right/down, maximize, close. Per-strip split and
  maximize buttons go (chip drag and the bar cover them); per-strip keeps
  [⋮] and the + (new tab into that panel).
- `newTabForPane` unchanged, now also the Enter path target.
- Left sidebar workspace click (core.js `navigateSelection` family):
  resolve panel of ws, focus it or mint an empty one. Agent rows keep
  go(ws, tab); owner resolution focuses the owning panel.
- Location bar `+`: a new chip in the existing chip row
  (`location-bar-plus-chip`, location_bar.css language) calling a new
  export `HerdrWorkspacePanes.newPanelForFocused()`.
- `pruneWorkspaceTabsFromPanes` becomes the ws-close leaf drop (above);
  the strip render filter keeps hiding unknown terminal ids.
- Persistence: same storage key. `normalizePaneTree` heals the new fields:
  missing `wsId` derives from the first terminal tab row, missing
  `panelLabel` stays unset (derived label). Old blobs load and derive.
  D1/D13 rules stay.

## Tests (node --test src/assets/*.test.mjs)

New `desktop_workspace_panes_collector.test.mjs`:
- ws-bound model: bind, per-ws sync, one-home across same-ws leaves, new
  id placement (focused leaf of ws, else first, else auto-split mint).
- Auto-split: workspace open and + create a leaf beside the focused one,
  focused on the fresh leaf (root-wrap and mid-array cases).
- Labels: chip only when >1 leaf; derived name; panelLabel override;
  hidden on single leaf.
- Empty panel: Enter fires newTabForPane with the focused empty leaf;
  typing inert; last-tab close leaves an empty panel standing.
- Edge re-dock: root-wrap for all four edges; dragged leaf identity
  intact; sizes normalize; drop outside zones cancels.
- Sidebar routing: focus existing panel of ws; mint empty panel when none
  exists; agent row focuses owner.
- Focus/route mirror: terminal-active focus writes route(ws, tab); empty
  focus writes route(ws, null); route change re-focuses owner.
- Close rules: ws close drops bound leaves, tree reset when empty;
  explicit panel close migrates same-ws, collapses, and the last-panel
  close cascades the workspace close (tabs + ws gone, sibling panels of
  other workspaces untouched); tab-close leaves the empty panel standing.

Existing panes/split tests rewrite to the new model where semantics
changed (collapse-on-last-tab is the big one).

## Live verify (8791, CfT CDP 9227)

- Workspace open: empty focused panel, path + hint; Enter: terminal.
- `+`: empty panel for focused ws; Enter: terminal.
- Second ws open: auto-split, chips on both strips; chip drag to each edge
  re-docks with highlight; sizes persist across reload.
- Sidebar click: focus and mint paths; location bar and right sidebar
  follow.
- Dividers drag, maximize, focus ring, tree persistence, old-blob
  migration.

## Out of scope

- Row-level re-dock beside a specific sibling.
- Mobile (loader gates the desktop bundle).
- Backend changes.
- Mixed-tree ws badge and `pane-owns-current` marker: superseded by the
  chip (the chip names the panel's ws; the CSS stays but the mixed-tree
  badge logic is dead once leaves carry wsId).

## Rollout (reviewable chunks)

1. Panel model: leaf re-bind, per-ws sync, close rules, persistence
   migration, tests.
2. Chips + focus routing + sidebar resolution + location bar `+`.
3. Edge re-dock drag + empty panel Enter + per-leaf empty card.
4. Docs (features.md section) + live verify pass.