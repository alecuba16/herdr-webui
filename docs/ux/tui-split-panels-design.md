# TUI split-panel layout design

Status: design approved (ghost preview + Enter, per-tile identity, AGENTS
summary bar). Prototype: `~/.jcode/scratch/tui_split_prototype` (standalone
ratatui mock, not part of the repo). Implementation lands behind the
Terminal screen only; Files and Git screens keep the single-pane view.

## Problem

The Terminal screen shows one pane at a time. The backend already owns N
panes across N workspaces; the TUI renders only the selected one, so
watching a build in one workspace while an agent runs in another means
flapping through the sidebar. The WebUI solved this with its binary split
tree (`workspace_panes.js`); the TUI needs the same capability with a
keyboard-native interaction.

## Research anchors

- tmux `display-panes` (`prefix q`): transient number overlay on live
  panes, digit commits. Confirms overlay-on-live-content works.
- Zellij modes (`Ctrl p` pane mode): transient mode, persistent hint bar
  listing every mode key. Model for our footer hint swap.
- i3 drag drop indicators: indicator previews the resulting tree before
  release (center = swap, edge = sibling insert). Model for our ghost
  preview and swap-vs-insert distinction.
- Own WebUI `splitActivePane` (workspace_panes.js): binary tree
  `{kind: row|column, sizes, children}` + `{kind: pane}` leaves; split
  wraps the active leaf in a two-child split; splits with one child
  collapse to the survivor. The TUI tree mirrors this shape exactly.

## Layout model

```rust
enum SplitNode {
    Leaf { pane_id: String },
    Split { dir: SplitDir, sizes: Vec<f32>, children: Vec<SplitNode> },
}
enum SplitDir { Row, Col }
```

- Stored per workspace tab? No: one tree per TUI session, view-layer
  only. Leaves reference any pane id from any workspace in the snapshot;
  the backend keeps owning panes and ptys.
- Single leaf = today's single-pane view, byte-identical rendering. The
  tree is additive: no split ever made means nothing changes.
- Insert rule (WebUI parity): inserting beside a leaf reuses a
  same-direction parent split (no nested single-child splits), otherwise
  wraps the leaf in a new 50/50 split.
- Pull rule: removing a leaf collapses a single-child split to the
  survivor.
- Resize (Ctrl+B Shift+Z): h/l narrow/widen the focused tile, j/k
  shorten/lengthen it. Weights live on the tree like the webui's
  flex sizes, clamped at a readable floor (a side never shrinks
  below a quarter share of its axis).

## Interaction (approved)

`Ctrl+B` prefix, then:

| Key | Action |
| --- | --- |
| `s` | Enter Split mode: ghost preview over the focused tile |
| `m` | Enter Move mode: relocate the focused tile |
| `z` | Toggle zoom (fullscreen) on the focused tile |
| `hjkl` / arrows | Walk focus between visible tiles (no overlay) |
| `1`-`9` | Jump focus to tile N (display-panes parity, v2 candidate) |

### Split mode

- Ghost tile shows the exact 50% half the new pane would take: accent
  rounded border, tinted background, title names the pane to open.
- `hjkl`/arrows move the ghost between leaf tiles (edge-geometry
  scoring: nearest overlapping edge wins, i3-like).
- `Tab` flips the split direction (row/col) for the fresh split.
- `p` cycles which pane opens: candidates are panes from other
  workspaces (cross-workspace is the point of the feature), then a
  fresh shell.
- `Enter` commits: tree insert per the insert rule, focus moves to the
  new tile. `Esc` cancels with zero mutation.
- Footer swaps to the mode hint bar (`SPLIT · hjkl move · Tab flip · p
  pane · Enter confirm · Esc cancel`), Zellij-style.

### Move mode

- Picked tile: DOUBLE border + `⇄ moving` title (never confused with
  the THICK accent focus ring).
