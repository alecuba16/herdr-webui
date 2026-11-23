// ---- tab drag between panes (Phase 5) ----------------------------------
// Editor and git tabs drag between leaves; terminal tabs are the
// singleton surface and never leave their leaf. The caret is a marker
// element the dragover handler moves between tab slots, so the drop
// target is always a concrete index, not an approximate hover.
let paneDragTabId = null;

function paneTabDragStart(event) {
  if (!event || !event.target || !event.target.dataset) return;
  const tabId = event.target.dataset.tabId;
  if (!tabId) return;
  // Terminal tabs drag under the D7 invariants: the move is atomic on
  // drop (one splice out, one splice in, one sync pass), the surface
  // keeps its identity (the singleton follows the route tab, an aux
  // re-parents by tab key), and the workspace stays on the tab row
  // (never re-assigned by the hosting leaf). Refusing the drag was the
  // pre-mixed-tree behavior.
  paneDragTabId = tabId;
  if (event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-tab", tabId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  if (event.target.classList && event.target.classList.add) event.target.classList.add("pane-tab-dragging");
}

function paneTabDragEnd() {
  paneDragTabId = null;
  // Abandoning a tab drag mid-flight must clear the chrome it owns
  // (preview square, caret, workspace hint), or the dotted square
  // sticks on the last hovered half. The location bar's remove
  // indicator clears here too: the drag may end on the bar's drop, in
  // which case the bar's own drop handler already ran; anywhere else
  // the class would stick.
  clearPanelDropPreview();
  clearPaneDropCaret();
  clearPaneWorkspaceDropHint();
  clearLocationBarPaneRemove();
  document.querySelectorAll(".pane-tab-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-tab-dragging");
  });
}

// The location bar's ungroup affordance: a herdr-pane-tab drag whose
// owning panel sits in a group qualifies (the remove indicator
// paints on hover); the drop hands the panel back to the rail as an
// ungrouped label.
function clearLocationBarPaneRemove() {
  const bar = el("locationBar");
  if (bar && bar.classList && bar.classList.remove) bar.classList.remove("location-bar-pane-remove");
}

// The ungroup gesture: a member's LABEL (terminal tab) dragged to the
// location bar leaves the group. Qualifies while the drag rides a
// terminal tab whose owning panel belongs to a group with 2+ members.
function paneTabUnsplitTarget(tabId) {
  if (!tabId) return null;
  const root = paneRootFor();
  if (!paneTreeRenderable(root)) return null;
  const leaf = paneForTab(root, tabId);
  if (!leaf || !leaf.groupId) return null;
  const group = groupForLeaf(root, leaf);
  if (!group || groupMemberCount(group) < 2) return null;
  return { leaf, group };
}

function paneTabUnsplitHover(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  if (!drag || drag.kind !== "tab") return false;
  if (!paneTabUnsplitTarget(drag.tabId)) return false;
  return true;
}

function paneTabUnsplitDrop(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? { kind: "tab", tabId: event.dataTransfer.getData("text/herdr-pane-tab") }
      : null);
  if (!drag || drag.kind !== "tab") return false;
  const target = paneTabUnsplitTarget(drag.tabId);
  if (!target) return false;
  paneTabDragEnd();
  ungroupMember(target.leaf);
  return true;
}

// Remove a member from its group: the member turns back into an
// ungrouped panel (its label returns to the rail). The group keeps
// the remaining members; dropping under two dissolves it entirely
// and, when it was visible, the subject heals through visibleSubject.
function ungroupMember(leaf) {
  const root = paneRootFor();
  const group = groupForLeaf(root, leaf);
  if (!group) return false;
  return panesOpWithFallback(
    { op: "group.ungroup", paneId: leaf.paneId },
    () => localUngroupMember(leaf),
  );
}

