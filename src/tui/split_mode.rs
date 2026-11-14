//! Split-mode behavior on TuiApp: tree sync, focus walks, ghost
//! preview movement, commit/cancel for split and move modes. The pure
//! tree ops live in `split`; this file wires them to the snapshot and
//! the app state (design: docs/ux/tui-split-panels-design.md).

use super::split::{self, Side, SplitNode};
use super::{TuiApp, TuiScreen};
use crossterm::event::KeyEvent;

impl TuiApp {
    /// Focus pane id for the split view: the focused tile when set.
    /// With a multi-leaf tree `split_focus` is the only owner: a dead
    /// or unset focus falls back to the first alive leaf, never the
    /// sidebar selection (the tile view must not chase the lists).
    /// Single leaf keeps the pre-split fallback to the sidebar
    /// selection, which also seeds the tree on refresh.
    pub(crate) fn focused_pane_id(&self) -> Option<String> {
        if let Some(focus) = self.split_focus.as_deref() {
            if self.snapshot.panes.iter().any(|pane| pane.id == focus) {
                return Some(focus.to_string());
            }
        }
        if self.split_tree.leaves().len() >= 2 {
            return self
                .split_tree
                .leaves()
                .into_iter()
                .find(|id| self.snapshot.panes.iter().any(|pane| pane.id == *id))
                .map(|id| id.to_string());
        }
        self.selected_pane().map(|pane| pane.id.clone())
    }

    /// Reconcile the tree with the snapshot: panes that vanished get
    /// pruned (leaf removal collapses single-child splits), and a tree
    /// with no pane left resets to a leaf of the current focus so the
    /// Terminal screen always has something to show. Called from the
    /// snapshot refresh path only.
    pub(crate) fn sync_split_tree(&mut self) {
        if self.screen != TuiScreen::Terminal {
            return;
        }
        let alive: Vec<&str> = self
            .snapshot
            .panes
            .iter()
            .map(|pane| pane.id.as_str())
            .collect();
        // Prune every dead leaf; one pass per dead pane (trees stay
        // small, the loop is cheap and keeps the model pure).
        // remove_leaf returns None when the tree holds one leaf total,
        // so a lone dead pane survives here and the reseed below
        // replaces it.
        loop {
            let dead = self
                .split_tree
                .leaves()
                .into_iter()
                .find(|id| !alive.contains(id))
                .map(|id| id.to_string());
            let Some(dead) = dead else { break };
            match split::remove_leaf(&self.split_tree, &dead) {
                Some(next) => self.split_tree = next,
                None => break,
            }
        }
        // Reseed when no alive leaf is left (fresh session, or the
        // only pane vanished): the Terminal screen always shows the
        // focused pane.
        let has_alive = self.split_tree.leaves().iter().any(|id| alive.contains(id));
        if !has_alive {
            let seed = self
                .focused_pane_id()
                .or_else(|| self.snapshot.panes.first().map(|pane| pane.id.clone()))
                .unwrap_or_default();
            self.split_tree = SplitNode::leaf(seed);
        }
        // When the tree gains its second leaf (or reseeds into a
        // multi-leaf), the tile view takes focus ownership: seed
        // split_focus once so walks and zoom always have an origin.
        if self.split_tree.leaves().len() >= 2 && self.split_focus.is_none() {
            let seed = self
                .split_tree
                .leaves()
                .into_iter()
                .find(|id| alive.contains(id))
                .map(|id| id.to_string());
            self.split_focus = seed;
        }
        // Focus must sit on the tree: dead focus falls back to the
        // first leaf so walks always have an origin.
        let leaves = self.split_tree.leaves();
        if let Some(focus) = self.split_focus.as_deref() {
            if !leaves.contains(&focus) {
                self.split_focus = leaves.first().map(|id| id.to_string());
            }
        }
        // Zoomed pane vanished: clear the toggle, the tree shows again.
        if self.split_zoomed {
            let focus = self.focused_pane_id();
            if focus.is_none() {
                self.split_zoomed = false;
            }
        }
        // Open overlays whose target pane vanished close instead of
        // committing into a dead neighbor.
        if let Some(preview) = self.split_mode.clone() {
            if !self.split_tree.contains_pane(&preview.neighbor) {
                self.split_mode = None;
            }
        }
        if let Some(state) = self.move_mode.clone() {
            let picked_ok = self.split_tree.contains_pane(&state.picked);
            let target_ok = self.split_tree.contains_pane(&state.target);
            if !picked_ok || !target_ok {
                self.move_mode = None;
            }
        }
        self.drain_auto_split_queue();
    }

