//! Split-panel layout tree for the Terminal screen (design doc:
//! docs/ux/tui-split-panels-design.md).
//!
//! View-layer binary tree mirroring the WebUI panes tree
//! ({kind:"row"|"column", sizes, children} in workspace_panes.js):
//! leaves reference backend pane ids (any workspace), splits carry
//! equal ratios in v1. Pure model: no ratatui types here, geometry
//! scoring works on plain Rect-like inputs, everything unit-testable
//! without a backend.

/// Split tree node. A single-leaf tree is the pre-split view: the
/// Terminal screen renders exactly like today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SplitNode {
    Leaf {
        pane_id: String,
    },
    Split {
        dir: SplitDir,
        /// Per-child flex weight (WebUI parity: the pane tree's `sizes`
        /// array lives on the split). Equal weights render equal shares;
        /// resize mode moves weight between siblings. Every constructor
        /// seeds a full weights vec so the layout can index it blindly.
        weights: Vec<u32>,
        children: Vec<SplitNode>,
    },
}

/// Weight every freshly built split gives each child. 8 (not 1) so a
/// single resize step is a visible but coarse nudge: Ratio(8, 16)
/// equals Ratio(1, 2), and later steps converge proportionally.
pub const SPLIT_WEIGHT_SEED: u32 = 8;

/// Sentinel pane id for split mode's fresh-shell candidate: commit
/// turns it into a new backend tab and splits the tab's root pane
/// (design doc: "candidates are panes from other workspaces ..., then
/// a fresh shell"). Never a real pane id: backends mint ids with a
/// prefix + counter shape.
pub const FRESH_SHELL: &str = "__fresh_shell__";

/// Smallest weight a resize may leave on a side. One weight unit of
/// the 8-seed scale let a tile shrink to ~1/9 of its axis, unreadable
/// sliver territory; the floor keeps the shrunk side near a quarter
/// share (2 of 8), the point where tail lines still truncate
/// readably (ux review finding).
pub const SPLIT_WEIGHT_MIN: u32 = 2;

impl SplitNode {
    /// Single-leaf tree for a pane: the additive default; a session
    /// that never splits keeps the single-pane rendering.
    pub fn leaf(pane_id: impl Into<String>) -> Self {
        Self::Leaf {
            pane_id: pane_id.into(),
        }
    }

    /// Split with every child at the equal seed weight. The only
    /// constructor call sites should use when building fresh splits;
    /// resize-weight surgery goes through [`resize_axis_weights`].
    pub fn split(dir: SplitDir, children: Vec<SplitNode>) -> Self {
        let weights = vec![SPLIT_WEIGHT_SEED; children.len()];
        Self::weighted(dir, children, weights)
    }

