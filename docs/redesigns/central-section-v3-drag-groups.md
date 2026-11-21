# Central section v3 addendum: half-region drags, preview, panel groups

Status: design under review. Branch: `pane_controls_bar`. Desktop only.
Addendum to `central-section-v2.md`: everything there stays except the
three sections this file rewrites. Implemented on top of the committed
v2 chunks (model re-bind, chips, per-leaf cards, Enter, edge re-dock).

## Decisions locked by the user (v3)

1. Dragging a panel label (chip) over a HALF of the collector (top,
   bottom, left, right) shows a live dotted, shaded square preview of
   where the panel will land; releasing applies the move there.
2. The same half-region preview + drop applies to any TAB drag
   (terminal, editor, git): dropping a tab on a half creates a new
   panel holding that tab at that half.
3. Split panels collapse into one GROUP label per group: the group
   label names the member count with a group icon. Non-grouped panels
   keep their standalone chips.
4. Dragging one member of a group OUT of the group (dropping it beside
   the group, not inside it) ungroups it into a standalone panel.
5. Chord and bar Split anchor on the leaf holding the ACTIVE terminal
   (route tab), not the focused leaf. Already shipped in v2 chunk D.

## v3.1 amendment: corner zones replace halves (user, Nov 16)

The half model above is superseded for the TRIGGER geometry only. The
preview and drop semantics stay exactly as v3 defined them; only WHERE
they trigger changes.

- Trigger zones: the four CORNER regions of the hovered pane, one third
  of each axis (both offsets within 1/3 of their sides). The middle
  cross is dead: no preview paints there, no drop lands there.
- Inside a corner, proximity to the two adjacent borders picks the
  split: nearer the top/bottom border stacks (up/down), nearer the
  left/right border sides (left/right). The corner's own side picks
  which half the dragged element takes (first vs after).
- Rationale: corners are unambiguous targets at the borders; the center
  stays a safe dead zone so over-aimed drops do not reshape the tree.

## Drop regions replace edge bands

- Hit test: the hovered pane's rectangle splits into four halves
  (left/right/top/bottom). The pointer's half during dragover is the
  target region. No dead center: a half always resolves.
- Preview: `.panel-drop-preview`, a dotted-border translucent square
  absolutely positioned over the target half of the hovered pane. It
  moves with dragover and clears on dragleave/drop/dragend.
- Drop semantics (chip drag): the target pane SPLITS at the hovered
  half and the dragged leaf takes that half. `{kind, sizes:[1,1],
  children:[target, dragged] | [dragged, target]}` nests into the
  target leaf's slot (same extend/nest mechanics as Split, anchored on
  the target, not the route). A single-panel tree stays a no-op
  (nothing to split beside; the drag needs a second panel to mean
  anything).
- Drop semantics (tab drag): the target pane splits the same way and a
  NEW empty leaf takes the hovered half, then the dragged tab id moves
  into that fresh leaf (same placement the strip drop uses today, plus
  the split). Dropping on the tab's own pane is a no-op.
- Groups: a drop INSIDE the hovered group's area reorders within the
  group (existing strip mechanics); a drop OUTSIDE the group's subtree
  (different top-level slot) re-parents the member leaf to the root
  level beside the group, which ungroups it.

## Group labels

- A group is any top-level split subtree with 2+ leaves. Each strip
  renders ONE group chip for its group: `<icon> <count>` (icon from
  the existing icon set, count = leaf members). Standalone leaves keep
  the v2 chip (workspace name).
- Group chip click: focuses the group's active leaf (the
  `activePaneId` the group's subtree last focused).
- Group chip drag: moves the whole subtree (the v2 root-wrap drop
  applies to the subtree node).
- Ungroup: a member chip drag dropped outside the group's subtree
  re-parents that member to the root level (sizes rebalanced 1:1 with
  the remaining group). The group keeps its label if 2+ members
  remain, else it dissolves into standalone chips.

## Open questions (implementation order)

1. Half-region hit test lives in `panelDropEdgeAt`'s successor; keep
   the same dragover/drop wiring on `#workspacePanes`.
2. Preview element: one singleton overlay node repositioned per
   dragover (never per-pane nodes; the render loop must not own it).
3. Tab drag placement reuses `requestTabPlacement`/the strip drop
   path; the split wraps the target first, placement lands the id.
4. Group membership is derived (top-level subtrees), never stored:
   trees already express it, and a stored flag would drift on every
   reshape.