    /// Auto-split on open: insert every queued workspace's first pane
    /// into the tree beside the current focus (Right side, like the
    /// split mode's default ghost) and hand the tile focus to it, so
    /// the just-opened workspace greets the user as its own tile.
    /// The pane exists only after the refresh that queued it landed,
    /// so this runs at the end of sync_split_tree. A queued workspace
    /// stays queued while it exists without a spare pane (pane not yet
    /// created, or every pane already on the tree); one that vanished
    /// from the snapshot drops from the queue.
    pub(crate) fn drain_auto_split_queue(&mut self) {
        if self.split_panes_of_workspaces.is_empty() {
            return;
        }
        let queued = std::mem::take(&mut self.split_panes_of_workspaces);
        let mut keep = Vec::new();
        for workspace_id in queued {
            let workspace_alive = self
                .snapshot
                .workspaces
                .iter()
                .any(|ws| ws.id == workspace_id);
            if !workspace_alive {
                // The open never landed (or the workspace closed at
                // once); stop waiting for its pane.
                continue;
            }
            // First pane of the workspace not already on the tree:
            // an open that lands on an existing pane (backend focused
            // an already-open workspace) must not duplicate a tile.
            let Some(pane) = self
                .snapshot
                .panes
                .iter()
                .find(|pane| {
                    pane.workspace_id == workspace_id && !self.split_tree.contains_pane(&pane.id)
                })
                .map(|pane| pane.id.clone())
            else {
                // Workspace alive but no spare pane yet: wait one more
                // refresh before giving up on the auto-split.
                keep.push(workspace_id);
                continue;
            };
            let Some(neighbor) = self.focused_pane_id() else {
                // No live focus to split beside (empty session): the
                // reseed path plants the pane as the tree next round.
                keep.push(workspace_id);
                continue;
            };
            if neighbor == pane {
                continue;
            }
            self.split_tree = split::insert_beside(&self.split_tree, &neighbor, &pane, Side::Right);
            self.split_focus = Some(pane);
            // Auto-split beats zoom: the new tile must be visible, not
            // hidden behind the previous pane's fullscreen.
            self.split_zoomed = false;
        }
        self.split_panes_of_workspaces = keep;
    }

    /// Move tile focus by (dx, dy) using the laid-out tile rects the
    /// render pass recorded. Zoom pins the focus: no walking while
    /// one tile owns the screen.
    pub(crate) fn split_move_focus(&mut self, dx: i32, dy: i32) {
        if self.split_zoomed {
            return;
        }
        let Some(from) = self.focused_pane_id() else {
            return;
        };
        let owned = self.tile_geometry_snapshot();
        let tiles: Vec<crate::tui::split::TileRect<'_>> = owned
            .iter()
            .map(|tile| {
                crate::tui::split::TileRect::new(
                    tile.pane_id.as_str(),
                    tile.x,
                    tile.y,
                    tile.width,
                    tile.height,
                )
            })
            .collect();
        if let Some(next) = split::walk_next(&tiles, &from, dx, dy, None) {
            self.split_focus = Some(next.to_string());
            self.mark_dirty();
        }
    }