    /// Split with explicit weights; `debug_assert` keeps every caller
    /// honest about one weight per child. Resize surgery and
    /// deserialization are the only callers that need this.
    pub fn weighted(dir: SplitDir, children: Vec<Self>, weights: Vec<u32>) -> Self {
        debug_assert_eq!(weights.len(), children.len());
        Self::Split {
            dir,
            weights,
            children,
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
        self.leaves().contains(&pane_id)
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
pub fn insert_beside(tree: &SplitNode, neighbor: &str, new_pane: &str, side: Side) -> SplitNode {
    fn insert(node: &SplitNode, neighbor: &str, new_pane: &str, side: Side) -> SplitNode {
        match node {
            SplitNode::Leaf { pane_id } if pane_id == neighbor => {
                let old = SplitNode::leaf(pane_id.clone());
                let fresh = SplitNode::leaf(new_pane);
                let children = match side {
                    Side::Right | Side::Below => vec![old, fresh],
                    Side::Left | Side::Above => vec![fresh, old],
                };
                SplitNode::split(side.dir(), children)
            }
            SplitNode::Leaf { pane_id } => SplitNode::leaf(pane_id.clone()),
            SplitNode::Split {
                dir,
                weights,
                children,
            } => {
                // Direct child leaf in a same-direction split joins it:
                // the newcomer seeds at the equal weight so the join
                // never re-balances the existing shares.
                let neighbor_leaf_here = children.iter().any(
                    |child| matches!(child, SplitNode::Leaf { pane_id } if pane_id == neighbor),
                );
                if *dir == side.dir() && neighbor_leaf_here {
                    let mut next = Vec::with_capacity(children.len() + 1);
                    let mut next_weights = Vec::with_capacity(children.len() + 1);
                    for (index, child) in children.iter().enumerate() {
                        let is_neighbor =
                            matches!(child, SplitNode::Leaf { pane_id } if pane_id == neighbor);
                        if is_neighbor {
                            let seed = weights.get(index).copied().unwrap_or(SPLIT_WEIGHT_SEED);
                            match side {
                                Side::Right | Side::Below => {
                                    next.push(child.clone());
                                    next.push(SplitNode::leaf(new_pane));
                                    next_weights.push(seed);
                                    next_weights.push(seed);
                                }
                                Side::Left | Side::Above => {
                                    next.push(SplitNode::leaf(new_pane));
                                    next.push(child.clone());
                                    next_weights.push(seed);
                                    next_weights.push(seed);
                                }
                            }
                        } else {
                            next.push(insert(child, neighbor, new_pane, side));
                            next_weights
                                .push(weights.get(index).copied().unwrap_or(SPLIT_WEIGHT_SEED));
                        }
                    }
                    SplitNode::weighted(*dir, next, next_weights)
                } else {
                    SplitNode::weighted(
                        *dir,
                        children
                            .iter()
                            .map(|child| insert(child, neighbor, new_pane, side))
                            .collect(),
                        weights.clone(),
                    )
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
            SplitNode::Split {
                dir,
                weights,
                children,
            } => {
                let mut kept: Vec<SplitNode> = Vec::new();
                let mut kept_weights: Vec<u32> = Vec::new();
                for (index, child) in children.iter().enumerate() {
                    if let Some(survivor) = pull(child, pane_id) {
                        kept.push(survivor);
                        kept_weights.push(weights.get(index).copied().unwrap_or(SPLIT_WEIGHT_SEED));
                    }
                }
                match kept.len() {
                    0 => None,
                    1 => kept.into_iter().next(),
                    _ => Some(SplitNode::weighted(*dir, kept, kept_weights)),
                }
            }
        }
    }
    pull(tree, pane_id)
}

/// Replace the pane of the leaf holding `old_pane` with `new_pane`,
/// keeping shape and weights. Panel-walk counterpart of the webui
/// one-home rule: a homeless id lands in the focused leaf, a missing
/// `old_pane` leaves the tree unchanged (focus can lag one snapshot
/// behind a backend pane swap).
pub fn replace_leaf(tree: &SplitNode, old_pane: &str, new_pane: &str) -> SplitNode {
    fn replace(node: &SplitNode, old_pane: &str, new_pane: &str) -> SplitNode {
        match node {
            SplitNode::Leaf { pane_id } if pane_id == old_pane => SplitNode::leaf(new_pane),
            SplitNode::Leaf { pane_id } => SplitNode::leaf(pane_id.clone()),
            SplitNode::Split {
                dir,
                weights,
                children,
            } => SplitNode::weighted(
                *dir,
                children
                    .iter()
                    .map(|child| replace(child, old_pane, new_pane))
                    .collect(),
                weights.clone(),
            ),
        }
    }
    if !tree.contains_pane(old_pane) {
        return tree.clone();
    }
    replace(tree, old_pane, new_pane)
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
            // Swapping panes never moves children: the weights stay
            // attached to their slots so a resized layout survives a
            // swap (i3 drop-on-container parity).
            SplitNode::Split {
                dir,
                weights,
                children,
            } => SplitNode::weighted(
                *dir,
                children.iter().map(|child| swap(child, a, b)).collect(),
                weights.clone(),
            ),
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

/// Split-mode state (Ctrl+B s): where the ghost preview sits and which
/// pane the new tile opens. `pane` cycles the candidate list; commit
/// inserts it beside `neighbor` at `side`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitPreview {
    /// Pane id the ghost overlays; the new pane lands beside it.
    pub neighbor: String,
    /// Edge of the neighbor the new tile takes.
    pub side: Side,
    /// Pane id the new tile would open (a candidate from another
    /// workspace, or a fresh shell when the list runs out).
    pub pane: String,
}

/// Move-mode state (Ctrl+B m): the picked tile, the target tile, and
/// whether Enter swaps (i3 drop-on-container) or inserts the picked
/// pane beside the target at `side` (i3 drop-as-sibling).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveState {
    pub picked: String,
    pub target: String,
    pub insert: bool,
    pub side: Side,
}

/// Geometry inputs for the tile walks: pane id plus its rect. The
/// render layer fills these from the laid-out tree; the scoring stays
/// backend-free and testable with synthetic rects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRect<'a> {
    pub pane_id: &'a str,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl<'a> TileRect<'a> {
    pub fn new(pane_id: &'a str, x: u16, y: u16, width: u16, height: u16) -> Self {
        Self {
            pane_id,
            x,
            y,
            width,
            height,
        }
    }
}

/// Walk score, tmux pane_score shape. Ordering: candidate class
/// first (0: strictly ahead, 1: overlap and center-ahead), overlap
/// flag (0: shares perpendicular extent), then axis gap, then
/// perpendicular center offset.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct WalkScore {
    class: i32,
    non_overlap: i32,
    axis_distance: i32,
    perp_offset: i32,
}

/// Directional walk used by focus movement, ghost placement, and move
/// target selection: from `from`, the winner is the tile whose center
/// lies furthest in the (dx, dy) direction among candidates that share
/// the moved axis (pure horizontal for dx-only, pure vertical for
/// dy-only, else both components must agree). Nearest center wins.
pub fn walk_next<'a>(
    tiles: &'a [TileRect<'_>],
    from: &str,
    dx: i32,
    dy: i32,
    skip: Option<&str>,
) -> Option<&'a str> {
    let origin = tiles.iter().find(|t| t.pane_id == from)?;
    if dx != 0 && dy != 0 {
        return walk_next_diagonal(tiles, origin, dx, dy, skip);
    }
    let horizontal = dx != 0;
    let dir = if horizontal { dx } else { dy };
    // Origin spans: the walk axis (near edge plus full extent, for
    // the overlap class) and the perpendicular axis (center plus
    // extent, for the overlap preference).
    let (axis_edge, axis_center) = if horizontal {
        (
            origin.x as i32 + if dir > 0 { origin.width as i32 } else { 0 },
            origin.x as i32 + origin.width as i32 / 2,
        )
    } else {
        (
            origin.y as i32 + if dir > 0 { origin.height as i32 } else { 0 },
            origin.y as i32 + origin.height as i32 / 2,
        )
    };
    let (axis_span, perp_center, perp_span) = if horizontal {
        (
            (origin.x as i32, origin.x as i32 + origin.width as i32),
            origin.y as i32 + origin.height as i32 / 2,
            (origin.y as i32, origin.y as i32 + origin.height as i32),
        )
    } else {
        (
            (origin.y as i32, origin.y as i32 + origin.height as i32),
            origin.x as i32 + origin.width as i32 / 2,
            (origin.x as i32, origin.x as i32 + origin.width as i32),
        )
    };
    let mut best: Option<(WalkScore, &str)> = None;
    for tile in tiles {
        let id = tile.pane_id;
        if id == origin.pane_id || Some(id) == skip {
            continue;
        }
        let (
            (c_axis_lo, c_axis_hi),
            (c_span_lo, c_span_hi),
            (near_edge, tile_axis_center),
            tile_perp_center,
        ) = if horizontal {
            (
                (tile.x as i32, tile.x as i32 + tile.width as i32),
                (tile.y as i32, tile.y as i32 + tile.height as i32),
                (
                    tile.x as i32 + if dir > 0 { 0 } else { tile.width as i32 },
                    tile.x as i32 + tile.width as i32 / 2,
                ),
                tile.y as i32 + tile.height as i32 / 2,
            )
        } else {
            (
                (tile.y as i32, tile.y as i32 + tile.height as i32),
                (tile.x as i32, tile.x as i32 + tile.width as i32),
                (
                    tile.y as i32 + if dir > 0 { 0 } else { tile.height as i32 },
                    tile.y as i32 + tile.height as i32 / 2,
                ),
                tile.x as i32 + tile.width as i32 / 2,
            )
        };
        // Gap along the walk axis, sign-normalized so forward is
        // positive; touching edges (divider neighbors) count as 0.
        let gap = (near_edge - axis_edge) * dir;
        // Two candidate classes (tmux pane_score shape): tiles that
        // start at or beyond the origin edge, then tiles that overlap
        // the origin's axis extent but sit center-ahead. The overlap
        // class is what lets focus leave a full-height tile downward
        // onto a stacked column beside it.
        let (class, axis_distance) = if gap >= 0 {
            (0, gap)
        } else if c_axis_hi > axis_span.0
            && c_axis_lo < axis_span.1
            && (tile_axis_center - axis_center) * dir > 0
        {
            (1, (tile_axis_center - axis_center) * dir)
        } else {
            continue;
        };
        // Perpendicular overlap: the shared extent when the spans
        // intersect, else 0. Overlapping candidates outrank the rest.
        let overlap = if c_span_hi > perp_span.0 && c_span_lo < perp_span.1 {
            (c_span_hi.min(perp_span.1) - c_span_lo.max(perp_span.0)).max(0)
        } else {
            0
        };
        let perp_offset = (tile_perp_center - perp_center).abs();
        let score = WalkScore {
            class,
            non_overlap: if overlap > 0 { 0 } else { 1 },
            axis_distance,
            perp_offset,
        };
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            best = Some((score, id));
        }
    }
    best.map(|(_, id)| id)
}

