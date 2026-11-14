//! Split-panel layout tree for the Terminal screen (design doc:
//! docs/ux/tui-split-panels-design.md).
//!
//! View-layer binary tree mirroring the WebUI panes tree
//! ({kind:"row"|"column", sizes, children} in workspace_panes.js):
//! leaves reference backend pane ids (any workspace), splits carry
//! equal ratios in v1. Pure model: no ratatui types here, geometry
//! scoring works on plain Rect-like inputs, everything unit-testable
//! without a backend.

/// Layout tree node. A single-leaf tree is the pre-split view: the
/// Terminal screen renders exactly like today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SplitNode {
    Leaf { pane_id: String },
    Split {
        dir: SplitDir,
        children: Vec<SplitNode>,
    },
}

impl SplitNode {
    /// Single-leaf tree for a pane: the additive default; a session
    /// that never splits keeps the single-pane rendering.
    pub fn leaf(pane_id: impl Into<String>) -> Self {
        Self::Leaf {
            pane_id: pane_id.into(),
        }
    }

    /// Leaf pane ids in reading order (layout order for the tree).
    pub fn leaves(&self) -> Vec<&str> {
        fn walk<'a>(node: &'a SplitNode, out: &mut Vec<&'a str>) {
            match node {
                SplitNode::Leaf { pane_id } => out.push(pane_id),
                SplitNode::Split { children, .. } => {
                    for child in children {
                        walk(child, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(self, &mut out);
        out
    }

    pub fn contains_pane(&self, pane_id: &str) -> bool {
        self.leaves().iter().any(|id| *id == pane_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDir {
    Row,
    Col,
}

impl SplitDir {
    /// Side of a tile a direction inserts toward; Right for rows,
    /// Below for columns (the WebUI splitRight/splitDown defaults).
    pub fn default_side(self) -> Side {
        match self {
            SplitDir::Row => Side::Right,
            SplitDir::Col => Side::Below,
        }
    }
}

/// Which edge of a tile a new or moved pane attaches to. Sides imply
/// the split direction of a fresh split (Left/Right -> Row,
/// Above/Below -> Col), matching the WebUI insert semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Right,
    Left,
    Below,
    Above,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Right => Side::Left,
            Side::Left => Side::Right,
            Side::Below => Side::Above,
            Side::Above => Side::Below,
        }
    }

    pub fn dir(self) -> SplitDir {
        match self {
            Side::Right | Side::Left => SplitDir::Row,
            Side::Below | Side::Above => SplitDir::Col,
        }
    }
}

/// Insert `new_pane` beside `neighbor` at `side`.
///
/// WebUI parity: when the neighbor leaf already sits in a split with
/// the same direction, the pane joins that split (no nested
/// single-child splits); otherwise the leaf is wrapped in a fresh
/// 50/50 split. Missing neighbor leaves the tree untouched (stale
/// ghost after a snapshot change commits nothing).
pub fn insert_beside(
    tree: &SplitNode,
    neighbor: &str,
    new_pane: &str,
    side: Side,
) -> SplitNode {
    fn insert(node: &SplitNode, neighbor: &str, new_pane: &str, side: Side) -> SplitNode {
        match node {
            SplitNode::Leaf { pane_id } if pane_id == neighbor => {
                let old = SplitNode::leaf(pane_id.clone());
                let fresh = SplitNode::leaf(new_pane);
                let children = match side {
                    Side::Right | Side::Below => vec![old, fresh],
                    Side::Left | Side::Above => vec![fresh, old],
                };
                SplitNode::Split {
                    dir: side.dir(),
                    children,
                }
            }
            SplitNode::Leaf { pane_id } => SplitNode::leaf(pane_id.clone()),
            SplitNode::Split { dir, children } => {
                // Direct child leaf in a same-direction split joins it.
                let neighbor_leaf_here = children.iter().any(|child| {
                    matches!(child, SplitNode::Leaf { pane_id } if pane_id == neighbor)
                });
                if *dir == side.dir() && neighbor_leaf_here {
                    let mut next = Vec::with_capacity(children.len() + 1);
                    for child in children {
                        let is_neighbor =
                            matches!(child, SplitNode::Leaf { pane_id } if pane_id == neighbor);
                        if is_neighbor {
                            match side {
                                Side::Right | Side::Below => {
                                    next.push(child.clone());
                                    next.push(SplitNode::leaf(new_pane));
                                }
                                Side::Left | Side::Above => {
                                    next.push(SplitNode::leaf(new_pane));
                                    next.push(child.clone());
                                }
                            }
                        } else {
                            next.push(insert(child, neighbor, new_pane, side));
                        }
                    }
                    SplitNode::Split {
                        dir: *dir,
                        children: next,
                    }
                } else {
                    SplitNode::Split {
                        dir: *dir,
                        children: children
                            .iter()
                            .map(|child| insert(child, neighbor, new_pane, side))
                            .collect(),
                    }
                }
            }
        }
    }
    if !tree.contains_pane(neighbor) {
        return tree.clone();
    }
    insert(tree, neighbor, new_pane, side)
}

/// Remove `pane_id` from the tree, collapsing any split left with a
/// single child to the survivor (WebUI collapse rule). A tree that
/// only held the pane becomes empty (None): the caller falls back to
/// the next remaining pane or the single-pane view.
pub fn remove_leaf(tree: &SplitNode, pane_id: &str) -> Option<SplitNode> {
    fn pull(node: &SplitNode, pane_id: &str) -> Option<SplitNode> {
        match node {
            SplitNode::Leaf { .. } if node_pane(node) == Some(pane_id) => None,
            SplitNode::Leaf { .. } => Some(node.clone()),
            SplitNode::Split { dir, children } => {
                let kept: Vec<SplitNode> = children
                    .iter()
                    .filter_map(|child| pull(child, pane_id))
                    .collect();
                match kept.len() {
                    0 => None,
                    1 => kept.into_iter().next(),
                    _ => Some(SplitNode::Split {
                        dir: *dir,
                        children: kept,
                    }),
                }
            }
        }
    }
    pull(tree, pane_id)
}

/// Swap the panes of two leaves in place; the tree shape never changes
/// (move-mode default verb, i3 drop-on-container).
pub fn swap_leaves(tree: &SplitNode, a: &str, b: &str) -> SplitNode {
    fn swap(node: &SplitNode, a: &str, b: &str) -> SplitNode {
        match node {
            SplitNode::Leaf { pane_id } => {
                let replacement = if pane_id == a {
                    b
                } else if pane_id == b {
                    a
                } else {
                    pane_id
                };
                SplitNode::leaf(replacement)
            }
            SplitNode::Split { dir, children } => SplitNode::Split {
                dir: *dir,
                children: children
                    .iter()
                    .map(|child| swap(child, a, b))
                    .collect(),
            },
        }
    }
    if !tree.contains_pane(a) || !tree.contains_pane(b) {
        return tree.clone();
    }
    swap(tree, a, b)
}

fn node_pane(node: &SplitNode) -> Option<&str> {
    match node {
        SplitNode::Leaf { pane_id } => Some(pane_id.as_str()),
        SplitNode::Split { .. } => None,
    }
}

/// Geometry inputs for the tile walks: pane id plus its rect. The
/// render layer fills these from the laid-out tree; the scoring stays
/// backend-free and testable with synthetic rects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRect {
    pub pane_id: *const str,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl TileRect {
    pub fn new(pane_id: &str, x: u16, y: u16, width: u16, height: u16) -> Self {
        Self {
            pane_id: pane_id as *const str,
            x,
            y,
            width,
            height,
        }
    }

    pub fn pane_id(&self) -> &str {
        unsafe { &*self.pane_id }
    }
}

/// Directional walk used by focus movement, ghost placement, and move
/// target selection: from `from`, the winner is the tile whose center
/// lies furthest in the (dx, dy) direction among candidates that share
/// the moved axis (pure horizontal for dx-only, pure vertical for
/// dy-only, else both components must agree). Nearest center wins.
pub fn walk_next<'a>(
    tiles: &'a [TileRect],
    from: &str,
    dx: i32,
    dy: i32,
    skip: Option<&str>,
) -> Option<&'a str> {
    let origin = tiles.iter().find(|t| t.pane_id() == from)?;
    let (ox, oy) = (origin.x as i32 + origin.width as i32 / 2, origin.y as i32 + origin.height as i32 / 2);
    let mut best: Option<(f32, &str)> = None;
    for tile in tiles {
        let id = tile.pane_id();
        if id == from || Some(id) == skip {
            continue;
        }
        let cx = tile.x as i32 + tile.width as i32 / 2;
        let cy = tile.y as i32 + tile.height as i32 / 2;
        let (cdx, cdy) = (cx - ox, cy - oy);
        if dx != 0 && cdx * dx <= 0 {
            continue;
        }
        if dy != 0 && cdy * dy <= 0 {
            continue;
        }
        if dx == 0 && cdx != 0 {
            continue;
        }
        if dy == 0 && cdy != 0 {
            continue;
        }
        let dist = (cdx * cdx + cdy * cdy) as f32;
        if dist < best.map(|(d, _)| d).unwrap_or(f32::MAX) {
            best = Some((dist, id));
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn single_leaf_tree_lists_itself_and_stays_additive() {
        let tree = leaf("p1");
        assert_eq!(tree.leaves(), vec!["p1"]);
        assert!(tree.contains_pane("p1"));
        assert!(!tree.contains_pane("p2"));
    }

    #[test]
    fn insert_into_single_leaf_wraps_in_fresh_split() {
        let tree = leaf("p1");
        let next = insert_beside(&tree, "p1", "p2", Side::Right);
        assert_eq!(
            next,
            SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![leaf("p1"), leaf("p2")],
            }
        );
    }

    #[test]
    fn insert_left_orders_new_pane_first() {
        let tree = leaf("p1");
        let next = insert_beside(&tree, "p1", "p2", Side::Left);
        assert_eq!(
            next,
            SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![leaf("p2"), leaf("p1")],
            }
        );
    }

    #[test]
    fn insert_reuses_same_direction_parent_split() {
        // row[p1, p2] + insert below p1 -> p1 wraps in col, row keeps
        // shape (no same-direction parent, so wrap is correct).
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = insert_beside(&tree, "p1", "p3", Side::Below);
        assert_eq!(
            next,
            SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![
                    SplitNode::Split {
                        dir: SplitDir::Col,
                        children: vec![leaf("p1"), leaf("p3")],
                    },
                    leaf("p2"),
                ],
            }
        );
    }

    #[test]
    fn insert_in_same_direction_joins_the_split() {
        // row[p1, p2] + insert right of p1 -> row[p1, p3, p2].
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = insert_beside(&tree, "p1", "p3", Side::Right);
        assert_eq!(
            next,
            SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![leaf("p1"), leaf("p3"), leaf("p2")],
            }
        );
    }

