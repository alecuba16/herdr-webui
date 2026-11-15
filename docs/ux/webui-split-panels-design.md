# WebUI split-panel session tree design

Status: implemented on the `split_panel_ux` branch (slices 1-5). This
document describes the shipped behavior and the invariants the tests
enforce, so future changes keep them. Proposal source with the decision
log (D1-D14): `~/.jcode/scratch/split-panel-proposal/proposal-v1.md`.

## Problem

Splits were per-workspace. A workspace close destroyed its panes, a
panel could not live next to another workspace's panel, and every
reflow event (split, maximize, divider drag, editor stint) destroyed
aux terminal scrollback plus live view. The tree also pruned stored
tabs against workspace-filtered lists, so a stored layout could load
ghost panes the backend never had.

## Session-global tree (D1)

One split tree per session, stored in browser storage
(`herdr-web-workspace-panes`, key `__session__`), not per workspace.
A tree is "mixed" when any leaf resolves a foreign workspace id; a
single-workspace tree renders exactly like the old per-workspace one.
Legacy multi-entry blobs load their first entry as the session tree
and drop the rest (pane layouts are cheap to rebuild, and the sync's
prune sweeps stale ids on the first snapshot).
The sync universe is every workspace's panels: `state.tabs` holds the
selected workspace's rows, the unfiltered `tabsById`/`panesById` maps
carry the rest, and one row names a terminal either way.

Placement keeps the one-home rule: a terminal id that already lives in
a leaf stays there, homeless ids land in the sync target (a pending
`+` placement from a specific pane wins while it has work to do).
Duplicated ids across leaves (mid-drag crash, stale stored tree)
repair at sync: the first leaf in tree order wins the id, later copies
drop, and a leaf emptied by the repair collapses inside a split. Dead
ids stay in place until the prune pass so its emptied-leaf collapse
still fires.

## Routing and the shell owner (D2, D12)

The route (`state.tab`) is the single authoritative focus: it derives
from selection history and persists across reloads; `activePaneId`
follows it. One owner leaf renders the singleton shell
(`#terminalShell`): the route tab's leaf, else the first
terminal-active leaf, else the seeded/active leaf. Every other
terminal leaf renders an aux surface. When the owner leaf's active tab
is a non-route terminal (a drop landed one there), the shell parks and
the owner leaf hosts an aux surface too, so the shell never renders
one pty under another tab's highlight (D7.4).

## Aux surfaces (D8)

A non-owner leaf with a terminal renders its own surface: its own wterm
instance plus its own `/ws/terminal` socket, keyed by tab id in a
session-scoped cache. Lifecycle:

- Attach on first render; detach on hide. Parked (hidden) surfaces
  keep the wterm instance and scrollback but lose the socket, per the
  no-sockets-for-non-visible rule. A park happens on maximize, an
  editor stint, an owner flip, or the tab leaving the rendered set.
- A return re-parents the same container into the leaf's slot,
  un-pauses rendering, and re-attaches; the server replay rehydrates
  the view, scrollback intact. Drag remounts the DOM node without
  touching the wterm instance (D7.4 identity contract).
- Real disposal only on tab close (closeTab, `tab.closed`, last-pane
  exit) plus cap eviction.
- Cap of 8 aux surfaces, counting parked entries (each keeps a wterm
  instance plus scrollback). The owner does not count (8 aux + 1 owner
  = 9 terminals, beyond any sane visible layout). Eviction beyond the
  cap disposes least-recently-focused first, checked at every render
  pass.
- A socket that died while visible waits out a 4s backoff before the
  next render pass re-attaches, so a down backend cannot churn sockets
  at poll cadence.
- A second browser window doubles sockets: each window runs its own
  cache; the hub fan-out carries the cost. Known, documented here,
  not capped per session.

Registry surface: `window.HerdrPaneTerminals` (`ensureForLeaf`,
`parkForTab`, `releaseForTab`, `releaseStale`, `fitAll`,
`applyThemeAll`, plus `count`/`parked`/`cap` probes for tests).

## Resize (D9)

Divider-end refits aux grids in place (wterm resize, no dispose) and
ships the new grid to the pty over the socket with a debounced
`{type:"resize"}` message (200ms), the same message the primary shell
sends. Parked entries skip the fit (a display:none box would floor the
grid); a return refits from the live slot's box.

## Mixed-tree UI (D3, D4, D6)

- Workspace badge on the pane strip (only when the tree is mixed and
  the leaf resolves exactly one workspace): worktree name plus branch,
  else the workspace label. The label carries the meaning, the accent
  underline is decoration only. Clicking opens the workspace picker
  scoped to that pane (switch the leaf's context).
- Default-named panels carry a workspace prefix in their tab label (D15):
  a foreign workspace's default panel reads "<worktree/branch> N"
  (worktreeDisplayName, else the workspace label), rendered as a muted
  `data-ws-prefix` pseudo-element before the bare number. The selected
  workspace's own defaults stay bare, custom names never prefix, and a
  workspace record that does not resolve keeps the bare number. The
  prefix flips with the workspace selection (accepted trade-off: the
  pane badge names the leaf's workspace either way). The button's
  aria-label spells the full "Panel <prefix> <label>" string, and the
  hover title leads with "Workspace <id>" for foreign panels.
- The `+` picker lists workspaces and worktree rows; picking one
  opens a new panel from that workspace in this pane
  (`openPanelInWorkspace`). The picker delegates entirely to that
  entry; no private placement path exists.
- Sidebar workspace cards are draggable onto a pane strip (speed
  path): the strip shows an "Open terminal: <label> here" hint on
  dragover, the drop opens that workspace's terminal in the target
  pane, same as the picker.
- Terminal tabs drag between pane strips (D7): a drop moves the tab,
  follows the route when the route tab moved, and never disposes the
  aux surface mid-move. Dead-tab drops (the tab vanished behind the
  drag) refuse, not crash.

## Teardown (D10, D13)

`workspace.closed` and `worktree.removed` prune eagerly, not on the
next tick. A stored tab prunes only when its id is missing from BOTH
unfiltered lists, guarding snapshot inconsistency between the two
calls. On load, the stored tree prunes against the first unfiltered
snapshot before first render. A leaf left with zero tabs collapses
(single-child promotion), and an all-empty tree resets to the single
default pane.

## External backend (D11)

The transport side shipped: the snapshot enrichment builds the
unfiltered maps from any backend's response (builtin and external
herdr protocol 16 shapes), `POST /api/tabs` passes `workspace_id`
through to the API's `tab.create`, and `worktree.removed` events
prune the tree. The per-capability probe with a toast plus fallback
to per-workspace mode did not ship: the wrapper-side enrichment covers
the known external shapes, so an unexpected external build degrades
where it degrades (missing ids prune, cross-workspace placement
fails its POST) rather than breaking the tree.

## Residual (D14)

`state.ws` stays the default target for `+` and the file browser/git
drawer context. The mixed-tree badge makes the leaf's workspace
visible and correctable in place; a rail-header workspace chip is a
documented follow-up.