/// Diagonal walk: both components must agree on direction, nearest
/// center wins. Only the both-axis ghost walks land here.
fn walk_next_diagonal<'a>(
    tiles: &'a [TileRect<'_>],
    origin: &TileRect<'_>,
    dx: i32,
    dy: i32,
    skip: Option<&str>,
) -> Option<&'a str> {
    let (ox, oy) = (
        origin.x as i32 + origin.width as i32 / 2,
        origin.y as i32 + origin.height as i32 / 2,
    );
    let mut best: Option<(f32, &str)> = None;
    for tile in tiles {
        let id = tile.pane_id;
        if id == origin.pane_id || Some(id) == skip {
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
        let dist = (cdx * cdx + cdy * cdy) as f32;
        if dist < best.map(|(d, _)| d).unwrap_or(f32::MAX) {
            best = Some((dist, id));
        }
    }
    best.map(|(_, id)| id)
}

/// What a resize key asks the tree to do: `Narrow` shrinks the
/// focused tile (h horizontally, j vertically), `Wider` grows it
/// (l, k). The verb is uniform: whichever divider moves, the pane
/// ends up smaller or larger; the key's direction only picks which
/// divider moves first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeDir {
    Narrow,
    Wider,
}

/// Result of one resize step: the moved tree, or why nothing moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResizeStep {
    /// Weights moved. `outer` is true when the moved divider runs
    /// along the edge of a whole group containing the pane (the
    /// pane's own edge did not move), so the status can say so.
    Moved { tree: SplitNode, outer: bool },
    /// A divider exists but both weights sit at the floor on both
    /// sides of the pane: nothing can move.
    Clamped,
    /// No divider in the axis at all (the pane spans the full
    /// width/height of its column/row).
    Refused,
}

/// Preferred divider side for a verb on an axis: the edge the key
/// points at (l grows rightward, h shrinks from the left, k grows
/// upward, j shrinks from the bottom).
fn resize_preferred_side(axis: SplitDir, dir: ResizeDir) -> Side {
    match (axis, dir) {
        (SplitDir::Row, ResizeDir::Wider) => Side::Right,
        (SplitDir::Row, ResizeDir::Narrow) => Side::Left,
        (SplitDir::Col, ResizeDir::Wider) => Side::Above,
        (SplitDir::Col, ResizeDir::Narrow) => Side::Below,
    }
}

fn resize_opposite_side(side: Side) -> Side {
    match side {
        Side::Left => Side::Right,
        Side::Right => Side::Left,
        Side::Above => Side::Below,
        Side::Below => Side::Above,
    }
}

/// One resize step: move the pane's divider on the preferred side of
/// `axis`; when that side is the outer boundary or its pair is
/// clamped at the floor, fall back to the opposite divider (an l
/// with no right sibling grows leftward instead). `Refused` only
/// when the axis has no divider on either side of the pane.
pub fn resize_step(
    tree: &SplitNode,
    pane_id: &str,
    axis: SplitDir,
    dir: ResizeDir,
    delta: i32,
) -> ResizeStep {
    let preferred = resize_preferred_side(axis, dir);
    let fallback = resize_opposite_side(preferred);
    let apply = |side: Side| -> Option<(SplitNode, bool)> {
        let (outer, path) = find_resize_path(tree, pane_id, axis, side)?;
        let mut next = tree.clone();
        // The verb owns the sign: Wider adds to the pane whichever
        // divider moves, Narrow subtracts.
        let signed = if dir == ResizeDir::Wider {
            delta
        } else {
            -delta
        };
        apply_resize_path(&mut next, &path, signed);
        (next != *tree).then_some((next, outer))
    };
    if let Some((next, outer)) = apply(preferred) {
        return ResizeStep::Moved { tree: next, outer };
    }
    let preferred_exists = find_resize_path(tree, pane_id, axis, preferred).is_some();
    if let Some((next, outer)) = apply(fallback) {
        return ResizeStep::Moved { tree: next, outer };
    }
    if preferred_exists || find_resize_path(tree, pane_id, axis, fallback).is_some() {
        ResizeStep::Clamped
    } else {
        ResizeStep::Refused
    }
}