function localUngroupMember(leaf) {
  const root = paneRootFor();
  const group = groupForLeaf(root, leaf);
  if (!group) return false;
  // Survivor and subject reads BEFORE the member splice: the member
  // list dies with the record on a dissolve, and the heal needs the
  // surviving sibling, not the panels[0] fallback.
  const survivor = groupMembers(group, root).find((member) => member !== leaf) || null;
  const wasVisible = !!(root.visible && root.visible.type === "group" && root.visible.id === group.groupId);
  const at = group.memberIds.indexOf(leaf.paneId);
  if (at >= 0) group.memberIds.splice(at, 1);
  leaf.groupId = null;
  if (groupMemberCount(group, root) < 2) {
    for (const member of groupMembers(group, root)) member.groupId = null;
    const atRec = root.groups.indexOf(group);
    if (atRec >= 0) root.groups.splice(atRec, 1);
    // The dissolve hands the subject to the surviving member when the
    // pointer named this group; visibleSubject below re-derives the
    // same pointer from the healed panel id.
    if (survivor && wasVisible) root.visible = { type: "panel", id: survivor.paneId };
  } else {
    group.layout = memberLayoutWithout(group.layout, leaf.paneId);
    // Focus memory cannot name the just-removed member: the record
    // keeps a dead pointer otherwise, and reopening the group would
    // fall back to members[0] only because of the normalize heal.
    if (group.focusedPaneId === leaf.paneId) group.focusedPaneId = null;
  }
  const subject = visibleSubject(root);
  root.visible = subject && subject.kind === "group"
    ? { type: "group", id: subject.group.groupId }
    : { type: "panel", id: subject.leaf.paneId };
  saveWorkspacePanesStates();
  renderWorkspacePanes();
  return true;
}

// Layout surgery: drop paneId from the layout tree. A split that falls
// under two children collapses to its survivor; the ROOT dropping to
// one child returns that child (a paneId string or nested node). A
// degraded FLAT array filters the id directly: without it the removed
// member would sit in the layout until the next normalize rebuild.
function memberLayoutWithout(node, paneId) {
  if (!node) return null;
  if (node === paneId) return null;
  if (Array.isArray(node)) {
    const kept = node.filter((child) => child !== paneId);
    return kept.length ? kept : null;
  }
  if (!Array.isArray(node.children)) return node;
  // Track the ORIGINAL index while filtering: sizes pair with children
  // by position, so remapping survivors by kept-index gave every child
  // after the removed slot its left neighbor's size.
  let removedAt = -1;
  node.children = node.children
    .map((child, i) => {
      const next = memberLayoutWithout(child, paneId);
      if (next === null && removedAt < 0) removedAt = i;
      return next;
    })
    .filter(Boolean);
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  if (Array.isArray(node.sizes)) {
    const sizes = [];
    let kept = 0;
    for (let i = 0; i < node.children.length; i++) {
      const src = kept + (removedAt >= 0 && kept >= removedAt ? 1 : 0);
      const raw = node.sizes[src];
      sizes.push(Number.isFinite(raw) && raw > 0 ? raw : 1);
      kept++;
    }
    node.sizes = sizes;
  }
  return node;
}

// Rail label drag (one-visible-view model): a panel label picked from
// the rail carries the panel's paneId. The drop creates or extends a
// group at the previewed quadrant. Group chips never drag (spec has
// no group-drag gesture).
let paneDragLabelPaneId = null;

function paneLabelDragStart(event, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const root = paneRootFor();
  const leaf = paneId ? paneForPaneId(root, paneId) : null;
  // A grouped member never drags as a grouping payload: panels cannot
  // group outside a split view, and a parked (hidden) group member is
  // not addressable until its chip reopens the split. Leaving a group
  // is the tab-to-location-bar ungroup gesture inside the split.
  // Refuse the dragstart so the chip cannot offer a dead drop target.
  if (!leaf || leaf.groupId) {
    if (event && event.preventDefault) event.preventDefault();
    return;
  }
  paneDragLabelPaneId = paneId;
  if (event && event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-label", paneId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  const chip = event && event.target;
  if (chip && chip.classList && chip.classList.add) chip.classList.add("pane-label-dragging");
}

function paneLabelDragEnd() {
  paneDragLabelPaneId = null;
  clearPanelDropPreview();
  document.querySelectorAll(".pane-label-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-label-dragging");
  });
}

function paneLabelDragKind() {
  return paneDragLabelPaneId ? { kind: "label", paneId: paneDragLabelPaneId } : null;
}

// Member drag (group view): a strip chip of a VISIBLE-group member
// carries the panel's paneId. Inside the split the drop re-positions
// the panel; over the rail it ungroups. The member kind outranks the
// tab kind in activeDragKind so a terminal-tab drag started from the
// same strip never forks the state mid-gesture.
let paneDragMemberPaneId = null;

