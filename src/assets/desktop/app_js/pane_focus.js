// Per-pane focus tracking for the desktop shell. The pane tree keeps an
// active pointer (root.activePaneId) that split/close/move commands read,
// but nothing moved it when the user clicked inside a pane: the pointer
// only followed strip tab clicks and commands, so keyboard split commands
// could act on a pane the user had just clicked away from, and no visual
// state distinguished the active pane.
//
// This module owns exactly that concern (the pane module stays layout +
// tab identity):
// - click-to-focus: capture-phase pointerdown on #workspacePanes resolves
//   the enclosing .workspace-pane and moves the tree's active pointer.
//   Capture phase, container level: the wterm canvas and CodeMirror both
//   consume events, so a bubble-phase listener on the pane element would
//   never see clicks inside terminal or editor content. Capture on the
//   persistent container sees every descendant before the consumers run.
// - focus ring: the .is-active class mirrors the active pointer onto each
//   leaf element every pane render. Empty leaves get the ring too: the
//   ring is the keyboard anchor for split commands, an empty pane is
//   still a focusable target.
// - activation contract: focus moves the pointer and persists it, but
//   never re-renders by itself (the caller's render pass picks the class
//   up), never touches the route (workspace/tab selection stays where it
//   is), and never steals DOM focus from inputs (clicking a rename field
//   or the terminal keeps the browser focus where the click put it).

(function () {
  let wired = false;

  function container() {
    return (typeof el === "function" && el("workspacePanes")) || null;
  }

  function paneElementForEvent(target) {
    let node = target;
    while (node) {
      const classes = String(node.className || "").split(/\s+/);
      if (classes.indexOf("workspace-pane") >= 0) return node;
      node = node.parentNode;
    }
    return null;
  }

  // Extract paneId without attribute selectors: the node-test DOM stubs
  // only support #id and .class queries, and this file must behave the
  // same under them.
  function paneIdOf(element) {
    return (element && element.dataset && element.dataset.paneId) || null;
  }

  function activatePane(paneId) {
    if (!paneId || typeof window.HerdrWorkspacePanes !== "object") return false;
    const root = window.HerdrWorkspacePanes.paneRootFor && window.HerdrWorkspacePanes.paneRootFor();
    if (!root) return false;
    const leaves = (window.HerdrWorkspacePanes.paneLeaves && window.HerdrWorkspacePanes.paneLeaves(root)) || [];
    if (!leaves.some((leaf) => leaf.paneId === paneId)) return false;
    root.activePaneId = paneId;
    // Group focus memory: the record carries the last member clicked
    // inside the split, so a subject switch away and back reopens on
    // the same member. activePaneId alone cannot hold it: every rail
    // chip press overwrites that pointer.
    if (window.HerdrWorkspacePanes.rememberGroupFocus)
      window.HerdrWorkspacePanes.rememberGroupFocus(root, paneId);
    if (window.HerdrWorkspacePanes.saveWorkspacePanesStates) window.HerdrWorkspacePanes.saveWorkspacePanesStates();
    // Collector model (design: the location bar always mirrors the
    // focused panel): clicking into a panel writes the route from that
    // panel through the pane module's shared helper. go() owns the
    // refresh; this module still never re-renders by itself.
    const leaf = leaves.find((candidate) => candidate.paneId === paneId);
    if (window.HerdrWorkspacePanes.writeRouteFromLeaf)
      window.HerdrWorkspacePanes.writeRouteFromLeaf(leaf);
    return true;
  }

  function onPointerDown(event) {
    if (!event || event.button !== 0) return;
    const pane = paneElementForEvent(event.target);
    if (!pane || pane === event.__herdrFocusedPane) return;
    const paneId = paneIdOf(pane);
    if (activatePane(paneId)) {
      // Ring the pane immediately instead of waiting for the next render
      // pass: a poll render can land much later, and the click must feel
      // instant. Full re-renders overwrite this from the tree pointer, so
      // the manual pass cannot drift.
      applyFocusClasses();
    }
  }

  // Mirror root.activePaneId onto the leaf elements. Called after every
  // pane render (the tree pointer is the single source of truth) and
  // once on click for the instant response.
  function applyFocusClasses() {
    const root = window.HerdrWorkspacePanes && window.HerdrWorkspacePanes.paneRootFor
      ? window.HerdrWorkspacePanes.paneRootFor()
      : null;
    if (!root || !root.activePaneId) return;
    const home = container();
    if (!home) return;
    walkPanes(home, (pane) => {
      const active = paneIdOf(pane) === root.activePaneId;
      if (pane.classList && typeof pane.classList.add === "function") {
        if (active) pane.classList.add("is-active");
        else pane.classList.remove("is-active");
      } else {
        // Node-test stubs without classList: string rewrite.
        const tokens = String(pane.className || "").split(/\s+/).filter(Boolean);
        const without = tokens.filter((token) => token !== "is-active");
        if (active) without.push("is-active");
        pane.className = without.join(" ");
      }
    });
  }

  function walkPanes(node, visit) {
    for (const child of node.children || []) {
      const classes = String(child.className || "").split(/\s+/);
      if (classes.indexOf("workspace-pane") >= 0) {
        visit(child);
      }
      walkPanes(child, visit);
    }
  }

  // Idempotent: the container is a persistent node, module reloads and
  // repeated calls must not stack listeners.
  function wire() {
    const home = container();
    if (!home || !home.addEventListener) return;
    if (wired) return;
    wired = true;
    home.addEventListener("pointerdown", onPointerDown, true);
    home.addEventListener("mousedown", onPointerDown, true);
  }

  window.HerdrPaneFocus = {
    wire,
    applyFocusClasses,
    activatePane,
  };
})();