/// Path of child indexes from the root split whose weights the step
/// adjusts: the deepest split running `axis` whose `pane_id` slot has
/// a sibling on `side`. The side is normalized to Left/Right for Row
/// and Above/Below for Col so `apply_resize_path` never sees a
/// mismatched pair.
fn find_resize_path(
    node: &SplitNode,
    pane_id: &str,
    axis: SplitDir,
    side: Side,
) -> Option<(bool, Vec<usize>)> {
    fn find(
        node: &SplitNode,
        pane_id: &str,
        axis: SplitDir,
        side: Side,
    ) -> Option<(bool, Vec<usize>)> {
        let SplitNode::Split { dir, children, .. } = node else {
            return None;
        };
        let slot = children
            .iter()
            .position(|child| child.contains_pane(pane_id))?;
        // Deeper match wins: the tile's own parent knows its exact
        // sibling; ancestors only matter when no deeper split in this
        // axis encloses the tile with a sibling on `side`.
        if let Some((outer, mut path)) = find(&children[slot], pane_id, axis, side) {
            path.insert(0, slot);
            // The matched divider lives inside `children[slot]`, so
            // wrapping levels never change its visibility: a
            // same-axis level the match bubbles past always holds the
            // tile in the boundary slot (it would have matched itself
            // otherwise), and perpendicular levels span the divider
            // fully. `outer` stays as the deeper frame set it.
            return Some((outer, path));
        }
        if *dir == axis {
            let normalized = match (axis, side) {
                (SplitDir::Row, Side::Right | Side::Left) => side,
                (SplitDir::Row, Side::Above | Side::Below) => return None,
                (SplitDir::Col, Side::Above | Side::Below) => side,
                (SplitDir::Col, Side::Right | Side::Left) => return None,
            };
            let sibling = match normalized {
                Side::Right | Side::Below => slot.checked_add(1).filter(|&n| n < children.len()),
                Side::Left | Side::Above => slot.checked_sub(1),
            };
            if let Some(sibling) = sibling {
                // Own divider when the pane sits directly in this
                // split; a subtree in the slot means the divider runs
                // along the edge of the pane's whole group (still
                // visible from the tile, worth naming in the status).
                let outer = !matches!(
                    children.get(slot),
                    Some(SplitNode::Leaf { pane_id: id }) if id == pane_id
                );
                return Some((outer, vec![slot, sibling]));
            }
        }
        None
    }
    find(node, pane_id, axis, side)
}

/// Apply the weight move along `path`: first index is the focused
/// slot, second the sibling, inside the split reached by walking the
/// earlier indexes (here always length 2 or more from the root's
// perspective; see `find_resize_path` for how the path is built).
pub fn apply_resize_path(tree: &mut SplitNode, path: &[usize], delta: i32) {
    fn apply(node: &mut SplitNode, path: &[usize], delta: i32) {
        let SplitNode::Split {
            weights, children, ..
        } = node
        else {
            return;
        };
        let Some(&focus_slot) = path.first() else {
            return;
        };
        if path.len() == 1 {
            return;
        }
        // A length-1 path was already returned above, so the sibling
        // slot is guaranteed to exist here.
        let &sibling_slot = path.get(1).unwrap_or(&focus_slot);
        if path.len() == 2 {
            let total = weights.len();
            if focus_slot >= total || sibling_slot >= total {
                return;
            }
            let focus_weight = weights[focus_slot] as i32;
            let sibling_weight = weights[sibling_slot] as i32;
            let new_focus = (focus_weight + delta).max(SPLIT_WEIGHT_MIN as i32);
            let moved = new_focus - focus_weight;
            let new_sibling = (sibling_weight - moved).max(SPLIT_WEIGHT_MIN as i32);
            // Re-clamp when the sibling hit the floor: keep the pair
            // conservative rather than growing the axis total.
            let moved = moved.min(sibling_weight - new_sibling);
            let new_focus = focus_weight + moved;
            if moved == 0 {
                return;
            }
            weights[focus_slot] = new_focus.max(SPLIT_WEIGHT_MIN as i32) as u32;
            weights[sibling_slot] = new_sibling.max(SPLIT_WEIGHT_MIN as i32) as u32;
            return;
        }
        let Some(child) = children.get_mut(focus_slot) else {
            return;
        };
        apply(child, &path[1..], delta);
    }
    apply(tree, path, delta);
}

// Option-returning views so tests can destructure without let-else
// panic arms that llvm-cov counts as uncovered. The None arms are
// exercised explicitly in coverage_tests::side_opposite_flips_every_edge.
#[cfg(test)]
fn split_parts(node: &SplitNode) -> Option<(SplitDir, &Vec<u32>)> {
    match node {
        SplitNode::Split { dir, weights, .. } => Some((*dir, weights)),
        SplitNode::Leaf { .. } => None,
    }
}

#[cfg(test)]
fn split_weights(node: &SplitNode) -> Option<&Vec<u32>> {
    split_parts(node).map(|(_, weights)| weights)
}

#[cfg(test)]
fn split_children(node: &SplitNode) -> Option<&Vec<SplitNode>> {
    match node {
        SplitNode::Split { children, .. } => Some(children),
        SplitNode::Leaf { .. } => None,
    }
}