function paneMemberDragStart(event, encodedPaneId) {
  const paneId = decodeURIComponent(String(encodedPaneId || ""));
  const root = paneRootFor();
  const leaf = paneId ? paneForPaneId(root, paneId) : null;
  const group = groupForLeaf(root, leaf);
  // Only a member of the visible split drags: an independent panel's
  // chip never carries the drag wiring, and a stale group (dissolved
  // under the pointer mid-gesture) must not arm a dead drag.
  if (!leaf || !group || !visibleSubjectIsGroup(root, group.groupId)) {
    if (event && event.preventDefault) event.preventDefault();
    return;
  }
  paneDragMemberPaneId = paneId;
  if (event && event.dataTransfer) {
    event.dataTransfer.setData("text/herdr-pane-member", paneId);
    if ("effectAllowed" in event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  const chip = event && event.target;
  if (chip && chip.classList && chip.classList.add) chip.classList.add("pane-label-dragging");
}

function paneMemberDragEnd() {
  paneDragMemberPaneId = null;
  clearPanelDropPreview();
  clearPaneDropCaret();
  clearPaneWorkspaceDropHint();
  document.querySelectorAll(".pane-rail-drop-target").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-rail-drop-target");
  });
  document.querySelectorAll(".pane-label-dragging").forEach((node) => {
    if (node.classList && node.classList.remove) node.classList.remove("pane-label-dragging");
  });
}

function paneMemberDragKind() {
  return paneDragMemberPaneId ? { kind: "member", paneId: paneDragMemberPaneId } : null;
}

// Which slot does the pointer sit at? Compare the pointer x against each
// tab's midpoint: the caret sits where the dragged tab would land.
function paneDropIndexAt(strip, event, draggedId) {
  const tabs = [...strip.children].filter(
    (child) => child.classList && child.classList.contains && child.classList.contains("pane-tab")
      && !child.classList.contains("pane-tab-dragging")
      && child.dataset.tabId !== draggedId
  );
  const pointerX = event.clientX || 0;
  for (let index = 0; index < tabs.length; index++) {
    const rect = tabs[index].getBoundingClientRect ? tabs[index].getBoundingClientRect() : null;
    if (!rect) continue;
    if (pointerX < rect.left + rect.width / 2) return index;
  }
  return tabs.length;
}

function clearPaneDropCaret() {
  document.querySelectorAll(".pane-drop-caret").forEach(detachDomNode);
}

function paneDropCaretAt(strip, index) {
  clearPaneDropCaret();
  const tabs = [...strip.children].filter(
    (child) => child.classList && child.classList.contains && child.classList.contains("pane-tab")
      && !child.classList.contains("pane-tab-dragging")
  );
  const caret = document.createElement("div");
  caret.className = "pane-drop-caret";
  if (index >= tabs.length) {
    const last = tabs[tabs.length - 1];
    const lastRect = last && last.getBoundingClientRect ? last.getBoundingClientRect() : null;
    const stripRect = strip.getBoundingClientRect ? strip.getBoundingClientRect() : null;
    if (lastRect && stripRect) {
      caret.style.left = `${lastRect.right - stripRect.left}px`;
    }
  } else {
    const rect = tabs[index].getBoundingClientRect ? tabs[index].getBoundingClientRect() : null;
    const stripRect = strip.getBoundingClientRect ? strip.getBoundingClientRect() : null;
    if (rect && stripRect) {
      caret.style.left = `${rect.left - stripRect.left - 1}px`;
    }
  }
  strip.appendChild(caret);
}

// Hover preview for a workspace card held over a pane strip (D3 speed
// path): "Open terminal: <label> here". A real node (not a bare outline)
// so the drop target reads as concrete; one node at a time.
function paneWorkspaceDropHint(strip, workspaceId) {
  clearPaneWorkspaceDropHint();
  const workspace = (state.workspaces || []).find((w) => w.workspace_id === workspaceId);
  if (!workspace) return;
  // Every panel-facing surface speaks worktreeDisplayName (branch or
  // checkout basename); workspaceDisplayTitle is label-first and would
  // name the same worktree differently here than in the chip beside it.
  const label =
    (typeof worktreeDisplayName === "function" && worktreeDisplayName(workspace)) ||
    workspace.label ||
    workspaceId;
  const hint = document.createElement("div");
  hint.className = "pane-ws-drop-hint";
  hint.textContent = `Open terminal: ${label} here`;
  strip.appendChild(hint);
}