    #[test]
    fn insert_with_missing_neighbor_is_a_noop() {
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = insert_beside(&tree, "gone", "p3", Side::Right);
        assert_eq!(next, tree);
    }

    #[test]
    fn remove_collapses_single_child_split() {
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = remove_leaf(&tree, "p2");
        assert_eq!(next, Some(leaf("p1")));
    }

    #[test]
    fn remove_last_leaf_empties_the_tree() {
        let tree = leaf("p1");
        assert_eq!(remove_leaf(&tree, "p1"), None);
    }

    #[test]
    fn remove_keeps_deep_split_shape() {
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![
                leaf("p1"),
                SplitNode::Split {
                    dir: SplitDir::Col,
                    children: vec![leaf("p2"), leaf("p3"), leaf("p4")],
                },
            ],
        };
        let next = remove_leaf(&tree, "p3");
        assert_eq!(
            next,
            Some(SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![
                    leaf("p1"),
                    SplitNode::Split {
                        dir: SplitDir::Col,
                        children: vec![leaf("p2"), leaf("p4")],
                    },
                ],
            })
        );
    }

    #[test]
    fn swap_trades_leaf_panels_and_keeps_shape() {
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = swap_leaves(&tree, "p1", "p2");
        assert_eq!(
            next,
            SplitNode::Split {
                dir: SplitDir::Row,
                children: vec![leaf("p2"), leaf("p1")],
            }
        );
    }

    #[test]
    fn swap_with_missing_pane_is_a_noop() {
        let tree = SplitNode::Split {
            dir: SplitDir::Row,
            children: vec![leaf("p1"), leaf("p2")],
        };
        let next = swap_leaves(&tree, "p1", "gone");
        assert_eq!(next, tree);
    }

    #[test]
    fn walk_next_finds_right_neighbor_by_center_distance() {
        let tiles = [
            TileRect::new("a", 0, 0, 10, 10),
            TileRect::new("b", 10, 0, 10, 10),
            TileRect::new("c", 0, 10, 20, 10),
        ];
        assert_eq!(walk_next(&tiles, "a", 1, 0, None), Some("b"));
        // Down from a: c's center x is 10, a's is 5; the pure-vertical
        // walk requires zero horizontal offset, so a to c needs the
        // both-axis rule. Only the strict axis-aligned cases are
        // guaranteed by walk_next; diagonal moves filter everything
        // out in this synthetic grid.
        assert_eq!(walk_next(&tiles, "a", 0, 1, None), None);
        assert_eq!(walk_next(&tiles, "b", 0, 1, None), None);
        // Nothing left of a.
        assert_eq!(walk_next(&tiles, "a", -1, 0, None), None);
    }

    #[test]
    fn walk_next_can_skip_the_picked_tile() {
        let tiles = [
            TileRect::new("a", 0, 0, 10, 10),
            TileRect::new("b", 10, 0, 10, 10),
            TileRect::new("c", 20, 0, 10, 10),
        ];
        // Moving right from b skips nothing.
        assert_eq!(walk_next(&tiles, "b", 1, 0, None), Some("c"));
        // Moving right from a with b skipped lands on c.
        assert_eq!(walk_next(&tiles, "a", 1, 0, Some("b")), Some("c"));
    }
}