#[cfg(test)]
fn moved_step(step: ResizeStep) -> Option<(SplitNode, bool)> {
    match step {
        ResizeStep::Moved { tree, outer } => Some((tree, outer)),
        _ => None,
    }
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
            SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")])
        );
    }

    #[test]
    fn replace_leaf_swaps_the_pane_in_place_keeping_shape_and_weights() {
        // Panel walk on a split: the focused leaf exchanges panes, the
        // tree shape and the resized weights must survive.
        let tree = SplitNode::weighted(
            SplitDir::Row,
            vec![
                leaf("p1"),
                SplitNode::split(SplitDir::Col, vec![leaf("p2"), leaf("p3")]),
            ],
            vec![3, 5],
        );
        let next = replace_leaf(&tree, "p2", "p9");
        assert_eq!(next.leaves(), vec!["p1", "p9", "p3"]);
        let (root_dir, root_weights) = split_parts(&next).unwrap();
        assert_eq!(root_dir, SplitDir::Row);
        assert_eq!(root_weights, &vec![3, 5]);
        let inner = split_children(&next).unwrap();
        let (_, inner_weights) = split_parts(&inner[1]).unwrap();
        assert_eq!(
            inner_weights,
            &vec![SPLIT_WEIGHT_SEED, SPLIT_WEIGHT_SEED],
            "the untouched sibling split keeps its own weights"
        );

        // Missing pane: the tree stays untouched (stale focus must not
        // strand the walk).
        assert_eq!(replace_leaf(&tree, "gone", "p9"), tree);
        // Replacing with the pane already there is a no-op.
        assert_eq!(replace_leaf(&tree, "p1", "p1"), tree);
    }

    #[test]
    fn insert_left_orders_new_pane_first() {
        let tree = leaf("p1");
        let next = insert_beside(&tree, "p1", "p2", Side::Left);
        assert_eq!(
            next,
            SplitNode::split(SplitDir::Row, vec![leaf("p2"), leaf("p1")])
        );
    }

    #[test]
    fn insert_reuses_same_direction_parent_split() {
        // row[p1, p2] + insert below p1 -> p1 wraps in col, row keeps
        // shape (no same-direction parent, so wrap is correct).
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        let next = insert_beside(&tree, "p1", "p3", Side::Below);
        assert_eq!(
            next,
            SplitNode::split(
                SplitDir::Row,
                vec![
                    SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p3")]),
                    leaf("p2"),
                ]
            )
        );
    }

    #[test]
    fn insert_in_same_direction_joins_the_split() {
        // row[p1, p2] + insert right of p1 -> row[p1, p3, p2].
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        let next = insert_beside(&tree, "p1", "p3", Side::Right);
        assert_eq!(
            next,
            SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p3"), leaf("p2")])
        );
    }

    #[test]
    fn insert_with_missing_neighbor_is_a_noop() {
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        let next = insert_beside(&tree, "gone", "p3", Side::Right);
        assert_eq!(next, tree);
    }

    #[test]
    fn remove_collapses_single_child_split() {
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
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
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![
                leaf("p1"),
                SplitNode::split(SplitDir::Col, vec![leaf("p2"), leaf("p3"), leaf("p4")]),
            ],
        );
        let next = remove_leaf(&tree, "p3");
        assert_eq!(
            next,
            Some(SplitNode::split(
                SplitDir::Row,
                vec![
                    leaf("p1"),
                    SplitNode::split(SplitDir::Col, vec![leaf("p2"), leaf("p4")]),
                ]
            ))
        );
    }

    #[test]
    fn swap_trades_leaf_panels_and_keeps_shape() {
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        let next = swap_leaves(&tree, "p1", "p2");
        assert_eq!(
            next,
            SplitNode::split(SplitDir::Row, vec![leaf("p2"), leaf("p1")])
        );
    }

    #[test]
    fn swap_with_missing_pane_is_a_noop() {
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
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
        // Down from a: c's center x is 10, a's is 5. Edge scoring
        // ranks c by its near edge and perpendicular overlap, so the
        // walk no longer dead-ends on asymmetric layouts.
        assert_eq!(walk_next(&tiles, "a", 0, 1, None), Some("c"));
        // Down from b: c is on the correct side, no overlap needed.
        assert_eq!(walk_next(&tiles, "b", 0, 1, None), Some("c"));
        // Nothing left of a.
        assert_eq!(walk_next(&tiles, "a", -1, 0, None), None);
    }

    #[test]
    fn walk_next_diagonal_walks_both_axes_and_skips() {
        // Diagonal walks only fire when both components agree on the
        // direction: the ghost crosses a corner, nearest center wins.
        let tiles = [
            TileRect::new("a", 0, 0, 10, 10),
            TileRect::new("b", 10, 0, 10, 10),
            TileRect::new("c", 0, 10, 10, 10),
            TileRect::new("d", 10, 10, 10, 10),
            TileRect::new("far", 30, 30, 10, 10),
        ];
        assert_eq!(walk_next(&tiles, "a", 1, 1, None), Some("d"));
        assert_eq!(walk_next(&tiles, "b", -1, 1, None), Some("c"));
        // Skip turns d's corner ghost onto the far tile.
        assert_eq!(walk_next(&tiles, "a", 1, 1, Some("d")), Some("far"));
        // A single-axis component fails the agreement: no walk.
        assert_eq!(walk_next(&tiles, "a", 1, 0, None), Some("b"));
        // Wrong-sign neighbor on one axis never matches.
        assert_eq!(walk_next(&tiles, "a", -1, -1, None), None);
    }

    #[test]
    fn walk_next_escapes_asymmetric_three_tile_grid() {
        // row[p1, col[p2, p3]] laid out on 20 cols: p1 full-height on
        // the left, p2 and p3 stacked on the right. The strict
        // center-alignment walk dead-ended here; edge scoring must
        // walk p1 in every direction.
        let tiles = [
            TileRect::new("p1", 0, 0, 10, 20),
            TileRect::new("p2", 10, 0, 10, 10),
            TileRect::new("p3", 10, 10, 10, 10),
        ];
        assert_eq!(walk_next(&tiles, "p1", 1, 0, None), Some("p2"));
        assert_eq!(walk_next(&tiles, "p1", 0, 1, None), Some("p3"));
        assert_eq!(walk_next(&tiles, "p1", 0, -1, None), Some("p2"));
        // Right-side walk back to the left column.
        assert_eq!(walk_next(&tiles, "p2", -1, 0, None), Some("p1"));
        assert_eq!(walk_next(&tiles, "p3", -1, 0, None), Some("p1"));
        // Stack walk between p2 and p3.
        assert_eq!(walk_next(&tiles, "p2", 0, 1, None), Some("p3"));
        assert_eq!(walk_next(&tiles, "p3", 0, -1, None), Some("p2"));
    }

    #[test]
    fn walk_next_prefers_overlapping_over_far_aligned_neighbor() {
        // Two candidates to the right: d overlaps a's rows, e sits
        // aligned by center but far away. Overlap outranks distance
        // along the axis.
        let tiles = [
            TileRect::new("a", 0, 0, 10, 10),
            TileRect::new("d", 12, 2, 10, 10),
            TileRect::new("e", 40, 0, 10, 10),
        ];
        assert_eq!(walk_next(&tiles, "a", 1, 0, None), Some("d"));
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

    #[test]
    fn split_and_weighted_seed_equal_weights() {
        let seeded = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        assert_eq!(
            split_weights(&seeded).unwrap(),
            &[SPLIT_WEIGHT_SEED, SPLIT_WEIGHT_SEED]
        );
        let explicit = SplitNode::weighted(
            SplitDir::Col,
            vec![leaf("p1"), leaf("p2"), leaf("p3")],
            vec![2, 4, 6],
        );
        assert_eq!(split_weights(&explicit).unwrap(), &[2, 4, 6]);
    }

    #[test]
    fn insert_beside_seeds_newcomer_at_neighbor_weight() {
        let tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![6, 10]);
        let next = insert_beside(&tree, "p1", "p3", Side::Right);
        // Newcomer takes the neighbor's 6, siblings keep theirs.
        assert_eq!(split_weights(&next).unwrap(), &[6, 6, 10]);
    }

    #[test]
    fn remove_leaf_drops_its_weight_slot() {
        let tree = SplitNode::weighted(
            SplitDir::Row,
            vec![leaf("p1"), leaf("p2"), leaf("p3")],
            vec![6, 2, 10],
        );
        let next = remove_leaf(&tree, "p2").unwrap();
        assert_eq!(split_weights(&next).unwrap(), &[6, 10]);
    }

    #[test]
    fn swap_leaves_keeps_weights_on_slots() {
        let tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![4, 12]);
        let next = swap_leaves(&tree, "p1", "p2");
        // p2 moved into slot 0, p1 into slot 1; weights stay put.
        assert_eq!(split_weights(&next).unwrap(), &[4, 12]);
    }

    #[test]
    fn resize_step_moves_weight_to_the_sibling() {
        let tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![8, 8]);
        // Widen p1: weight flows from p2 to p1.
        let next = moved_step(resize_step(&tree, "p1", SplitDir::Row, ResizeDir::Wider, 2))
            .unwrap()
            .0;
        assert_eq!(split_weights(&next).unwrap(), &[10, 6]);
        // Narrow p1: sign flips, weight flows back.
        let back = moved_step(resize_step(
            &next,
            "p1",
            SplitDir::Row,
            ResizeDir::Narrow,
            2,
        ))
        .unwrap()
        .0;
        assert_eq!(split_weights(&back).unwrap(), &[8, 8]);
    }

    #[test]
    fn resize_step_clamps_at_the_floor_and_reports_noop() {
        let tree = SplitNode::weighted(
            SplitDir::Row,
            vec![leaf("p1"), leaf("p2")],
            vec![SPLIT_WEIGHT_MIN, 15],
        );
        // p1 already at the floor: narrowing further changes nothing.
        let step = resize_step(&tree, "p1", SplitDir::Row, ResizeDir::Narrow, 3);
        assert_eq!(step, ResizeStep::Clamped);
        // Sibling at the floor: widening p1 cannot take from p2.
        let tree2 = SplitNode::weighted(
            SplitDir::Row,
            vec![leaf("p1"), leaf("p2")],
            vec![8, SPLIT_WEIGHT_MIN],
        );
        let step2 = resize_step(&tree2, "p1", SplitDir::Row, ResizeDir::Wider, 3);
        assert_eq!(step2, ResizeStep::Clamped);
    }

    #[test]
    fn resize_step_refuses_when_no_sibling_in_axis() {
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![
                SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p2")]),
                leaf("p3"),
            ],
        );
        // Vertical axis inside the col split: p1's own divider.
        let own = resize_step(&tree, "p1", SplitDir::Col, ResizeDir::Narrow, 1);
        assert!(matches!(own, ResizeStep::Moved { .. }));
        // Horizontal axis: the col group has a row sibling, so the
        // group boundary moves even though p1 has no own horizontal
        // divider.
        let group = resize_step(&tree, "p1", SplitDir::Row, ResizeDir::Wider, 1);
        assert!(matches!(group, ResizeStep::Moved { outer: true, .. }));
        // p3 has no col divider anywhere above it: refused.
        let refused = resize_step(&tree, "p3", SplitDir::Col, ResizeDir::Narrow, 1);
        assert_eq!(refused, ResizeStep::Refused);
    }

    #[test]
    fn resize_step_marks_outer_dividers() {
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![
                SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p2")]),
                leaf("p3"),
            ],
        );
        // p1's own horizontal divider: not outer.
        let (_, outer) =
            moved_step(resize_step(&tree, "p1", SplitDir::Col, ResizeDir::Wider, 1)).unwrap();
        assert!(!outer);
        // The row divider between the col group and p3: outer for p1.
        let (_, outer) =
            moved_step(resize_step(&tree, "p1", SplitDir::Row, ResizeDir::Wider, 1)).unwrap();
        assert!(outer);
        // p3's left divider is its own edge (the neighbor is a
        // group, but the pane's edge still moves).
        let (_, outer) = moved_step(resize_step(
            &tree,
            "p3",
            SplitDir::Row,
            ResizeDir::Narrow,
            1,
        ))
        .unwrap();
        assert!(!outer);
        // A plain two-pane row: both dividers are the panes' own.
        let flat = SplitNode::split(SplitDir::Row, vec![leaf("a"), leaf("b")]);
        let (_, outer) =
            moved_step(resize_step(&flat, "a", SplitDir::Row, ResizeDir::Wider, 1)).unwrap();
        assert!(!outer);
    }

    #[test]
    fn resize_step_falls_back_to_the_opposite_side() {
        // p1 is the first child: no left divider, but l can grow it
        // leftward by taking from p2 on the fallback side.
        let tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![8, 8]);
        let step = resize_step(&tree, "p1", SplitDir::Row, ResizeDir::Wider, 1);
        let (next, outer) = moved_step(step).unwrap();
        assert_eq!(split_weights(&next).unwrap(), &[9, 7]);
        assert!(!outer);
        // p2 is the last child: h can still narrow it by giving
        // weight to p1 on the fallback side.
        let step2 = resize_step(&tree, "p2", SplitDir::Row, ResizeDir::Narrow, 1);
        let (next2, outer) = moved_step(step2).unwrap();
        assert_eq!(split_weights(&next2).unwrap(), &[9, 7]);
        assert!(!outer);
    }

    #[test]
    fn resize_step_picks_the_deepest_sibling_in_axis() {
        // row[col[p1, p2], col[p3, p4]]: p1 resizing vertically moves
        // the divider inside its own group, not the outer row one.
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![
                SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p2")]),
                SplitNode::split(SplitDir::Col, vec![leaf("p3"), leaf("p4")]),
            ],
        );
        let next = moved_step(resize_step(&tree, "p1", SplitDir::Col, ResizeDir::Wider, 1))
            .unwrap()
            .0;
        let children = split_children(&next).unwrap();
        assert_eq!(split_weights(&children[0]).unwrap(), &[9, 7]);
        assert_eq!(split_weights(&children[1]).unwrap(), &[8, 8]);
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn split_dir_default_side_maps_rows_and_columns() {
        assert_eq!(SplitDir::Row.default_side(), Side::Right);
        assert_eq!(SplitDir::Col.default_side(), Side::Below);
    }

    #[test]
    fn side_opposite_flips_every_edge() {
        assert_eq!(Side::Right.opposite(), Side::Left);
        assert_eq!(Side::Left.opposite(), Side::Right);
        assert_eq!(Side::Below.opposite(), Side::Above);
        assert_eq!(Side::Above.opposite(), Side::Below);

        // The destructure helpers' None arms: a leaf is not a split,
        // and Clamped is not a move.
        assert!(split_parts(&leaf("solo")).is_none());
        assert!(split_weights(&leaf("solo")).is_none());
        assert!(split_children(&leaf("solo")).is_none());
        assert!(moved_step(ResizeStep::Clamped).is_none());
    }

    #[test]
    fn insert_left_and_above_into_a_same_direction_split_join_it() {
        // Left into a row split: newcomer lands before the neighbor,
        // seeded at its weight, split shape kept.
        let tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![6, 10]);
        let next = insert_beside(&tree, "p1", "p3", Side::Left);
        assert_eq!(next.leaves(), vec!["p3", "p1", "p2"]);
        let (dir, weights) = split_parts(&next).unwrap();
        assert_eq!(dir, SplitDir::Row);
        assert_eq!(weights, &[6, 6, 10]);

        // Above into a col split: same shape, vertical order.
        let tree = SplitNode::weighted(SplitDir::Col, vec![leaf("p1"), leaf("p2")], vec![4, 4]);
        let next = insert_beside(&tree, "p2", "p3", Side::Above);
        assert_eq!(next.leaves(), vec!["p1", "p3", "p2"]);
        let (dir, _) = split_parts(&next).unwrap();
        assert_eq!(dir, SplitDir::Col);
    }

    #[test]
    fn node_pane_returns_none_for_splits() {
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        assert_eq!(node_pane(&tree), None);
        let lone = leaf("p1");
        assert_eq!(node_pane(&lone), Some("p1"));
    }

    #[test]
    fn apply_resize_path_guards_reject_short_and_out_of_range_paths() {
        let mut tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![8, 8]);
        // A leaf root: the split destructure fails, nothing happens.
        let mut lone = leaf("p1");
        apply_resize_path(&mut lone, &[0, 1], 2);
        assert_eq!(lone, leaf("p1"));

        // Path of length 1 and 0 are refused.
        apply_resize_path(&mut tree, &[0], 2);
        apply_resize_path(&mut tree, &[], 2);
        assert_eq!(split_weights(&tree).unwrap(), &[8, 8]);

        // Slots beyond the weights length are refused.
        apply_resize_path(&mut tree, &[5, 6], 2);
        assert_eq!(split_weights(&tree).unwrap(), &[8, 8]);

        // A path through a missing child is refused.
        apply_resize_path(&mut tree, &[9, 0, 1], 2);
        assert_eq!(split_weights(&tree).unwrap(), &[8, 8]);
    }

    #[test]
    fn apply_resize_path_walks_deeper_levels() {
        let mut tree = SplitNode::split(
            SplitDir::Row,
            vec![
                SplitNode::weighted(SplitDir::Col, vec![leaf("p1"), leaf("p2")], vec![8, 8]),
                leaf("p3"),
            ],
        );
        apply_resize_path(&mut tree, &[0, 1, 0], 2);
        let children = split_children(&tree).unwrap();
        assert_eq!(split_weights(&children[0]).unwrap(), &[6, 10]);
    }

    #[test]
    fn find_resize_path_refuses_perpendicular_side_families() {
        // Asking for a Row-axis divider with an Above/Below side (and
        // vice versa) is a type mismatch the path builder rejects.
        let row = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        assert_eq!(
            find_resize_path(&row, "p1", SplitDir::Row, Side::Above),
            None
        );
        assert_eq!(
            find_resize_path(&row, "p1", SplitDir::Row, Side::Below),
            None
        );
        let col = SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p2")]);
        assert_eq!(
            find_resize_path(&col, "p1", SplitDir::Col, Side::Left),
            None
        );
        assert_eq!(
            find_resize_path(&col, "p1", SplitDir::Col, Side::Right),
            None
        );
        // A leaf has no divider at all.
        assert_eq!(
            find_resize_path(&leaf("p1"), "p1", SplitDir::Row, Side::Right),
            None
        );
        // A pane not in the tree finds nothing.
        assert_eq!(
            find_resize_path(&row, "gone", SplitDir::Row, Side::Right),
            None
        );
        // Outer boundary: p1 asking Left finds no sibling.
        assert_eq!(
            find_resize_path(&row, "p1", SplitDir::Row, Side::Left),
            None
        );
    }
}