function clearPaneWorkspaceDropHint() {
  document.querySelectorAll(".pane-ws-drop-hint").forEach(detachDomNode);
}

// Which drag payload is in flight: a pane tab (text/herdr-pane-tab), a
// strip member chip (text/herdr-pane-member, the visible group's view),
// a rail panel label (text/herdr-pane-label), or a sidebar workspace
// card (state.dragWorkspace, set by workspaceDragStart). Member and
// tab drags win when several signals somehow exist (a member drag is
// never a tab drag: the kinds are armed by different elements).
function activeDragKind() {
  if (paneMemberDragKind()) return paneMemberDragKind();
  if (paneDragLabelPaneId) return { kind: "label", paneId: paneDragLabelPaneId };
  if (paneDragTabId) return { kind: "tab", tabId: paneDragTabId };
  if (state.dragWorkspace) return { kind: "workspace", workspaceId: state.dragWorkspace };
  return null;
}

// Container-level drags (one-visible-view model): a TAB drag keeps the
// member-strip caret flow; a LABEL drag from the rail previews the
// split quadrant over the visible subject; a MEMBER drag from a group
// strip chip previews the re-position quadrant over another member's
// pane. All share the container wiring from wirePanelChipDrag.
function paneContainerTabDragOver(event) {
  const drag = activeDragKind();
  if (!drag) return;
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (drag.kind === "label" || drag.kind === "member") {
    if (onStrip) return;
    const container = el("workspacePanes");
    const target = panelDropTargetAt(container, event);
    const valid = drag.kind === "label" ? labelDropTargetValid(target, drag) : memberDropTargetValid(target, drag);
    if (!target || !valid) {
      clearPanelDropPreview();
      return;
    }
    if (event.preventDefault) event.preventDefault();
    if (event.dataTransfer && "dropEffect" in event.dataTransfer)
      event.dataTransfer.dropEffect = "move";
    positionPanelDropPreview(container, event, target);
    return;
  }
  if (drag.kind !== "tab") return;
  // The strip owns its own hover: skip when the pointer rides a strip
  // so the caret keeps precedence and the square never overlaps it.
  if (onStrip) return;
  // TAB drags no longer split: the group gesture owns geometry. The
  // caret path in the strips handles reordering; content hovers keep
  // the preview hidden so a release over dead space drops clean.
  clearPanelDropPreview();
}

// A member re-position drop qualifies on another member of the same
// visible group: the release pane hosts the dragged view's new slot.
// The dragged member never hosts its own drop (a no-op at best, a
// corruption vector at worst: layoutWithPanelAt assumes an external
// id).
function memberDropTargetValid(target, drag) {
  const root = paneRootFor();
  if (!target || !target.paneId) return false;
  const dragged = paneForPaneId(root, (drag && drag.paneId) || (paneMemberDragKind() ? paneMemberDragKind().paneId : null));
  if (!dragged || !dragged.groupId) return false;
  const group = groupForLeaf(root, dragged);
  if (!group || !visibleSubjectIsGroup(root, group.groupId)) return false;
  if (target.paneId === dragged.paneId) return false;
  const host = paneForPaneId(root, target.paneId);
  return !!(host && host.groupId === group.groupId);
}

// A label drop qualifies only when the auto-join neighbor exists
// (panel subject) or the visible subject is a group (growth). The
// dragged panel itself never hosts its own drop.
function labelDropTargetValid(target, drag) {
  const root = paneRootFor();
  if (!target || !target.paneId) return false;
  const subject = visibleSubject(root);
  if (!subject) return false;
  // The dragged panel comes from the CAPTURED drag state (payload or
  // module state), never from the drop host: after paneLabelDragEnd()
  // clears the module state, a host fallback would resolve the host
  // itself as the dragged panel and refuse every drop.
  const dragged = paneForPaneId(root, (drag && drag.paneId) || (paneLabelDragKind() ? paneLabelDragKind().paneId : null));
  if (!dragged) return false;
  if (subject.kind === "group") {
    // Growth needs the dragged panel OUTSIDE the group (a member drag
    // is the ungroup gesture, never a re-position).
    return !dragged.groupId;
  }
  if (subject.leaf === dragged) return false;
  const neighbor = autoJoinNeighborFor(dragged);
  return !!neighbor;
}