    /// Open split mode over the focused tile (Ctrl+B s).
    pub(crate) fn open_split_mode(&mut self) {
        // Opening a mode while zoomed auto-unzooms first: the ghost
        // needs the full tile grid, and the focused tile stays focused.
        if self.split_zoomed {
            self.split_zoomed = false;
            self.status = "zoom off".to_string();
        }
        // Only one overlay at a time (footer hint already is).
        self.move_mode = None;
        let Some(focus) = self.focused_pane_id() else {
            self.status = "no pane to split".to_string();
            return;
        };
        // First candidate: a pane from another workspace that is not
        // already on the tree (the cross-workspace point of the
        // feature); fall back to the focused pane's own workspace.
        let on_tree: Vec<&str> = self.split_tree.leaves();
        let candidate = self
            .snapshot
            .panes
            .iter()
            .find(|pane| {
                !on_tree.contains(&pane.id.as_str())
                    && self
                        .focused_pane_workspace(&focus)
                        .map(|ws| ws != pane.workspace_id)
                        .unwrap_or(true)
            })
            .map(|pane| pane.id.clone())
            .or_else(|| {
                self.snapshot
                    .panes
                    .iter()
                    .find(|pane| !on_tree.contains(&pane.id.as_str()))
                    .map(|pane| pane.id.clone())
            });
        let Some(candidate) = candidate else {
            self.status = "no other pane available".to_string();
            return;
        };
        self.split_mode = Some(split::SplitPreview {
            neighbor: focus,
            side: Side::Right,
            pane: candidate,
        });
        self.mark_dirty();
    }

    /// Cycle the ghost's candidate pane (p in split mode): panes not
    /// on the tree first (other workspaces ahead), then back to the
    /// first. Skips the neighbor itself; a ghost never proposes
    /// duplicating the pane it overlays.
    pub(crate) fn split_cycle_pane(&mut self) {
        let Some(preview) = self.split_mode.clone() else {
            return;
        };
        let on_tree: Vec<&str> = self.split_tree.leaves();
        let candidates: Vec<String> = self
            .snapshot
            .panes
            .iter()
            .filter(|pane| !on_tree.contains(&pane.id.as_str()) && pane.id != preview.neighbor)
            .map(|pane| pane.id.clone())
            .collect();
        if candidates.is_empty() {
            self.status = "no other pane to open".to_string();
            return;
        }
        let index = candidates
            .iter()
            .position(|id| *id == preview.pane)
            .map(|i| (i + 1) % candidates.len())
            .unwrap_or(0);
        self.split_mode = Some(split::SplitPreview {
            pane: candidates[index].clone(),
            ..preview
        });
        self.mark_dirty();
    }

    /// Flip the ghost's split side via Tab: row sides and col sides
    /// cycle independently so the preview stays in the same axis
    /// family (Right -> Left -> Right, Below -> Above -> Below).
    pub(crate) fn split_flip_side(&mut self) {
        let Some(preview) = self.split_mode.clone() else {
            return;
        };
        let side = match preview.side {
            Side::Right => Side::Below,
            Side::Below => Side::Left,
            Side::Left => Side::Above,
            Side::Above => Side::Right,
        };
        self.split_mode = Some(split::SplitPreview { side, ..preview });
        self.mark_dirty();
    }

    /// Move the ghost between tiles (hjkl in split mode). The ghost
    /// keeps its side family when the geometry allows it: a pure
    /// horizontal move keeps a row side, a vertical move keeps a col
    /// side, so the preview never teleports axes on the user.
    pub(crate) fn split_move_ghost(&mut self, dx: i32, dy: i32) {
        if self.split_zoomed {
            return;
        }
        let Some(preview) = self.split_mode.clone() else {
            return;
        };
        let owned = self.tile_geometry_snapshot();
        let tiles: Vec<split::TileRect<'_>> = owned
            .iter()
            .map(|tile| {
                split::TileRect::new(
                    tile.pane_id.as_str(),
                    tile.x,
                    tile.y,
                    tile.width,
                    tile.height,
                )
            })
            .collect();
        let Some(next) = split::walk_next(&tiles, &preview.neighbor, dx, dy, None) else {
            return;
        };
        let side = match (preview.side, dx != 0) {
            (Side::Right | Side::Left, true) => preview.side,
            (Side::Below | Side::Above, false) => preview.side,
            (_, true) => Side::Right,
            (_, false) => Side::Below,
        };
        self.split_mode = Some(split::SplitPreview {
            neighbor: next.to_string(),
            side,
            ..preview
        });
        self.mark_dirty();
    }