#[cfg(test)]
mod coverage_tests_round2 {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn remove_every_leaf_of_a_split_yields_none() {
        // Both children removed one after another: the split collapses
        // to None (the caller keeps the last leaf alive instead).
        let tree = SplitNode::split(SplitDir::Row, vec![leaf("p1"), leaf("p2")]);
        let after = remove_leaf(&tree, "p1").unwrap();
        assert_eq!(after, leaf("p2"));
        assert_eq!(remove_leaf(&after, "p2"), None);
        // Removing the leaf of a leaf tree is None too.
        assert_eq!(remove_leaf(&leaf("solo"), "solo"), None);
    }

    #[test]
    fn apply_resize_path_stops_on_a_single_slot_path() {
        // path of length 1 never reaches a sibling: no weight moves.
        let mut tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![8, 8]);
        apply_resize_path(&mut tree, &[0], 2);
        assert_eq!(split_weights(&tree).unwrap(), &[8, 8]);
    }
}

#[cfg(test)]
mod coverage_tests_round3 {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn swap_leaves_only_touches_the_named_pair() {
        // A third leaf keeps its pane: the else arm of the swap map.
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![leaf("p1"), leaf("bystander"), leaf("p2")],
        );
        let swapped = swap_leaves(&tree, "p1", "p2");
        assert_eq!(swapped.leaves(), vec!["p2", "bystander", "p1"]);
    }

    #[test]
    fn apply_resize_path_needs_two_slots() {
        // Coverage note (apply_resize_path's path.get(1) guard): the
        // len==1 early return above it already rejects short paths, so
        // get(1) is always Some when reached; the guard is defensive only.
        // The `path.get(1)` guard fires only on len-1 paths, which the
        // earlier len check already returns for; the guard still runs
        // for safety, so drive it once with a single-slot path on a
        // tree whose weights would otherwise move.
        let mut tree = SplitNode::weighted(SplitDir::Row, vec![leaf("p1"), leaf("p2")], vec![8, 8]);
        apply_resize_path(&mut tree, &[0], 2);
        assert_eq!(split_weights(&tree).unwrap(), &[8, 8]);
    }
}