// The auto-join neighbor (spec point 3): the ungrouped panel beside
// the dragged one in rail order, right by default, left when the
// dragged label is the LAST (or the settings choice flips the side).
function autoJoinNeighborFor(dragged) {
  const root = paneRootFor();
  const ungrouped = railOrderUngroupedPanels(root);
  const at = ungrouped.indexOf(dragged);
  if (at < 0) return null;
  // The settings choice flips which neighbor fills the other half
  // ("right" default, "left" alternative). Bundle-scope options, same
  // read pane_terminals uses; the typeof guard keeps standalone-VM
  // harnesses (no core.js) on the default.
  const preferLeft = typeof options === "object" && options && options.paneGroupAutoJoin === "left";
  const next = ungrouped[at + 1] || null;
  const prev = ungrouped[at - 1] || null;
  // Right preference: the right neighbor when it exists, else the
  // left. The dragged-last rule in the spec ("left if its the
  // latest") falls out of the same fallback.
  if (preferLeft) return prev || next;
  return next || prev;
}

// Rail order for the neighbor rule: ungrouped panels in entry.panels
// order (the rail renders that list verbatim).
function railOrderUngroupedPanels(root) {
  return paneLeaves(root).filter((leaf) => !leaf.groupId);
}

// Label drop on the visible subject: create the group (panel subject)
// or grow the visible group. The dragged panel lands at the previewed
// quadrant; the auto-join neighbor fills the opposite side. A member
// drop re-positions the dragged view inside the visible group.
function paneContainerTabDrop(event) {
  const drag = activeDragKind()
    || (event && event.dataTransfer && event.dataTransfer.getData
      ? dropDragKindFromData(event.dataTransfer)
      : null);
  if (!drag) return;
  const onStrip = event.target && event.target.closest && event.target.closest(".pane-tab-strip");
  if (onStrip) return;
  if (drag.kind === "member") {
    const container = el("workspacePanes");
    const target = panelDropTargetAt(container, event);
    if (!target || !memberDropTargetValid(target, drag)) {
      paneMemberDragEnd();
      return;
    }
    if (event.preventDefault) event.preventDefault();
    const moved = repositionGroupMember(drag.paneId, target.paneId, target.axis === "row" ? "row" : "column", target.first);
    paneMemberDragEnd();
    return;
  }
  if (drag.kind !== "label") {
    // TAB drops outside strips end the drag cleanly: strips own every
    // tab drop, and content hovers offered no preview.
    if (drag.kind === "tab") paneTabDragEnd();
    return;
  }
  const container = el("workspacePanes");
  const target = panelDropTargetAt(container, event);
  // The drag state must survive until the validity gate and the
  // surgery below resolve the dragged panel: paneLabelDragEnd() clears
  // paneDragLabelPaneId, so an earlier call would leave the validity
  // check reading the DROP HOST as the dragged panel (every drop
  // refused). The clear runs on every exit through the finally-style
  // call below, so no path leaks drag state.
  if (!target || !labelDropTargetValid(target, drag)) {
    paneLabelDragEnd();
    return;
  }
  if (event.preventDefault) event.preventDefault();
  const root = paneRootFor();
  const dragged = paneForPaneId(root, drag.paneId);
  if (!dragged) {
    paneLabelDragEnd();
    return;
  }
  const axis = target.axis === "row" ? "row" : "column";
  // The layout host for growth drops: the pane the pointer rode. The
  // clear must run on EVERY exit (a refused drop would otherwise leak
  // the host into the next growth drop and misplace it).
  dropHostPaneId = target.paneId || null;
  let landed = false;
  // The drop tail below owns the single save+render: skipping the
  // settle render keeps local-mode drops at one paint instead of two.
  const settleOpts = { skipRender: true };
  if (labelDropCreatesGroup(root)) {
    landed = createGroupFromDrop(dragged, axis, target.first, settleOpts);
  } else {
    landed = growVisibleGroupWith(dragged, axis, target.first, settleOpts);
  }
  dropHostPaneId = null;
  paneLabelDragEnd();
  if (!landed) return;
  // A thenable landed value means a server op owns the outcome: its
  // settle owns save+render. REJECTED is not thenable and still paints
  // here; a local paint on the promise path would persist and paint a
  // visible subject with the "__pending__" placeholder id. The server
  // SUCCESS path adopted and rendered inside the op, so it returns a
  // thenable and skips this tail.
  if (landed && typeof landed.then === "function") return;
  saveWorkspacePanesStates();
  renderWorkspacePanes();
}