- `hjkl`/arrows walk the target. Default verb is swap (target gets an
  accent DOUBLE ring; both tiles keep their geometry).
- `Tab` toggles swap / insert-beside. Insert preview draws the accent
  ghost half on the target's `side` (i3 drop-as-sibling).
- `Enter` commits: swap swaps leaf ids in place (tree shape never
  changes); insert pulls the picked leaf then re-inserts it beside the
  target. Focus on commit lands on the picked pane (insert: its new
  location; swap: the picked pane). `Esc` cancels.

### Zoom

Focused tile renders full pane area; all other tiles keep their ptys
alive but are not drawn. Toggle restores the tree. Footer notes
`zoomed`. Same geometry as the WebUI maximized-leaf toggle.

## Tile identity and status

Every tile border carries, left to right:

- status dot: glyph + color (running `●` green, waiting `◐` yellow,
  idle `○` muted, error `✕` red). Glyph shape differs too, so status
  never rides on color alone.
- agent/pane label (bold on the focused tile)
- workspace name
- folder (cwd basename) on the focused tile
- worktree/branch chips follow the tab-bar token pattern
  (`[worktree]`, `@ branch`) when present, muted.

One AGENTS summary bar sits between the tab bar and the pane area:

`AGENTS ● shell (api-server) ● jcode (api-server) ○ logs (webui) · ●2 running ○1 idle`

- Per-tile listing up to 5 tiles, aggregate counts beyond that.
- Focused tile's label renders accent in the bar.
- Counts aggregate by status, colored per the dot colors.

## Attach and pty sizing

- Enter attaches the focused tile exactly as today (`LiveTerminal`);
  the pty resizes to the focused tile's viewport, not the window.
- Non-focused tiles show their pane tails via the existing tail refresh
  (`TAIL_REFRESH_INTERVAL` poll loop), one tail fetch per visible pane.
- Attach stays single-pty (the attached terminal owns the keyboard);
  zoom exists for when one tile deserves the whole area.

## Implementation slices

1. `src/tui/split.rs`: tree model, insert/pull/swap rules, geometry
   scoring (ghost + focus + target walks). Pure, unit-testable. DONE.
2. `TuiApp` state: `split_tree`, `split_focus`, `split_zoomed`,
   `split_mode: Option<SplitPreview>`, `move_mode: Option<MoveState>`,
   per-tile tail cache. New `TuiMode::Split` and `TuiMode::MoveTiles`?
   No: the split/move overlays key off state fields, `TuiMode::Attach`
   interplay stays as is (Ctrl+B prefix wins in attach mode already).
   DONE (split_mode.rs).
3. `render`: `render_main` Terminal branch lays out the tree; new
   `render_status_bar`; ghost/picked/target indicators per the mock.
   DONE (render/split_tiles.rs).
4. Keys: `Shortcut::SplitPane`, `Shortcut::MovePane`, `Shortcut::ZoomPane`
   in `keys.rs`; mode-scoped key handlers; hjkl/arrows route to the
   active walk when a mode is open. DONE.
   Key collision resolution (user-approved): prefix s/m/z are
   Terminal-screen scoped (split/move/zoom there), while the Git and
   Files screens keep settings (s), blame (m), stash-file (z). Settings
   is reachable from any non-Terminal screen.
5. Footer hints per mode; help overlay rows; docs/tui-shortcuts.md
   rows. DONE.
6. Tests: tree ops, ghost scoring, key routing per mode, render smoke
   via the existing `text_snapshot` harness. DONE (13 split unit tests
   + 7 integration tests in tui/tests).

## Non-goals (v1)

- Mouse interaction (WebUI has drag; TUI is keyboard-only).
- Split ratio resize (`+`/`-` per tile is the natural v2).
- Persisted layouts (backend stores no tree; a session-local layout is
  acceptable until the API grows one).
- Number-jump focus (`prefix q` overlay) is a v2 candidate; hjkl walks
  cover v1.