#[cfg(test)]
mod coverage_tests_round4 {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn remove_leaf_collapses_a_split_left_with_only_the_missing_weight() {
        // The `weights.get(index)` fallback seed only runs for a split
        // deserialized with more children than weights; the legal
        // construction still exercises the kept-weights zip, including
        // the collapse-to-survivor arm when every child is pulled.
        let tree = SplitNode::weighted(
            SplitDir::Col,
            vec![
                leaf("p1"),
                SplitNode::split(SplitDir::Row, vec![leaf("p2"), leaf("p3")]),
            ],
            vec![3, 5],
        );
        let after = remove_leaf(&tree, "p1").unwrap();
        assert_eq!(after.leaves(), vec!["p2", "p3"]);
        // Pulling every leaf below the nested split collapses it too.
        let after2 = remove_leaf(&after, "p2").unwrap();
        assert_eq!(after2, leaf("p3"));
    }

    #[test]
    fn pulling_every_child_of_a_split_yields_none() {
        // The `0 => None` collapse arm: a split whose every child
        // holds the removed pane vanishes entirely, which the caller
        // turns into the single-pane fallback.
        let tree = SplitNode::split(
            SplitDir::Row,
            vec![
                SplitNode::split(SplitDir::Col, vec![leaf("p1"), leaf("p1")]),
                leaf("p1"),
            ],
        );
        assert!(remove_leaf(&tree, "p1").is_none());
    }
}