// dataTransfer-only drops (no dragstart ran in this document, e.g. a
// stub event): read the payload kind straight from the data. The
// member payload outranks the label one: both carry a paneId, but a
// member payload only ever mints on a visible-group chip.
function dropDragKindFromData(dataTransfer) {
  const member = dataTransfer.getData("text/herdr-pane-member");
  if (member) return { kind: "member", paneId: member };
  const label = dataTransfer.getData("text/herdr-pane-label");
  if (label) return { kind: "label", paneId: label };
  const tab = dataTransfer.getData("text/herdr-pane-tab");
  if (tab) return { kind: "tab", tabId: tab };
  return null;
}

// Panel subject: the drop creates the group. The dragged panel and
// the auto-join neighbor join; the previously visible panel hands the
// subject over (it is NOT a member).
function labelDropCreatesGroup(root) {
  const subject = visibleSubject(root);
  return !!(subject && subject.kind === "panel");
}

function createGroupFromDrop(dragged, axis, draggedFirst, opts) {
  const root = paneRootFor();
  const neighbor = autoJoinNeighborFor(dragged);
  if (!neighbor) return false;
  // Server owns the mint: the op response carries the authoritative
  // entry (new groupId, layout, visible) and panesServerOp adopts it.
  // The local pointer is written first so the adopt pass keeps it; the
  // failed-op fallback rewrites it before the local twin runs.
  const runLocal = () => {
    root.visible = { type: "panel", id: dragged.paneId };
    return localCreateGroupFromDrop(dragged, neighbor, axis, draggedFirst);
  };
  if (panesMode === "server") {
    root.visible = { type: "group", id: "__pending__" };
    return panesOpWithFallback(
      {
        op: "group.create",
        paneId: dragged.paneId,
        neighborPaneId: neighbor.paneId,
        axis,
        draggedFirst,
      },
      runLocal,
      opts,
    );
  }
  return runLocal();
}

function localCreateGroupFromDrop(dragged, neighbor, axis, draggedFirst) {
  const root = paneRootFor();
  const group = {
    groupId: newGroupId(),
    name: null,
    memberIds: [dragged.paneId, neighbor.paneId],
    layout: null,
    // Fresh split opens focused on the dragged panel (parity with
    // the server op, which seeds the same memory).
    focusedPaneId: dragged.paneId,
  };
  // The dragged panel sits at the release quadrant; the neighbor
  // fills the other half.
  group.layout = { kind: axis, sizes: [1, 1], children: draggedFirst ? [dragged.paneId, neighbor.paneId] : [neighbor.paneId, dragged.paneId] };
  root.groups.push(group);
  dragged.groupId = group.groupId;
  neighbor.groupId = group.groupId;
  setVisibleSubject("group", group.groupId);
  focusLeaf(root, dragged);
  return true;
}

// Group subject: the dragged ungrouped panel joins the visible group
// at the previewed quadrant inside the layout.
function growVisibleGroupWith(dragged, axis, draggedFirst, opts) {
  const root = paneRootFor();
  const subject = visibleSubject(root);
  if (!subject || subject.kind !== "group" || dragged.groupId) return false;
  const group = subject.group;
  return panesOpWithFallback(
    {
      op: "group.grow",
      groupId: group.groupId,
      paneId: dragged.paneId,
      axis,
      draggedFirst,
      hostPaneId: dropHostPaneId || undefined,
    },
    () => localGrowVisibleGroupWith(dragged, group, axis, draggedFirst),
    opts,
  );
}

function localGrowVisibleGroupWith(dragged, group, axis, draggedFirst) {
  const root = paneRootFor();
  group.memberIds.push(dragged.paneId);
  dragged.groupId = group.groupId;
  group.layout = layoutWithPanelAt(group.layout, dragged.paneId, axis, draggedFirst);
  focusLeaf(root, dragged);
  return true;
}

