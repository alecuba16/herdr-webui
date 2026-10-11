// Right sidebar host (Phase 2). Owns the #rightSidebarContent column: the
// rail's Files button hosts the file browser side there, Git hosts the git
// status side, Search hosts the embedded search panel, terminal clears the
// column. Drawer panels keep their own nodes (#fileBrowserPanel,
// #gitUiPanel, #searchPanel); this module only moves them and the drawers
// render their side column only when hosted.
// State model: the collapse flag is global (mirrors the left sidebar
// strip toggle), the view mode is the per-workspace shell mode that
// workspace_shell.js already persists.

const RIGHT_SIDEBAR_PANES = { files: "fileBrowserPanel", git: "gitUiPanel", search: "searchPanel" };

function rightSidebarHostNode() {
  return el("rightSidebarContent");
}

function rightSidebarModeFor(workspaceId = state.ws) {
  const mode = currentWorkspaceShellMode(workspaceId);
  return mode === "files" || mode === "git" || mode === "search" ? mode : "terminal";
}

function rightSidebarVisibleFor(workspaceId = state.ws) {
  return rightSidebarModeFor(workspaceId) !== "terminal" && !isRightSidebarCollapsed();
}

function isRightSidebarCollapsed() {
  return window.__herdrRightSidebarCollapsed === true;
}

function setRightSidebarCollapsed(value) {
  // Delegate to the core.js flag setter (same concatenated script): it owns
  // the localStorage flag and the #app class; this module then re-applies
  // rail/terminal visibility.
  if (typeof setRightSidebarCollapsedFlag === "function") {
    setRightSidebarCollapsedFlag(value);
  } else {
    window.__herdrRightSidebarCollapsed = !!value;
  }
  applyRightSidebarHost();
}

// Moves a drawer panel into the content column. Accepts the panel element
// (drawers create the node on first open, before it is findable by id) or
// an id string. Returns true when the desktop host owns the panel now;
// false means the drawer must keep its legacy center-area surface (vm test
// harnesses boot without this module).
function rightSidebarHostPanel(panel) {
  const host = rightSidebarHostNode();
  const node = typeof panel === "string" ? document.getElementById(panel) : panel;
  if (!host || !node) return false;
  if (node.parentNode !== host) host.appendChild(node);
  // The legacy center surface sets display:inline (grid/flex); hosted, the
  // .right-sidebar-content > rules own it, so drop the inline override.
  node.style.display = "";
  return true;
}

// Applies mode + collapse to the DOM: which rail button reads active, and
// whether the content column is in the grid at all. The center pane keeps
// the terminal visible while a drawer column is open (m1/m2 contract):
// hiding the terminal was the old drawer swap behavior, so drawers skip
// their own terminalShell writes whenever this module is loaded.
function applyRightSidebarHost() {
  const collapsed = isRightSidebarCollapsed();
  const host = rightSidebarHostNode();
  let visibleChildren = [];
  if (host && host.childNodes && typeof host.childNodes.length === "number") {
    visibleChildren = Array.from(host.childNodes).filter(
      (node) => node.nodeType === 1 && (!node.style || node.style.display !== "none"),
    );
  }
  const visible = rightSidebarVisibleFor() && visibleChildren.length > 0;
  if (host) host.hidden = !visible;
  if (typeof syncRightSidebarRail === "function") syncRightSidebarRail();
  // The workspace pane tree owns #terminalShell's visibility while a
  // non-terminal tab (editor, git) is active (Phase 3b/3c); do not force
  // it back into view here.
  const shell = el("terminalShell");
  if (shell && !(window.HerdrWorkspacePanes && window.HerdrWorkspacePanes.nonTerminalTabActive
    && window.HerdrWorkspacePanes.nonTerminalTabActive())) shell.style.display = "";
  if (!collapsed && visible && typeof globalThis.HerdrScheduleTerminalResize === "function")
    globalThis.HerdrScheduleTerminalResize();
}

// Called by the drawers after each render: keeps the column visibility in
// sync (empty column must not hold grid space) without a full shell render.
function rightSidebarAfterDrawerRender() {
  applyRightSidebarHost();
}

// Opens a hosted view. ensurePanel is a drawer callback that returns its
// panel element (creating it on first open); the host moves it into the
// column and remembers the shell mode. Returns "hosted" when this module
// took the panel, "legacy" when the drawer must render its full surface
// (temp overlays claim panels through their suppression flag; they must not
// touch the workspace mode). The collapse flag is global and stays
// untouched here: callers decide whether a rail click expands the column
// (render.js wrappers) or a workspace switch preserves it (forceOpen).
async function openRightSidebarView(mode, workspaceId = state.ws, ensurePanel) {
  if (mode !== "files" && mode !== "git" && mode !== "search") return "terminal";
  if (typeof ensurePanel !== "function") return "legacy";
  const panel = ensurePanel();
  if (!panel) return "legacy";
  if (!rightSidebarHostPanel(panel)) return "legacy";
  rememberWorkspaceShellMode(mode, workspaceId);
  applyRightSidebarHost();
  return "hosted";
}

// Phase 3c: center pane tabs own the git main views, and the drawers
// stay hosted in the sidebar column for good.
window.HerdrRightSidebar = {
  hostPanel: rightSidebarHostPanel,
  isHosted(panelId) {
    const host = rightSidebarHostNode();
    const panel = document.getElementById(panelId);
    return !!(host && panel && panel.parentNode === host);
  },
  mode: rightSidebarModeFor,
  visible: rightSidebarVisibleFor,
  collapsed: isRightSidebarCollapsed,
  setCollapsed: setRightSidebarCollapsed,
  openView: openRightSidebarView,
  afterDrawerRender: rightSidebarAfterDrawerRender,
  apply: applyRightSidebarHost,
};