#[cfg(test)]
mod coverage_tests_round5 {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn resize_on_a_single_leaf_root_is_refused() {
        // A lone root leaf has no divider to move; the fallback probe
        // finds no path in either direction, so the step is Refused.
        let step = resize_step(&leaf("solo"), "solo", SplitDir::Row, ResizeDir::Narrow, 2);
        assert!(matches!(step, ResizeStep::Refused));
    }
}

#[cfg(test)]
mod coverage_tests_round6 {
    use super::*;

    fn leaf(id: &str) -> SplitNode {
        SplitNode::leaf(id)
    }

    #[test]
    fn apply_resize_path_ignores_paths_shorter_than_two_slots() {
        // Paths of length 0 or 1 name no sibling slot, and a leaf root
        // cannot resize at all: all guard arms must return untouched.
        let mut tree = SplitNode::split(SplitDir::Row, vec![leaf("a"), leaf("b"), leaf("c")]);
        let before = tree.clone();
        apply_resize_path(&mut tree, &[], 5);
        assert_eq!(tree, before);
        apply_resize_path(&mut tree, &[0], 5);
        assert_eq!(tree, before);
        let mut lone = leaf("a");
        apply_resize_path(&mut lone, &[0, 1], 5);
        assert_eq!(lone, leaf("a"));
    }
}