    /// Commit the split (Enter): the candidate pane joins the tree
    /// beside the ghost's neighbor, focus moves to the new tile.
    pub(crate) fn split_commit(&mut self) {
        let Some(preview) = self.split_mode.take() else {
            return;
        };
        if !self.split_tree.contains_pane(&preview.neighbor) {
            self.status = "split target vanished".to_string();
            return;
        }
        if self.split_tree.contains_pane(&preview.pane) {
            self.status = "pane already on screen".to_string();
            return;
        }
        self.split_tree = split::insert_beside(
            &self.split_tree,
            &preview.neighbor,
            &preview.pane,
            preview.side,
        );
        self.split_focus = Some(preview.pane);
        self.status = "tile added".to_string();
        self.mark_dirty();
    }

    /// Open move mode for the focused tile (Ctrl+B m).
    pub(crate) fn open_move_mode(&mut self) {
        if self.split_zoomed {
            self.split_zoomed = false;
            self.status = "zoom off".to_string();
        }
        // Only one overlay at a time (footer hint already is).
        self.split_mode = None;
        let Some(focus) = self.focused_pane_id() else {
            self.status = "no pane to move".to_string();
            return;
        };
        if self.split_tree.leaves().len() < 2 {
            self.status = "nothing to move (single tile)".to_string();
            return;
        }
        self.move_mode = Some(split::MoveState {
            picked: focus.clone(),
            target: focus,
            insert: false,
            side: Side::Right,
        });
        self.mark_dirty();
    }

    /// Walk the move target (hjkl in move mode); the side tracks the
    /// approach direction so the insert preview hugs the target edge.
    pub(crate) fn move_walk_target(&mut self, dx: i32, dy: i32) {
        if self.split_zoomed {
            return;
        }
        let Some(state) = self.move_mode.clone() else {
            return;
        };
        let owned = self.tile_geometry_snapshot();
        let tiles: Vec<split::TileRect<'_>> = owned
            .iter()
            .map(|tile| {
                split::TileRect::new(
                    tile.pane_id.as_str(),
                    tile.x,
                    tile.y,
                    tile.width,
                    tile.height,
                )
            })
            .collect();
        let Some(next) = split::walk_next(&tiles, &state.target, dx, dy, Some(&state.picked))
        else {
            return;
        };
        let side = if dx > 0 {
            Side::Left
        } else if dx < 0 {
            Side::Right
        } else if dy > 0 {
            Side::Above
        } else {
            Side::Below
        };
        self.move_mode = Some(split::MoveState {
            target: next.to_string(),
            side,
            ..state
        });
        self.mark_dirty();
    }

    /// Toggle the move verb (Tab): swap <-> insert-beside.
    pub(crate) fn move_toggle_insert(&mut self) {
        let Some(state) = self.move_mode.clone() else {
            return;
        };
        self.move_mode = Some(split::MoveState {
            insert: !state.insert,
            ..state
        });
        self.mark_dirty();
    }

    /// Commit the move (Enter): swap keeps the tree shape, insert
    /// pulls the picked pane then re-inserts it beside the target.
    pub(crate) fn move_commit(&mut self) {
        let Some(state) = self.move_mode.take() else {
            return;
        };
        if state.picked == state.target {
            return;
        }
        if !self.split_tree.contains_pane(&state.picked)
            || !self.split_tree.contains_pane(&state.target)
        {
            self.status = "move target vanished".to_string();
            return;
        }
        if state.insert {
            let pulled = split::remove_leaf(&self.split_tree, &state.picked);
            let Some(mut tree) = pulled else {
                self.status = "move picked the last tile".to_string();
                return;
            };
            if !tree.contains_pane(&state.target) {
                self.status = "move target vanished".to_string();
                return;
            }
            tree = split::insert_beside(&tree, &state.target, &state.picked, state.side);
            self.split_tree = tree;
        } else {
            self.split_tree = split::swap_leaves(&self.split_tree, &state.picked, &state.target);
        }
        let picked = state.picked.clone();
        self.split_focus = Some(state.picked);
        self.status = if state.insert {
            // Say where focus landed: insert commits land on the picked
            // pane, and the user needs to know that.
            format!("moved {picked} · focus {picked}")
        } else {
            "tiles swapped".to_string()
        };
        self.mark_dirty();
    }

    /// Toggle zoom on the focused tile (Ctrl+B z).
    pub(crate) fn split_toggle_zoom(&mut self) {
        if self.split_focus.is_none() && self.snapshot.panes.is_empty() {
            return;
        }
        self.split_zoomed = !self.split_zoomed;
        self.status = if self.split_zoomed {
            "zoomed (Ctrl+B z restores)".to_string()
        } else {
            "zoom off".to_string()
        };
        self.mark_dirty();
    }

    fn focused_pane_workspace(&self, pane_id: &str) -> Option<&str> {
        self.snapshot
            .panes
            .iter()
            .find(|pane| pane.id == pane_id)
            .map(|pane| pane.workspace_id.as_str())
    }
}

/// Key routing while split mode owns the keyboard (design: hjkl/arrows
/// move the ghost, Tab flips side family, p cycles the candidate,
/// Enter commits, Esc cancels). Lives on TuiApp for `handle_key`
/// access; the pure movement logic stays above.
impl TuiApp {
    pub(crate) fn handle_split_mode_key(&mut self, key: KeyEvent) {
        use crossterm::event::KeyCode;
        let dx = match key.code {
            KeyCode::Left | KeyCode::Char('h') => -1,
            KeyCode::Right | KeyCode::Char('l') => 1,
            _ => 0,
        };
        let dy = match key.code {
            KeyCode::Up | KeyCode::Char('k') => -1,
            KeyCode::Down | KeyCode::Char('j') => 1,
            _ => 0,
        };
        match key.code {
            KeyCode::Esc => {
                self.split_mode = None;
                self.just_closed_mode = true;
                self.status = "split cancelled".to_string();
            }
            KeyCode::Enter => self.split_commit(),
            KeyCode::Tab => self.split_flip_side(),
            KeyCode::Char('p') => self.split_cycle_pane(),
            _ if dx != 0 || dy != 0 => self.split_move_ghost(dx, dy),
            _ => {}
        }
        self.mark_dirty();
    }

    pub(crate) fn handle_move_mode_key(&mut self, key: KeyEvent) {
        use crossterm::event::KeyCode;
        let dx = match key.code {
            KeyCode::Left | KeyCode::Char('h') => -1,
            KeyCode::Right | KeyCode::Char('l') => 1,
            _ => 0,
        };
        let dy = match key.code {
            KeyCode::Up | KeyCode::Char('k') => -1,
            KeyCode::Down | KeyCode::Char('j') => 1,
            _ => 0,
        };
        match key.code {
            KeyCode::Esc => {
                self.move_mode = None;
                self.just_closed_mode = true;
                self.status = "move cancelled".to_string();
            }
            KeyCode::Enter => self.move_commit(),
            KeyCode::Tab => self.move_toggle_insert(),
            _ if dx != 0 || dy != 0 => self.move_walk_target(dx, dy),
            _ => {}
        }
        self.mark_dirty();
    }
}
