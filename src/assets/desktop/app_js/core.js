let state = {
  session: "default",
  sessions: [],
  workspaces: [],
  worktrees: [],
  workspaceBranches: {},
  workspaceOrder: [],
  dragWorkspace: null,
  tabs: [],
  allTabs: [],
  panes: [],
  agents: [],
  ws: null,
  tab: null,
  pane: null,
  terminalId: null,
  termCols: null,
  termRows: null,
  fitDefault: false,
  editingTab: null,
  editingTabValue: "",
  panelMenuOpen: false,
  editingWorkspace: null,
  editingWorkspaceValue: "",
  workspaceCreateSuggestedLabel: "",
  createWorktreeOriginalSource: "",
  createWorktreeSource: null,
  createWorktreeAutodiscoverTimer: null,
  createWorktreeDefaultPath: "",
  openWorktreeSuggestionLocked: false,
  openWorktreeIncludeRemoteBranches: false,
  // Per-tab layout snapshots keyed by `${workspace_id}/${tab_id}`. Populated
  // from session.snapshot and kept current by layout.updated events. Used to
  // size the terminal without a per-pane pane.layout round trip.
  layouts: {},
  // True when the backend supports session.snapshot (protocol 16+). Set after
  // the first successful snapshot; falls back to legacy polling when false.
  supportsSessionSnapshot: false,
  backendMode: "builtin",
  sessionBackend: localStorage.getItem("herdr-session-backend") || "builtin",
  defaultFolder: "",
};
let term,
  termWs,
  eventWs,
  terminalLinkProvider,
  hiddenTimer,
  refreshTimer,
  connectedTerminalId = null,
  connectedSize = "",
  termScrollBound = false,
  terminalViewportScrollElement = null,
  terminalTouchLastY = null,
  terminalWheelDeltaPixels = 0,
  terminalScrollbackOffsetEstimate = 0,
  audioCtx = null,
  audioUnlocked = false,
  knownAttention = null,
  lastAttentionSound = 0,
  creatingDefaultWorkspace = false,
  refreshSeq = 0,
  terminalFramePending = false,
  resizeFramePending = false,
  lastWorkspacesRenderSignature = "",
  lastWorkspacesRenderedHtml = "",
  lastWorkspacesHtml = "",
  lastAgentsHtml = "",
  lastTabsHtml = "",
  tabActivity = {},
  closeChordUntil = 0,
  inputQueue = [],
  terminalQueryReplyState = {},
  inputQueueMaxBufferedAmount = 65536,
  inputFlushTimer = null,
  pasteJob = null,
  pasteChunkTimer = null,
  pasteProgressHideTimer = null,
  terminalWriteQueue = [],
  terminalWriteFlushPending = false,
  pasteFrameUntil = 0,
  shortcutPrefixUntil = 0,
  shortcutPrefixTimer = null,
  searchFramePending = false,
  searchResults = [],
  searchSelectedIndex = 0,
  tempTerminal = null;
const SIDEBAR_COLLAPSED_KEY = "herdr-web-sidebar-collapsed";
const DEFAULT_GLOBAL_SHORTCUT_PREFIX = "Ctrl+B";
const DEFAULT_WEBUI_SHORTCUTS = {
  search: "Slash",
  help: "Shift+Slash",
  settings: "KeyS",
  sidebar: "KeyB",
  newWorkspace: "KeyN",
  newPanel: "KeyP",
  openWorktrees: "KeyW",
  createWorktree: "KeyT",
  closePanel: "KeyX",
  closeWorkspace: "Shift+KeyX",
  removeWorktree: "Delete",
  removeWorktreeAlt: "Backspace",
  nextAgent: "KeyA",
  prevAgent: "Shift+KeyA",
  nextWorkspace: "KeyJ",
  prevWorkspace: "KeyK",
  nextPanel: "BracketRight",
  prevPanel: "BracketLeft",
  focusTerminal: "KeyF",
  tempTerminalToggle: "Shift+KeyM",
  focusNext: "Period",
  focusPrev: "Comma",
};
const DEFAULT_GIT_SHORTCUTS = {
  changes: "Digit1",
  commit: "Digit2",
  log: "Digit3",
  stash: "Digit4",
  commitAlt: "KeyC",
  logAlt: "KeyL",
  refresh: "KeyR",
  stageAll: "KeyG",
  stageFile: "KeyY",
  unstageFile: "KeyU",
  discardFile: "KeyD",
  stashFile: "KeyZ",
  history: "KeyH",
  blame: "KeyM",
  edit: "KeyE",
  compare: "KeyO",
  branch: "KeyV",
  focusFile: "KeyI",
  help: "Digit0",
};
const FAST_REFRESH_EVENTS = new Set([
  "pane.closed",
  "pane.exited",
  "tab.closed",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
]);
let sidebarCollapsed = storedFlag(SIDEBAR_COLLAPSED_KEY);
let noSleepState = { mode: "off", until_ms: null, error: null, supported: true };
let noSleepPollTimer = null;
let noSleepRequestSeq = 0;
const inputEncoder = new TextEncoder();
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeOrder,
  normalizeThemeColors,
  resolveTerminalFontFamily,
  textValue,
  resolveWorktreeSource: resolveWorktreeSourceHelper,
  checkedOutWorktreeForBranch: checkedOutWorktreeForBranchHelper,
  worktreeActivityLabel,
  sortWorktreesByRecent,
  validateWorktreeCreate: validateWorktreeCreateHelper,
  buildWorktreeCreateBody,
  createFaviconNotifier,
  terminalPasteInput,
  tabActivityLabel,
} = globalThis.HerdrAppHelpers;
const browserFavicon = createFaviconNotifier(document);
let browserFaviconError = false;
const workspaces = el("workspaces"),
  agents = el("agents"),
  tabs = el("tabs");
applySidebarCollapsed();
const sidebarToggle = el("sidebarToggle");
if (sidebarToggle)
  sidebarToggle.onclick = () => {
    sidebarCollapsed = !sidebarCollapsed;
    storeFlag(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed);
    applySidebarCollapsed();
    syncShortcutTooltips();
    scheduleTerminalFit();
  };
function storedFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch (_) {
    return false;
  }
}
function storeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch (_) {}
}
function applySidebarCollapsed() {
  const app = el("app"),
    button = el("sidebarToggle");
  if (app) app.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  if (button) {
    button.innerHTML = sidebarToggleHtml();
    button.title = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
    button.setAttribute("aria-label", button.title);
  }
}
function sidebarAgentStatusCounts() {
  const counts = { blocked: 0, working: 0, idle: 0, done: 0 };
  for (const agent of state.agents || []) {
    const status = isWorkingDismissed(agent) ? "idle" : statusClass(agent.agent_status);
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  return counts;
}
function sidebarToggleHtml() {
  const arrow = `<span class="sidebar-toggle-arrow">${sidebarCollapsed ? "›" : "‹"}</span>`;
  if (!sidebarCollapsed) return arrow;
  const counts = sidebarAgentStatusCounts();
  const badges = [
    ["blocked", counts.blocked],
    ["working", counts.working],
    ["idle", counts.idle],
    ["done", counts.done],
  ]
    .filter(([, count]) => count > 0)
    .map(
      ([status, count]) =>
        `<span class="sidebar-count ${status}" title="${count} ${status} agent${count === 1 ? "" : "s"}">${count}</span>`,
    )
    .join("");
  return arrow + (badges ? `<span class="sidebar-counts">${badges}</span>` : "");
}
function appIcon(name) {
  const iconName = String(name || "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `<span class="app-icon app-icon-${iconName}" aria-hidden="true"></span>`;
}
function shellMode() {
  if (window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible()) return "git";
  if (window.HerdrFileBrowser && window.HerdrFileBrowser.isVisible && window.HerdrFileBrowser.isVisible()) return "files";
  return "terminal";
}
function syncShellModeButtons() {
  const mode = shellMode();
  for (const [id, value] of [
    ["terminalWorkspaceToggle", "terminal"],
    ["gitWorkspaceToggle", "git"],
    ["fileWorkspaceToggle", "files"],
  ]) {
    const button = el(id);
    if (!button) continue;
    const active = mode === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
}
window.syncShellModeButtons = syncShellModeButtons;
function workspacePath(workspace) {
  if (!workspace) return "";
  if (workspace.worktree && workspace.worktree.checkout_path)
    return workspace.worktree.checkout_path;
  if (workspace.cwd) return workspace.cwd;
  if (workspace.path) return workspace.path;
  const pane = (state.panes || []).find(
    (p) => p.workspace_id === workspace.workspace_id,
  );
  return (pane && (pane.foreground_cwd || pane.cwd)) || "";
}
function defaultFolderPath() {
  return state.defaultFolder || "";
}
function defaultFolderWorkspace() {
  const cwd = defaultFolderPath();
  if (!cwd) return null;
  return { workspace_id: "__default_folder__", label: "Default folder", cwd, default_folder: true };
}
function selectedOrDefaultWorkspace(id = state.ws) {
  return state.workspaces.find((w) => w.workspace_id === id) || defaultFolderWorkspace();
}
window.HerdrWorkspacePath = workspacePath;
function appRefreshIconButton({ className = "", title = "Refresh", label = "Refresh", spinning = false, onclick = "" } = {}) {
  const classes = ["app-refresh-icon", className, spinning ? "spinning" : ""]
    .filter(Boolean)
    .join(" ");
  const clickAttr = onclick ? ` onclick="${escapeAttr(onclick)}"` : "";
  return `<button class="${escapeAttr(classes)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(label)}"${clickAttr}><span></span></button>`;
}
function showTerminalShellMode() {
  if (window.HerdrGitUi) window.HerdrGitUi.hide();
  if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
  const shell = el("terminalShell");
  if (shell) shell.style.display = "";
  syncShellModeButtons();
  if (typeof render === "function") render();
  if (state.terminalId && !term && typeof Terminal !== "undefined") connectTerminal();
  fitTerminalShell();
  if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  if (typeof requestAnimationFrame === "function")
    requestAnimationFrame(() => {
      syncShellModeButtons();
      fitTerminalShell();
      if (typeof fitTerminalSurface === "function") fitTerminalSurface();
    });
}
const headTitle = document.querySelector(".head strong");
if (headTitle) {
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.innerHTML =
    '<img src="/favicon.svg" alt=""><div class="brand-text"><span class="brand-title">Herdr</span><span class="brand-subtitle">WebUI</span></div>';
  headTitle.replaceWith(brand);
}
const sectionEl = document.querySelector(".side .section");
if (sectionEl && !el("workspacePane")) {
  const versionsEl = el("versions"),
    workspacesEl = el("workspaces"),
    agentsEl = el("agents"),
    oldAgentsHeader = document.querySelector(".section-header");
  const split = document.createElement("div");
  split.className = "sidebar-split";
  const workspacePane = document.createElement("div");
  workspacePane.id = "workspacePane";
  workspacePane.className = "sidebar-pane workspaces-pane";
  workspacePane.insertAdjacentHTML(
    "beforeend",
    '<div class="section-header">Workspaces</div><div class="workspace-context-actions" id="workspaceContextActions"></div>',
  );
  const workspaceScroll = document.createElement("div");
  workspaceScroll.className = "sidebar-scroll";
  workspaceScroll.appendChild(workspacesEl);
  workspacePane.appendChild(workspaceScroll);
  const agentsPane = document.createElement("div");
  agentsPane.className = "sidebar-pane agents-pane";
  agentsPane.innerHTML = '<div class="section-header">Agents</div>';
  const agentsScroll = document.createElement("div");
  agentsScroll.className = "sidebar-scroll";
  agentsScroll.appendChild(agentsEl);
  agentsPane.appendChild(agentsScroll);
  if (oldAgentsHeader) oldAgentsHeader.remove();
  const resizeHandle = document.createElement("div");
  resizeHandle.id = "sidebarSplitHandle";
  resizeHandle.className = "sidebar-split-handle";
  resizeHandle.title = "Drag to resize workspace and agents panels";
  resizeHandle.setAttribute("role", "separator");
  resizeHandle.setAttribute("aria-orientation", "horizontal");
  resizeHandle.tabIndex = 0;
  split.appendChild(workspacePane);
  split.appendChild(resizeHandle);
  split.appendChild(agentsPane);
  sectionEl.appendChild(split);
  if (versionsEl) {
    versionsEl.classList.add("side-footer");
    document.querySelector(".side").appendChild(versionsEl);
  }
}
insertMissingHtml("worktreeCreateModal", worktreeCreateModalHtml());
insertMissingHtml("worktreeOpenModal", worktreeOpenModalHtml());
insertMissingHtml("workspaceCreateModal", workspaceCreateModalHtml());
insertMissingHtml("shortcutsModal", shortcutsModalHtml());
insertMissingHtml("questionModal", questionModalHtml());
const settingsModal = el("settingsModal");
if (settingsModal && !settingsModal.dataset.ux) {
  const modal = settingsModal.querySelector(".modal");
  const heading = modal && modal.querySelector("h2");
  if (modal && heading) {
    const head = document.createElement("div");
    head.className = "settings-head";
    head.innerHTML =
      '<div><h2>Settings</h2><p>Browser-local preferences for terminal, theme, and agent behavior.</p></div><label class="settings-search"><span>Search settings</span><input id="settingsSearch" type="search" placeholder="Search theme, terminal, Git..." autocomplete="off"></label><button class="mini settings-close" id="settingsCloseTop" title="Close">✕</button>';
    heading.replaceWith(head);
    const body = document.createElement("div");
    body.className = "settings-body";
    [...modal.querySelectorAll("label.option")].forEach((node) =>
      body.appendChild(node),
    );
    modal.insertBefore(body, modal.querySelector(".modal-actions"));
    el("settingsCloseTop").onclick = () => {
      settingsModal.style.display = "none";
    };
  }
  settingsModal.dataset.ux = "1";
}
function insertMissingHtml(id, html) {
  if (!el(id)) document.body.insertAdjacentHTML("beforeend", html);
}
function questionModalHtml() {
  return `
    <div class="modal-backdrop question-modal" id="questionModal">
      <div class="modal question-modal-card">
        <div class="settings-head">
          <div>
            <h2 id="questionTitle">Confirm action</h2>
            <p id="questionMessage"></p>
          </div>
          <button class="mini settings-close" id="questionClose" title="Cancel">✕</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="tab add" id="questionCancel">Cancel</button>
          <button type="button" class="btn question-confirm" id="questionConfirm">Confirm</button>
        </div>
      </div>
    </div>`;
}
function worktreeCreateModalHtml() {
  return `
    <div class="modal-backdrop" id="worktreeCreateModal">
      <div class="modal">
        <div class="settings-head">
          <div>
            <h2>Create worktree</h2>
            <p>Creates a linked Git worktree from the selected parent workspace and opens it.</p>
          </div>
          <button class="mini settings-close" id="worktreeCreateClose" title="Close">✕</button>
        </div>
        <div class="worktree-open-controls">
          <label>
            <span>Source repo path</span>
            <input id="worktreeCreateSource" placeholder="parent workspace path" autocomplete="off">
          </label>
          <div class="worktree-loading" id="worktreeCreateLoading">Discovering worktrees...</div>
        </div>
        <div class="worktree-new">
          <div class="worktree-new-head">
            <strong>Create a new worktree</strong>
            <small>Uses the repo path above. Leave base blank to use the repo default branch.</small>
          </div>
          <form class="worktree-form" id="worktreeCreateForm">
            <div class="worktree-grid">
              <label><span>Branch name</span><input id="worktreeBranch" placeholder="feature/my-branch"></label>
              <label><span>Base branch</span><input id="worktreeBase" placeholder="default branch"></label>
            </div>
            <div class="worktree-grid">
              <label><span>Label</span><input id="worktreeLabel" placeholder="optional"></label>
              <label><span>Checkout path</span><input id="worktreePath" placeholder="backend default if blank"></label>
            </div>
            <label class="option"><input type="checkbox" id="worktreePullBase"><span>Pull base branch before create<small>Runs a fast-forward Git update in the source repo first.</small></span></label>
            <div class="worktree-error" id="worktreeCreateError"></div>
            <div class="worktree-open-footer">
              <button type="button" class="tab add" id="worktreeCreateCancel">Cancel</button>
              <button type="submit" class="btn" id="worktreeCreateSubmit">Create and open</button>
            </div>
          </form>
        </div>
      </div>
    </div>`;
}
function worktreeOpenModalHtml() {
  return `
    <div class="modal-backdrop" id="worktreeOpenModal">
      <div class="modal">
        <div class="settings-head">
          <div>
            <h2>Open workspace or worktree</h2>
            <p>Pick a folder. Git repos show branches and worktrees; normal folders can be opened as workspaces.</p>
          </div>
          <button class="mini settings-close" id="worktreeOpenClose" title="Close">✕</button>
        </div>
        <div class="worktree-open-controls">
          <label>
            <span>Folder</span>
            <input id="worktreeDiscoverPath" placeholder="~/Documents/code/repo-or-worktrees">
          </label>
          <div class="worktree-loading" id="worktreeLoading">Discovering worktrees...</div>
        </div>
        <div class="worktree-open-list" id="worktreeOpenList"></div>
        <div class="worktree-new" id="worktreeNewSection">
          <div class="worktree-new-head">
            <strong id="worktreeNewTitle">Create worktree</strong>
            <small id="worktreeNewHint">Review branch name, base branch, and checkout path, then create and open.</small>
          </div>
          <form class="worktree-form" id="worktreeNewForm">
            <div class="worktree-grid">
              <label><span>Branch name</span><input id="worktreeNewBranch" placeholder="feature/my-branch"></label>
              <label><span>Base branch</span><span class="worktree-base-picker"><input id="worktreeNewBase" list="worktreeBranchOptions" placeholder="default branch"><button type="button" class="mini" id="worktreeFetchRemotes" title="Fetch remote branches and add them to this list">Fetch remotes</button></span></label>
              <datalist id="worktreeBranchOptions"></datalist>
            </div>
            <div class="worktree-grid">
              <label><span>Label</span><input id="worktreeNewLabel" placeholder="optional"></label>
              <label><span>Checkout path</span><input id="worktreeNewPath" placeholder="select base branch or enter branch name"></label>
            </div>
            <label class="option worktree-pull-option"><input type="checkbox" id="worktreeNewPullBase"><span><strong>Update base first</strong><small>Fast-forward only. If the branch diverged, you can continue without pulling.</small></span></label>
            <button class="btn" id="worktreeNewSubmit">Create and open</button>
          </form>
        </div>
        <div class="worktree-new" id="worktreeWorkspaceSection">
          <div class="worktree-new-head">
            <strong>Create workspace</strong>
            <small id="worktreeWorkspaceHint">Opens this folder directly and ignores Git worktrees.</small>
            <label class="worktree-workspace-name"><span>Workspace name</span><input id="worktreeWorkspaceLabel" placeholder="project name"></label>
          </div>
          <div class="worktree-form">
            <button type="button" class="btn" id="worktreeWorkspaceSubmit">Create workspace</button>
          </div>
        </div>
        <div class="worktree-error" id="worktreeOpenError"></div>
        <div class="worktree-open-footer">
          <button type="button" class="app-refresh-icon" id="worktreeOpenRefresh" title="Refresh" aria-label="Refresh worktrees"><span></span></button>
        </div>
      </div>
    </div>`;
}
function workspaceCreateModalHtml() {
  return `
    <div class="modal-backdrop" id="workspaceCreateModal">
      <div class="modal">
        <div class="settings-head">
          <div>
            <h2>New workspace</h2>
            <p>Pick an existing folder first, then confirm the workspace name.</p>
          </div>
          <button class="mini settings-close" id="workspaceCreateClose" title="Close">✕</button>
        </div>
        <form class="worktree-form" id="workspaceCreateForm">
          <label>
            <span>Folder</span>
            <input id="workspaceCreatePath" placeholder="~/Documents/code/project" required>
          </label>
          <label>
            <span>Workspace name</span>
            <input id="workspaceCreateLabel" placeholder="project name" required>
          </label>
          <div class="worktree-error" id="workspaceCreateError"></div>
          <div class="modal-actions">
            <button type="button" class="tab add" id="workspaceCreateCancel">Cancel</button>
            <button class="btn" id="workspaceCreateSubmit">Create workspace</button>
          </div>
        </form>
      </div>
    </div>`;
}
function shortcutsModalHtml() {
  return `
    <div class="modal-backdrop" id="shortcutsModal">
      <div class="modal">
        <div class="settings-head">
          <div>
            <h2>Help &amp; Shortcuts</h2>
            <p>Quick functionality map and browser/WebUI shortcuts. Terminal apps may handle their own keybindings inside the pane.</p>
          </div>
          <button class="mini settings-close" id="shortcutsCloseTop" title="Close">✕</button>
        </div>
        <section class="help-section">
          <h3>Functionality map</h3>
          <p class="settings-note">Main Herdr areas and what each control does.</p>
          <div class="help-grid">
            <div class="help-row"><strong>Sidebar</strong><span>Workspaces show open roots/worktrees; agents list status. Click to open; double-click names to rename. Drag the workspace/agents separator to resize by percent. Colored badges show blocked, done, working, and idle.</span></div>
            <div class="help-row"><strong>Header</strong><span>＋ opens/creates workspace; ? opens this help; gear opens Settings; moon/theme toggles color mode; sidebar chevron hides/shows navigation.</span></div>
            <div class="help-row"><strong>Panels/Tabs</strong><span>Top panel switcher changes terminal panel; + creates panel; ✕ closes current panel; double-click panel label to rename.</span></div>
            <div class="help-row"><strong>Terminal</strong><span>Wheel, touch, and PageUp/PageDown scroll the Herdr backend when available; built-in backend uses xterm local scroll. Tail appears after scrolling up and jumps back to latest output. Temporary terminal captures Tab/Backspace and normal input while open; Ctrl+G detaches it through the close confirmation; ${escapeHtml(globalShortcutPrefixLabel())} then Shift+M opens, minimizes, or restores it. Scroll speed is configurable in Settings → Terminal.</span></div>
            <div class="help-row"><strong>Files</strong><span>Files selector opens browser/editor; the current folder row has an Up button; file rows use license-safe type glyphs while folders stay plain except for Git status colors. Header search (⌕, or prefix then /) is the single search entry point for workspaces/worktrees, file names, folder names, and file contents. File/folder and content search run in the backend for the focused workspace/worktree, lazy-load pages, preserve parent folders for path context, and use Settings to enable sections and sort their order. Content results show as grouped files with highlighted match text, match-case and regex options, colored matched-line context, configurable default expanded/collapsed file groups, per-file disclosure arrows, Git-style arrow controls for more context above/below with overlap merging, lazy per-file loading, opening at the matched line with editor highlight, and full-file open. Text previews use the same CodeMirror editor surface as edit mode but stay read-only until Edit is pressed; Show history opens Git log scoped to the selected file; line numbers show by default, fold controls work for supported languages, editor find supports match case and regex, edit mode enables replace, and syntax/search colors use shared theme tokens. Search selections, selected files, split panes, and unsaved edit drafts stay attached to each open workspace/worktree while switching panels; closing the workspace/worktree forgets them. Git colors are computed server-side and propagate up directories with priority red deleted, yellow modified, green new.</span></div>
            <div class="help-row"><strong>Git</strong><span>Git selector opens repo tools for diff, stage/unstage, discard, commit modal, commit & push, pull, push with force fallback, tag push option, rebase, conflicts, stash, branches, cleanup, and worktree prune. Choosing a folder in the Git directory picker immediately moves the Git panel to that folder and refreshes it; the branch modal's Switch branch button only checks out another branch in the selected Git directory. When the Git panel folder differs from the current workspace/worktree folder, the ↩ button beside Refresh returns Git to the current workspace/worktree folder and refreshes. Changes, log, stash, and cleanup use one exclusive segmented toggle; the file filter sits below the action toolbar; cleanup uses the shared broom icon. Git log has sticky scope and column headers while scrolling; selected commits show compact actions for Compare, Tag, Worktree…, Reset, Rebase…, and Clear. Selecting one commit shows a Committed files side preview; choosing a file opens the commit-vs-parent diff.</span></div>
            <div class="help-row"><strong>Worktrees</strong><span>Use the header ＋ button to open/create workspaces and linked worktrees. WebUI no longer opens a workspace automatically on startup; file browser, Git, temporary terminals, and workspace/worktree pickers start from the configured default folder when no workspace is selected. Selected workspace rows keep only close/remove actions so the sidebar stays simple.</span></div>
            <div class="help-row"><strong>Search</strong><span>Prefix then / or the header magnifier opens one palette for workspaces, repos, worktrees, labels, agents, panels, file/folder results, and file-content matches. In search, arrows move, Enter opens, Esc closes, Alt+F selects files, Alt+D selects folders, Alt+1/2/3 toggles sections, and Alt+↑/↓ expands content context for the selected match. Content search can be match-case or regex from Settings. Editor find uses Enter/Shift+Enter for next/previous and enables replace controls only in edit mode.</span></div>
            <div class="help-row"><strong>Settings</strong><span>Configure shortcuts, terminal font/links/scroll speed, themes, file browser, Git UI, worktree defaults, agent group order, sidebar split percent, and notification/no-sleep behavior.</span></div>
          </div>
        </section>
        <div id="shortcutEditor"></div>
        <h3 class="shortcut-section-title">Keyboard shortcuts</h3>
        <div class="shortcuts-list">
          <div class="shortcut-row"><kbd id="closeShortcutCurrent">Disabled</kbd><span>Close current Herdr panel. Configure in Settings.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())}</kbd><span>Open WebUI shortcut prefix overlay. Next shortcut key is handled by WebUI and not sent to terminal. Esc cancels.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then /</kbd><span>Open unified header search for workspaces, repos, agents, panels, files, folders, and file-content matches. Use Alt+F/Alt+D inside the palette to switch file or folder search, Alt+1/2/3 to collapse or expand search sections, and Alt+↑/↓ to expand selected content-match context. In editor find, Enter moves next and Shift+Enter moves previous.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then ?</kbd><span>Open this help and shortcuts reference.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then S</kbd><span>Open Settings.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then B</kbd><span>Show or hide the workspace/agents sidebar.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then N</kbd><span>Open or create workspace.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then P</kbd><span>Create panel in current workspace.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then W</kbd><span>Open workspace/worktrees browser. Without an open workspace, it starts from the configured default folder.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then T</kbd><span>Create worktree from current workspace.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then X</kbd><span>Close current panel.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then Shift+X</kbd><span>Close current workspace or linked worktree.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then Delete/Backspace</kbd><span>Remove current linked worktree from disk.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then A</kbd><span>Jump agents by status priority: blocked, done, idle, working.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then Shift+A</kbd><span>Jump agents in reverse priority order.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then J / K</kbd><span>Jump to next or previous workspace.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then ] / [</kbd><span>Jump to next or previous panel.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then F</kbd><span>Focus terminal.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then Shift+M</kbd><span>Open, minimize, or restore the temporary terminal.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then V</kbd><span>In Git UI, open Git directory/branch dialog. Folder selection changes the Git panel cwd; Switch branch only changes branch in that cwd.</span></div>
          <div class="shortcut-row"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then . / ,</kbd><span>Focus next or previous visible UI control.</span></div>
          <div class="shortcut-row"><kbd>Ctrl+G</kbd><span>Detach temporary terminal when its overlay is open. The close button uses the same confirmation.</span></div>
          <div class="shortcut-row"><kbd>Shift+Enter</kbd><span>Send configured newline sequence to terminal.</span></div>
          <div class="shortcut-row"><kbd>PageUp/PageDown</kbd><span>Scroll Herdr terminal backend.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Ctrl+C</kbd><span>Copy selected terminal text.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Ctrl+V</kbd><span>Paste clipboard into terminal.</span></div>
          <div class="shortcut-row"><kbd>Double-click</kbd><span>Rename workspaces and panels.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Middle-click</kbd><span>Open workspace, agent, or panel link using browser tab behavior.</span></div>
        </div>
        <div class="modal-actions"><button class="btn" id="shortcutsClose">Close</button></div>
      </div>
    </div>`;
}

const shortcutEditorGroups = [
  {
    scope: "webuiShortcuts",
    title: "WebUI Prefix Shortcuts",
    items: [
      ["search", "Search palette"],
      ["help", "Shortcut window"],
      ["settings", "Settings"],
      ["sidebar", "Toggle sidebar"],
      ["newWorkspace", "Open/create workspace"],
      ["newPanel", "New panel"],
      ["openWorktrees", "Open workspace/worktrees"],
      ["createWorktree", "Create worktree"],
      ["closePanel", "Close panel"],
      ["closeWorkspace", "Close workspace/worktree"],
      ["removeWorktree", "Remove linked worktree"],
      ["removeWorktreeAlt", "Remove linked worktree alternate"],
      ["nextAgent", "Next agent"],
      ["prevAgent", "Previous agent"],
      ["nextWorkspace", "Next workspace"],
      ["prevWorkspace", "Previous workspace"],
      ["nextPanel", "Next panel"],
      ["prevPanel", "Previous panel"],
      ["focusTerminal", "Focus terminal"],
      ["tempTerminalToggle", "Open/minimize/restore temporary terminal"],
      ["focusNext", "Focus next control"],
      ["focusPrev", "Focus previous control"],
    ],
  },
  {
    scope: "gitShortcuts",
    title: "Git UI Prefix Shortcuts",
    items: [
      ["changes", "Changes list"],
      ["commit", "Commit"],
      ["log", "Log"],
      ["stash", "Stash"],
      ["commitAlt", "Commit alternate"],
      ["logAlt", "Log alternate"],
      ["refresh", "Refresh"],
      ["stageAll", "Stage/unstage all"],
      ["stageFile", "Stage file"],
      ["unstageFile", "Unstage file"],
      ["discardFile", "Discard file"],
      ["stashFile", "Stash file"],
      ["history", "File history"],
      ["blame", "Blame"],
      ["edit", "Edit file"],
      ["compare", "Current compare"],
      ["branch", "Branch switch"],
      ["focusFile", "Focus file list"],
      ["help", "Git shortcut help"],
    ],
  },
];

function defaultShortcutMap(scope) {
  return scope === "gitShortcuts" ? DEFAULT_GIT_SHORTCUTS : DEFAULT_WEBUI_SHORTCUTS;
}

function normalizeShortcutMap(value, defaults) {
  const next = { ...defaults };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(defaults)) {
      if (typeof value[key] === "string" && value[key].trim())
        next[key] = value[key].trim();
    }
  }
  return next;
}

function shortcutKeyFromEvent(e) {
  const base = e.code || e.key;
  if (!base || ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(base))
    return "";
  return `${e.shiftKey ? "Shift+" : ""}${base}`;
}

function shortcutDisplay(value) {
  return String(value || "")
    .replace(/(^|\+)Key/g, "$1")
    .replace(/(^|\+)Digit/g, "$1")
    .replace("BracketLeft", "[")
    .replace("BracketRight", "]")
    .replace("Slash", "/")
    .replace("Period", ".")
    .replace("Comma", ",")
    .replace("Shift+", "Shift+");
}

function shortcutMapFor(scope) {
  const source = typeof options !== "undefined" && options && options[scope];
  return source || defaultShortcutMap(scope);
}

function shortcutLabel(scope, action) {
  const key = shortcutMapFor(scope)[action];
  if (!key) return "";
  return `${globalShortcutPrefixLabel()} then ${shortcutDisplay(key)}`;
}

function titleWithShortcut(title, scope, action) {
  const label = shortcutLabel(scope, action);
  return label ? `${title} (${label})` : title;
}

function titleWithWebuiShortcut(title, action) {
  return titleWithShortcut(title, "webuiShortcuts", action);
}

function setShortcutTooltip(id, title, action) {
  const node = el(id);
  if (!node) return;
  const text = titleWithWebuiShortcut(title, action);
  node.title = text;
  node.setAttribute("aria-label", text);
}

function syncShortcutTooltips() {
  setShortcutTooltip("shortcutsToggle", "Shortcuts", "help");
  setShortcutTooltip("footerShortcutsButton", "Shortcuts", "help");
  setShortcutTooltip("settingsToggle", "Settings", "settings");
  setShortcutTooltip("footerSettingsButton", "Settings", "settings");
  setShortcutTooltip("headerActionsButton", "Search and actions", "search");
  setShortcutTooltip("sidebarToggle", sidebarCollapsed ? "Show sidebar" : "Hide sidebar", "sidebar");
  setShortcutTooltip("terminalWorkspaceToggle", "Show terminal", "focusTerminal");
  const searchClose = el("searchPaletteClose");
  if (searchClose) searchClose.title = "Close (Esc)";
  const tempClose = el("tempTerminalClose");
  if (tempClose) {
    tempClose.title = "Detach temporary terminal (Ctrl+G)";
    tempClose.setAttribute("aria-label", tempClose.title);
  }
  setShortcutTooltip("tempTerminalMinimize", "Minimize temporary terminal", "tempTerminalToggle");
  const tempRestore = document.querySelector && document.querySelector(".temp-terminal-restore");
  if (tempRestore) {
    const text = titleWithWebuiShortcut("Show temporary terminal", "tempTerminalToggle");
    tempRestore.title = text;
    tempRestore.setAttribute("aria-label", text);
  }
}

function shortcutCollisionMap() {
  const byKey = {};
  for (const group of shortcutEditorGroups) {
    const map = options[group.scope] || defaultShortcutMap(group.scope);
    for (const [action, label] of group.items) {
      const key = map[action];
      if (!key) continue;
      (byKey[key] ||= []).push(`${group.title}: ${label}`);
    }
  }
  return byKey;
}

function shortcutCollisionFor(scope, action, key) {
  const collisions = [];
  for (const group of shortcutEditorGroups) {
    const map = options[group.scope] || defaultShortcutMap(group.scope);
    for (const [otherAction, label] of group.items) {
      if (group.scope === scope && otherAction === action) continue;
      if (map[otherAction] === key) collisions.push(`${group.title}: ${label}`);
    }
  }
  return collisions;
}

function renderShortcutEditor() {
  const target = el("shortcutEditor");
  if (!target) return;
  const collisions = shortcutCollisionMap();
  target.innerHTML = `<div class="settings-section"><h3>Shortcut Editor</h3><p class="settings-note">All entries below use the configured prefix (${escapeHtml(globalShortcutPrefixLabel())}) first. Recording a duplicate is blocked.</p>${shortcutEditorGroups.map((group) => {
    const map = options[group.scope] || defaultShortcutMap(group.scope);
    return `<h4>${escapeHtml(group.title)}</h4><div class="shortcuts-list">${group.items.map(([action, label]) => {
      const key = map[action];
      const duplicate = (collisions[key] || []).length > 1;
      return `<div class="shortcut-row ${duplicate ? "conflict" : ""}"><kbd>${escapeHtml(globalShortcutPrefixLabel())} then ${escapeHtml(shortcutDisplay(key))}</kbd><span>${escapeHtml(label)}${duplicate ? `<small>Conflict: ${escapeHtml((collisions[key] || []).join("; "))}</small>` : ""}</span><button class="mini" data-shortcut-record="${group.scope}:${action}">Record</button><button class="mini" data-shortcut-reset="${group.scope}:${action}">Reset</button></div>`;
    }).join("")}</div>`;
  }).join("")}</div>`;
}

function recordShortcut(scope, action, button) {
  if (button) button.textContent = "Press key...";
  const capture = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const key = shortcutKeyFromEvent(e);
    if (!key) return renderShortcutEditor();
    const conflicts = shortcutCollisionFor(scope, action, key);
    if (conflicts.length) {
      alert(`Shortcut conflict with: ${conflicts.join(", ")}`);
      return renderShortcutEditor();
    }
    options[scope] = { ...(options[scope] || defaultShortcutMap(scope)), [action]: key };
    saveOptions();
    applyOptions();
    renderShortcutEditor();
  };
  window.addEventListener("keydown", capture, { once: true, capture: true });
}

function resetShortcut(scope, action) {
  options[scope] = { ...(options[scope] || defaultShortcutMap(scope)), [action]: defaultShortcutMap(scope)[action] };
  saveOptions();
  applyOptions();
  renderShortcutEditor();
}
function themeCustomizerHtml() {
  const rows = (mode) =>
    themeColorFields
      .map(
        ([key, label]) =>
          `<label><span>${label}</span><input class="theme-color-input" type="color" data-theme-mode="${mode}" data-theme-key="${key}" id="${themeColorInputId(mode, key)}"></label>`,
      )
      .join("");
  return `<div class="theme-customizer"><div><strong>Theme colors</strong><small>Saved in this browser. Uses current defaults as reset reference.</small></div><div class="theme-customizer-actions"><label><span>Profile</span><select class="settings-select" id="themeColorProfile"><option value="default">Default</option><option value="catppuccin">Catppuccin</option><option value="tokyo">Tokyo Night</option><option value="nord">Nord</option></select></label><button type="button" class="tab add" id="themeColorsApplyProfile">Apply profile</button><button type="button" class="tab add" id="themeColorsApply">Apply / reload UI</button><button type="button" class="tab add" id="themeColorsReset">Reset theme colors</button></div><div class="theme-customizer-grid"><section><h3>Dark</h3>${rows("dark")}</section><section><h3>Light</h3>${rows("light")}</section></div></div>`;
}
function serverSettingsHtml() {
  return `<div class="server-settings"><section class="settings-section"><div class="settings-section-head"><h3>Network access</h3><p>Saved in ~/.config/herdr-webui/webui-settings.json. Changing Bind restarts the WebUI listener.</p></div><label class="option"><span>Bind address<small>Use 127.0.0.1:8787 for local only or 0.0.0.0:8787 for LAN/public access.</small></span><input id="optServerBind" placeholder="127.0.0.1:8787"></label><label class="option"><span>Username<small>Required when binding outside localhost.</small></span><input id="optServerUser" autocomplete="username"></label><label class="option"><span>Password<small>Required when binding outside localhost. Leave blank to keep current password.</small></span><input id="optServerPassword" type="password" autocomplete="new-password"></label><label class="option"><input type="checkbox" id="optServerLocalBypass"><span>Allow localhost without login<small>Only applies to loopback requests.</small></span></label></section><section class="settings-section"><div class="settings-section-head"><h3>Backend</h3><p>Switch between external Herdr and the built-in terminal backend. Restart WebUI after changing backend mode.</p></div><label class="option"><span>Backend mode<small>Built-in is the default and starts local PTYs from this WebUI process. External Herdr uses Herdr sockets. Auto uses Herdr when available, otherwise built-in.</small></span><select class="settings-select" id="optBackendMode"><option value="builtin">Built-in terminal backend</option><option value="external-herdr">External Herdr</option><option value="auto">Auto</option></select></label><label class="option"><input type="checkbox" id="optBuiltinBackendEnabled"><span>Enable built-in backend<small>Allows local PTY sessions managed by this WebUI process.</small></span></label><label class="option"><input type="checkbox" id="optExternalHerdrBackendEnabled"><span>Enable external Herdr<small>Allows detecting and explicitly launching external Herdr sessions. Discovery stays passive until you create one.</small></span></label><label class="option"><span>Built-in shell<small>Optional shell or command path for new built-in panes. Leave empty for SHELL or /bin/zsh.</small></span><input id="optBuiltinShell" placeholder="/bin/zsh"></label><label class="option"><span>Default folder<small>Used by Files, Git, and temporary terminals when no workspace is selected. The backend verifies access and falls back to home.</small></span><input id="optDefaultFolder" placeholder="~"></label></section><section class="settings-section"><div class="settings-section-head"><h3>Power behavior</h3><p>Server-side sleep prevention defaults.</p></div><label class="option"><span>No-sleep Auto cooldown<small>Seconds to wait after agents stop working before releasing no-sleep.</small></span><input id="optNoSleepAutoCooldown" type="number" min="0" max="3600" step="1"></label></section><div class="worktree-error" id="serverSettingsError"></div><div class="modal-actions"><button type="button" class="tab add" id="serverSettingsLoad">Reload server settings</button><button type="button" class="btn" id="serverSettingsApply">Apply server settings</button></div></div>`;
}
function themeColorInputId(mode, key) {
  return `optThemeColor-${mode}-${key}`;
}
const themes = {
  dark: {
    background: "#11111b",
    foreground: "#cdd6f4",
    cursor: "#1e66f5",
    cursorAccent: "#ffffff",
    selectionBackground: "#1e66f5aa",
    black: "#6c7086",
    brightBlack: "#9399b2",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#cba6f7",
    cyan: "#94e2d5",
    white: "#cdd6f4",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#1e66f5",
    cursorAccent: "#ffffff",
    selectionBackground: "#1e66f599",
    black: "#5c5f77",
    brightBlack: "#6c6f85",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#8839ef",
    cyan: "#179299",
    white: "#acb0be",
    brightWhite: "#4c4f69",
  },
};
const themeColorFields = [
  ["background", "Background", "--bg"],
  ["foreground", "Text", "--fg"],
  ["panel", "Panel", "--panel"],
  ["panel2", "Panel 2", "--panel2"],
  ["border", "Border", "--border"],
  ["border2", "Border 2", "--border2"],
  ["muted", "Muted", "--muted"],
  ["accent", "Accent", "--accent"],
  ["cursor", "Cursor", ""],
  ["selectionBackground", "Selection", ""],
];
const themeColorDefaults = {
  dark: {
    background: "#11111b",
    foreground: "#cdd6f4",
    panel: "#181825",
    panel2: "#1e1e2e",
    border: "#313244",
    border2: "#45475a",
    muted: "#a6adc8",
    accent: "#89b4fa",
    cursor: "#1e66f5",
    selectionBackground: "#1e66f5",
  },
  light: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    panel: "#e6e9ef",
    panel2: "#ccd0da",
    border: "#bcc0cc",
    border2: "#9ca0b0",
    muted: "#6c6f85",
    accent: "#1e66f5",
    cursor: "#1e66f5",
    selectionBackground: "#1e66f5",
  },
};
const themeColorProfiles = {
  default: themeColorDefaults,
  catppuccin: {
    dark: {
      background: "#11111b",
      foreground: "#cdd6f4",
      panel: "#181825",
      panel2: "#1e1e2e",
      border: "#313244",
      border2: "#45475a",
      muted: "#a6adc8",
      accent: "#89b4fa",
      cursor: "#1e66f5",
      selectionBackground: "#1e66f5",
    },
    light: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      panel: "#e6e9ef",
      panel2: "#ccd0da",
      border: "#bcc0cc",
      border2: "#9ca0b0",
      muted: "#6c6f85",
      accent: "#1e66f5",
      cursor: "#1e66f5",
      selectionBackground: "#1e66f5",
    },
  },
  tokyo: {
    dark: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      panel: "#24283b",
      panel2: "#292e42",
      border: "#414868",
      border2: "#565f89",
      muted: "#9aa5ce",
      accent: "#7aa2f7",
      cursor: "#7aa2f7",
      selectionBackground: "#7aa2f7",
    },
    light: {
      background: "#d5d6db",
      foreground: "#343b58",
      panel: "#e1e2e7",
      panel2: "#c4c8da",
      border: "#9699a8",
      border2: "#7e8294",
      muted: "#565a6e",
      accent: "#34548a",
      cursor: "#34548a",
      selectionBackground: "#34548a",
    },
  },
  nord: {
    dark: {
      background: "#2e3440",
      foreground: "#d8dee9",
      panel: "#3b4252",
      panel2: "#434c5e",
      border: "#4c566a",
      border2: "#607087",
      muted: "#a3b1c2",
      accent: "#88c0d0",
      cursor: "#88c0d0",
      selectionBackground: "#88c0d0",
    },
    light: {
      background: "#eceff4",
      foreground: "#2e3440",
      panel: "#e5e9f0",
      panel2: "#d8dee9",
      border: "#c2c9d3",
      border2: "#a9b4c2",
      muted: "#5e6878",
      accent: "#5e81ac",
      cursor: "#5e81ac",
      selectionBackground: "#5e81ac",
    },
  },
};
const settingsModules = window.HerdrSettingsModules || [];
window.HerdrSettingsModules = settingsModules;
window.HerdrWebUiModules = settingsModules;
const moduleOptionDefaults = settingsModules.reduce(
  (acc, module) => Object.assign(acc, module.defaults || {}),
  {},
);
const settingsBody =
  settingsModal && settingsModal.querySelector(".settings-body");
if (settingsBody && !el("optServerBind"))
  settingsBody.insertAdjacentHTML("beforeend", serverSettingsHtml());
if (settingsBody && !el("themeColorsApply"))
  settingsBody.insertAdjacentHTML("beforeend", themeCustomizerHtml());
if (settingsBody) {
  for (const module of settingsModules) {
    if (module.html && !el(`moduleSettings-${module.id}`)) {
      settingsBody.insertAdjacentHTML(
        "beforeend",
        `<div id="moduleSettings-${module.id}">${module.html}</div>`,
      );
    }
  }
}
function normalizeThemeMode(value) {
  if (value === "night") return "dark";
  if (value === "day") return "light";
  return ["auto", "light", "dark"].includes(value) ? value : "auto";
}
function normalizeShortcutPrefix(value, fallback = DEFAULT_GLOBAL_SHORTCUT_PREFIX) {
  const parts = String(value || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return fallback;
  const key = parts.pop();
  const mods = new Set(
    parts.map((part) => {
      const lower = part.toLowerCase();
      if (lower === "control") return "Ctrl";
      if (lower === "cmd" || lower === "command" || lower === "meta")
        return "Meta";
      return lower === "ctrl"
        ? "Ctrl"
        : lower === "alt" || lower === "option"
          ? "Alt"
          : lower === "shift"
            ? "Shift"
            : "";
    }),
  );
  mods.delete("");
  const cleanKey = key.length === 1 ? key.toUpperCase() : key;
  if (!cleanKey || !mods.size) return fallback;
  return ["Ctrl", "Alt", "Shift", "Meta"]
    .filter((mod) => mods.has(mod))
    .concat(cleanKey)
    .join("+");
}
let themeMode = normalizeThemeMode(localStorage.getItem("herdr-web-theme")),
  lastEffectiveTheme = null;
const LEGACY_TERMINAL_FONT_FAMILY = "ui-monospace,SFMono-Regular,Menlo,monospace";
const defaultOptions = {
  overflow: false,
  terminalOverflowOptIn: false,
  fitToBrowser: false,
  sound: true,
  notificationVolume: 0.24,
  browserNotifications: false,
  soundScope: "current",
  shiftEnterNewline: true,
  closeShortcut: "off",
  globalShortcutsEnabled: true,
  globalShortcutPrefix: DEFAULT_GLOBAL_SHORTCUT_PREFIX,
  webuiShortcuts: DEFAULT_WEBUI_SHORTCUTS,
  gitShortcuts: DEFAULT_GIT_SHORTCUTS,
  searchShortcut: "off",
  headerSearchEnabled: true,
  terminalFontFamily: HerdrAppHelpers.resolveTerminalFontFamily(""),
  terminalLinks: true,
  terminalMouseReporting: false,
  agentSortMode: "off",
  agentStatusOrder: ["blocked", "idle", "done", "other", "working"],
  sidebarWorkspacePercent: 68,
  parentCloseMode: "panels",
  stuckWorkingEnabled: true,
  workingDismissMinutes: 30,
  workspaceSort: "default",
  scrollLines: 3,
  treeIndentPx: 14,
  fileBrowserAllowParent: true,
  fileBrowserGitStatus: true,
  fileBrowserLineNumbers: true,
  searchWorkspacesEnabled: true,
  searchFilesEnabled: true,
  searchFoldersEnabled: true,
  searchContentEnabled: true,
  searchSectionOrder: "workspaces,files,content",
  fileBrowserSearchPageSize: 100,
  fileContentSearchMinChars: 3,
  fileContentSearchPageSize: 50,
  fileContentSearchContextLines: 2,
  fileContentSearchAutoCollapseFiles: 0,
  fileContentSearchDefaultExpanded: true,
  fileContentSearchMatchesPerFile: 5,
  fileContentSearchMatchCase: false,
  fileContentSearchRegex: false,
  editorFindShortcutEnabled: true,
  showTabActivity: false,
  worktreeAutoDiscoverSeconds: 3,
  generateWorktreeNames: false,
  worktreeDefaultDirectory: "",
  explorationDefaultDirectory: "",
  themeColors: themeColorDefaults,
  ...moduleOptionDefaults,
};
const agentStatusGroups = [
  ["idle", "Idle", "green"],
  ["working", "Working", "yellow"],
  ["blocked", "Blocked", "red"],
  ["done", "Done", "blue"],
  ["other", "Others", "gray"],
];
const agentStatusGroupKeys = agentStatusGroups.map(([key]) => key);
const agentStatusGroupByKey = Object.fromEntries(
  agentStatusGroups.map((group) => [group[0], group]),
);
const workingFirstAgentStatusOrder = [
  "blocked",
  "working",
  "other",
  "done",
  "idle",
];
const searchSectionGroups = [
  ["workspaces", "Workspaces", "Workspaces, worktrees, panels, agents"],
  ["files", "Files", "File path results for current workspace"],
  ["content", "Content", "Text matches for current workspace"],
];
const searchSectionGroupKeys = searchSectionGroups.map(([key]) => key);
const searchSectionGroupByKey = Object.fromEntries(
  searchSectionGroups.map((group) => [group[0], group]),
);
function searchSectionOptionKey(key) {
  return { workspaces: "searchWorkspacesEnabled", files: "searchFilesEnabled", content: "searchContentEnabled" }[key] || "";
}
function searchSectionEnabled(key) {
  const optionKey = searchSectionOptionKey(key);
  return !optionKey || options[optionKey] !== false;
}
function normalizeAgentStatusOrder(value) {
  const seen = new Set();
  const order = [];
  for (const key of Array.isArray(value) ? value : []) {
    if (agentStatusGroupKeys.includes(key) && !seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  for (const key of defaultOptions.agentStatusOrder) {
    if (!seen.has(key)) order.push(key);
  }
  return order;
}
function normalizeSearchSectionOrder(value) {
  return normalizeOrder(value, searchSectionGroupKeys);
}
function normalizeSidebarWorkspacePercent(value) {
  return Math.round(Math.max(
    20,
    Math.min(80, Number.isFinite(Number(value)) ? Number(value) : 68),
  ));
}
function loadOptions() {
  try {
    const stored = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
    if (stored.overflow === true && stored.terminalOverflowOptIn !== true)
      stored.overflow = false;
    return stored;
  } catch (_) {
    return { ...defaultOptions };
  }
}
function normalizeOptions(value) {
  const next = { ...defaultOptions, ...(value || {}) };
  const hasStoredAgentStatusOrder = Object.prototype.hasOwnProperty.call(
    value || {},
    "agentStatusOrder",
  );
  delete next.shiftEnter;
  if (next.captureCmdW === true || next.closeShortcut === true)
    next.closeShortcut = "altw";
  delete next.captureCmdW;
  if (!["off", "altw", "shiftspacew"].includes(next.closeShortcut))
    next.closeShortcut = defaultOptions.closeShortcut;
  next.shiftEnterNewline = next.shiftEnterNewline !== false;
  next.globalShortcutsEnabled = next.globalShortcutsEnabled !== false;
  next.globalShortcutPrefix = normalizeShortcutPrefix(
    next.globalShortcutPrefix,
    defaultOptions.globalShortcutPrefix,
  );
  next.webuiShortcuts = normalizeShortcutMap(
    next.webuiShortcuts,
    DEFAULT_WEBUI_SHORTCUTS,
  );
  next.gitShortcuts = normalizeShortcutMap(
    next.gitShortcuts,
    DEFAULT_GIT_SHORTCUTS,
  );
  next.searchShortcut =
    String(next.searchShortcut || "").toLowerCase() === "off"
      ? "off"
      : normalizeShortcutPrefix(next.searchShortcut, "off");
  next.headerSearchEnabled = next.headerSearchEnabled !== false;
  next.terminalFontFamily = String(next.terminalFontFamily || "").trim().slice(0, 260);
  if (
    !next.terminalFontFamily ||
    next.terminalFontFamily === LEGACY_TERMINAL_FONT_FAMILY
  ) {
    next.terminalFontFamily = defaultOptions.terminalFontFamily;
  }
  next.terminalLinks = next.terminalLinks !== false;
  next.terminalMouseReporting = next.terminalMouseReporting === true;
  if (!["off", "attention", "attention_inverted"].includes(next.agentSortMode))
    next.agentSortMode = defaultOptions.agentSortMode;
  next.agentStatusOrder = normalizeAgentStatusOrder(next.agentStatusOrder);
  if (next.agentSortMode === "attention_inverted" && !hasStoredAgentStatusOrder)
    next.agentStatusOrder = normalizeAgentStatusOrder(workingFirstAgentStatusOrder);
  if (!["panels", "close"].includes(next.parentCloseMode))
    next.parentCloseMode = defaultOptions.parentCloseMode;
  next.stuckWorkingEnabled = next.stuckWorkingEnabled !== false;
  if (next.sortAgentsByStatus === true) next.agentSortMode = "attention";
  delete next.sortAgentsByStatus;
  next.sidebarWorkspacePercent = normalizeSidebarWorkspacePercent(
    next.sidebarWorkspacePercent,
  );
  next.workingDismissMinutes = Math.max(
    1,
    Math.min(1440, Number(next.workingDismissMinutes) || 30),
  );
  if (!["all", "current"].includes(next.soundScope))
    next.soundScope = defaultOptions.soundScope;
  next.notificationVolume = Math.max(
    0,
    Math.min(
      1,
      Number.isFinite(Number(next.notificationVolume))
        ? Number(next.notificationVolume)
        : defaultOptions.notificationVolume,
    ),
  );
  next.browserNotifications = next.browserNotifications === true;
  if (!["default", "drag", "state"].includes(next.workspaceSort))
    next.workspaceSort = defaultOptions.workspaceSort;
  next.scrollLines = Math.max(1, Math.min(20, Number(next.scrollLines) || 3));
  next.treeIndentPx = Math.max(0, Math.min(40, Number(next.treeIndentPx) || 14));
  next.fileBrowserAllowParent = next.fileBrowserAllowParent !== false;
  next.fileBrowserGitStatus = next.fileBrowserGitStatus !== false;
  next.fileBrowserLineNumbers = next.fileBrowserLineNumbers !== false;
  next.searchWorkspacesEnabled = next.searchWorkspacesEnabled !== false;
  next.searchFilesEnabled = next.searchFilesEnabled !== false;
  next.searchFoldersEnabled = next.searchFoldersEnabled !== false;
  next.searchContentEnabled = next.searchContentEnabled !== false;
  next.searchSectionOrder = normalizeSearchSectionOrder(next.searchSectionOrder).join(",");
  next.fileBrowserSearchPageSize = Math.max(10, Math.min(500, Number(next.fileBrowserSearchPageSize) || 100));
  next.fileContentSearchMinChars = Math.max(1, Math.min(20, Number(next.fileContentSearchMinChars) || 3));
  next.fileContentSearchPageSize = Math.max(10, Math.min(500, Number(next.fileContentSearchPageSize) || 50));
  const fileContentSearchContextRaw = Number(next.fileContentSearchContextLines);
  next.fileContentSearchContextLines = Math.max(0, Math.min(20, Number.isFinite(fileContentSearchContextRaw) ? fileContentSearchContextRaw : 2));
  const fileContentSearchAutoCollapseRaw = Number(next.fileContentSearchAutoCollapseFiles);
  next.fileContentSearchAutoCollapseFiles = Math.max(0, Math.min(200, Number.isFinite(fileContentSearchAutoCollapseRaw) ? fileContentSearchAutoCollapseRaw : 0));
  next.fileContentSearchDefaultExpanded = next.fileContentSearchDefaultExpanded !== false;
  next.fileContentSearchMatchesPerFile = Math.max(1, Math.min(50, Number(next.fileContentSearchMatchesPerFile) || 5));
  next.fileContentSearchMatchCase = next.fileContentSearchMatchCase === true;
  next.fileContentSearchRegex = next.fileContentSearchRegex === true;
  next.editorFindShortcutEnabled = next.editorFindShortcutEnabled !== false;
  next.showTabActivity = next.showTabActivity === true;
  next.worktreeAutoDiscoverSeconds = Math.max(
    0,
    Math.min(
      30,
      Number.isFinite(Number(next.worktreeAutoDiscoverSeconds))
        ? Number(next.worktreeAutoDiscoverSeconds)
        : defaultOptions.worktreeAutoDiscoverSeconds,
    ),
  );
  next.generateWorktreeNames = next.generateWorktreeNames === true;
  next.worktreeDefaultDirectory = String(next.worktreeDefaultDirectory || "").trim();
  next.explorationDefaultDirectory = String(next.explorationDefaultDirectory || "").trim();
  next.themeColors = normalizeThemeColors(next.themeColors, themeColorDefaults);
  for (const module of settingsModules) {
    if (typeof module.normalize === "function") module.normalize(next);
  }
  return next;
}
let options = normalizeOptions(loadOptions());
localStorage.removeItem("herdr-web-shiftenter-migrated");
let workingDismissals = loadWorkingDismissals();
function saveOptions() {
  options = normalizeOptions(options);
  localStorage.setItem("herdr-web-options", JSON.stringify(options));
}
function loadWorkingDismissals() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem("herdr-web-working-dismissals") || "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return {};
  }
}
function saveWorkingDismissals() {
  localStorage.setItem(
    "herdr-web-working-dismissals",
    JSON.stringify(workingDismissals),
  );
}
function agentOverrideKey(a) {
  return a.terminal_id || `${a.workspace_id}:${a.tab_id}:${a.pane_id}`;
}
function agentSignature(a) {
  return [
    a.workspace_id,
    a.tab_id,
    a.pane_id,
    a.terminal_id,
    a.name || a.display_agent || a.agent || "",
  ].join("|");
}
function cleanupWorkingDismissals() {
  if (!options.stuckWorkingEnabled) {
    if (Object.keys(workingDismissals).length) {
      workingDismissals = {};
      saveWorkingDismissals();
    }
    return;
  }
  const now = Date.now();
  const ttl =
    Math.max(1, Number(options.workingDismissMinutes) || 30) * 60 * 1000;
  const seen = new Set();
  let changed = false;
  for (const agent of state.agents) {
    const key = agentOverrideKey(agent);
    seen.add(key);
    const dismissal = workingDismissals[key];
    if (!dismissal) continue;
    if (
      statusClass(agent.agent_status) !== "working" ||
      dismissal.signature !== agentSignature(agent) ||
      now - dismissal.dismissedAt > ttl
    ) {
      delete workingDismissals[key];
      changed = true;
    }
  }
  for (const key of Object.keys(workingDismissals)) {
    if (!seen.has(key)) {
      delete workingDismissals[key];
      changed = true;
    }
  }
  if (changed) saveWorkingDismissals();
}
function isWorkingDismissed(agent) {
  return (
    options.stuckWorkingEnabled &&
    !!workingDismissals[agentOverrideKey(agent)] &&
    statusClass(agent.agent_status) === "working"
  );
}
function dismissWorkingAgent(workspaceId, tabId, paneId, terminalId) {
  const agent = state.agents.find(
    (item) =>
      item.workspace_id === workspaceId &&
      item.tab_id === tabId &&
      item.pane_id === paneId &&
      (!terminalId || item.terminal_id === terminalId),
  );
  if (!agent) return;
  workingDismissals[agentOverrideKey(agent)] = {
    dismissedAt: Date.now(),
    signature: agentSignature(agent),
  };
  saveWorkingDismissals();
  render();
}
function restoreWorkingAgent(workspaceId, tabId, paneId, terminalId) {
  const key = terminalId || `${workspaceId}:${tabId}:${paneId}`;
  delete workingDismissals[key];
  saveWorkingDismissals();
  render();
}
function clearDismissedWorkingForTerminal(terminalId) {
  if (!terminalId || !workingDismissals[terminalId]) return;
  delete workingDismissals[terminalId];
  saveWorkingDismissals();
  render();
}
function noSleepLabel(mode) {
  if (mode === "auto") return "Coffee auto";
  if (mode === "1h") return "Coffee 1h";
  if (mode === "2h") return "Coffee 2h";
  if (mode === "4h") return "Coffee 4h";
  if (mode === "infinite") return "Coffee infinite";
  return "Coffee off";
}
function noSleepSubscript(mode) {
  if (mode === "auto") return "A";
  if (["1h", "2h", "4h"].includes(mode)) return "◷";
  if (mode === "infinite") return "∞";
  return "";
}
function noSleepButtonHtml(mode) {
  const sub = noSleepSubscript(mode);
  return `<span class="coffee-outline" aria-hidden="true"></span>${sub ? `<sub>${sub}</sub>` : ""}`;
}
function noSleepControlHtml(extraId) {
  const suffix = extraId ? ` id="${extraId}"` : "";
  return `<span class="no-sleep-wrap"><button type="button" class="btn shell-action shell-icon-button no-sleep-control"${suffix} value="off" title="Prevent computer sleep">${noSleepButtonHtml("off")}</button><span class="no-sleep-menu" hidden><button type="button" data-mode="off">${noSleepButtonHtml("off")}<span>Off</span></button><button type="button" data-mode="auto">${noSleepButtonHtml("auto")}<span>Auto</span></button><button type="button" data-mode="1h">${noSleepButtonHtml("1h")}<span>1 hour</span></button><button type="button" data-mode="2h">${noSleepButtonHtml("2h")}<span>2 hours</span></button><button type="button" data-mode="4h">${noSleepButtonHtml("4h")}<span>4 hours</span></button><button type="button" data-mode="infinite">${noSleepButtonHtml("infinite")}<span>Infinite</span></button></span></span>`;
}
function noSleepControls() {
  return Array.from(document.querySelectorAll(".no-sleep-control"));
}
function closeNoSleepMenus(except) {
  document.querySelectorAll(".no-sleep-menu").forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
}
function syncNoSleepControls() {
  const mode = noSleepState.mode || "off";
  for (const control of noSleepControls()) {
    control.dataset.mode = mode;
    control.value = mode;
    control.innerHTML = noSleepButtonHtml(mode);
    control.title = noSleepState.error
      ? `No-sleep error: ${noSleepState.error}`
      : !noSleepState.supported
        ? "No-sleep mode is not supported on this host"
        : mode === "auto" && !noSleepState.active
          ? "Auto no-sleep: monitoring agents"
          : mode === "off"
            ? "Prevent computer sleep from WebUI server"
            : `WebUI server preventing sleep: ${noSleepLabel(mode)}`;
    control.classList.toggle("active", mode !== "off");
    control.classList.toggle("unsupported", !!noSleepState.error || !noSleepState.supported);
    const wrap = control.closest && control.closest(".no-sleep-wrap");
    if (wrap) {
      wrap.querySelectorAll(".no-sleep-menu [data-mode]").forEach((option) => {
        option.classList.toggle("active", option.dataset.mode === mode);
      });
    }
  }
}
function bindHost(bind) {
  const value = String(bind || "").trim();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  const index = value.lastIndexOf(":");
  return index >= 0 ? value.slice(0, index) : value;
}
function isNonLocalBind(bind) {
  const host = bindHost(bind).toLowerCase();
  return !(
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host.startsWith("127.")
  );
}
function serverSettingsValidationError(bind, username, password, hasSavedPassword) {
  if (isNonLocalBind(bind) && (!username || (!password && !hasSavedPassword)))
    return "Username and password are required before binding to 0.0.0.0 or any non-local address.";
  return "";
}
async function loadNoSleep() {
  const seq = ++noSleepRequestSeq;
  const previous = noSleepState;
  try {
    const next = await api("/api/no-sleep");
    if (seq !== noSleepRequestSeq) return;
    noSleepState = next;
  } catch (_) {
    if (seq !== noSleepRequestSeq) return;
    noSleepState = {
      mode: previous.mode || "off",
      until_ms: previous.until_ms || null,
      error: "server unavailable",
      supported: true,
    };
  }
  syncNoSleepControls();
  scheduleNoSleepPoll();
}
function scheduleNoSleepPoll() {
  clearTimeout(noSleepPollTimer);
  if (document.hidden || (noSleepState.mode === "off" && !noSleepState.error)) return;
  noSleepPollTimer = setTimeout(loadNoSleep, 10000);
}
async function setNoSleepMode(mode) {
  const seq = ++noSleepRequestSeq;
  try {
    const next = await api("/api/no-sleep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (seq !== noSleepRequestSeq) return;
    noSleepState = next;
  } catch (ex) {
    if (seq !== noSleepRequestSeq) return;
    noSleepState = { mode: "off", until_ms: null, error: ex.message || String(ex), supported: true };
  }
  syncNoSleepControls();
  scheduleNoSleepPoll();
}
saveOptions();
const soundSetting = el("optSound");
if (soundSetting && !el("optBrowserNotifications"))
  soundSetting
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      '<label class="option"><input type="checkbox" id="optBrowserNotifications"><span>Browser notifications<small>Ask this browser to show system notifications when an agent becomes blocked or done.</small></span></label>',
    );
if (soundSetting && !el("optAgentSortMode"))
  (el("optBrowserNotifications") || soundSetting)
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      '<label class="option"><input type="checkbox" id="optGlobalShortcutsEnabled"><span>Global keyboard shortcuts<small>Enable prefix WebUI navigation shortcuts listed under ?.</small></span></label><label class="option"><span>Shortcut prefix<small>Click Record, press desired key combination, then use it before WebUI shortcuts.</small></span><span class="shortcut-capture"><input id="optGlobalShortcutPrefix" readonly><button type="button" class="tab add" id="optGlobalShortcutPrefixCapture">Record</button></span></label><label class="option"><span>Search shortcut<small>Optional direct shortcut. Leave disabled if it conflicts with terminal apps.</small></span><span class="shortcut-capture"><input id="optSearchShortcut" readonly><button type="button" class="tab add" id="optSearchShortcutCapture">Record</button><button type="button" class="tab add" id="optSearchShortcutClear">Clear</button></span></label><label class="option"><span>Terminal font<small>Use installed monospaced font family, including Nerd Fonts used by Neovim.</small></span><input id="optTerminalFontFamily" list="terminalFontPresets" placeholder="&quot;MesloLGS Nerd Font Mono&quot;, monospace"><datalist id="terminalFontPresets"><option value="&quot;MesloLGS Nerd Font Mono&quot;, &quot;MesloLGS NF&quot;, monospace"><option value="&quot;MesloLGS Nerd Font&quot;, &quot;MesloLGS NF&quot;, monospace"><option value="&quot;JetBrainsMono Nerd Font Mono&quot;, &quot;JetBrainsMono Nerd Font&quot;, monospace"><option value="&quot;Hack Nerd Font Mono&quot;, &quot;Hack Nerd Font&quot;, monospace"><option value="&quot;FiraCode Nerd Font Mono&quot;, &quot;FiraCode Nerd Font&quot;, monospace"><option value="&quot;CaskaydiaCove Nerd Font Mono&quot;, &quot;CaskaydiaCove Nerd Font&quot;, monospace"><option value="ui-monospace,SFMono-Regular,Menlo,monospace"></datalist></label><label class="option"><input type="checkbox" id="optTerminalLinks"><span>Terminal links<small>Detect http/https URLs in terminal output and open them in a new tab when clicked.</small></span></label><label class="option"><input type="checkbox" id="optTerminalMouseReporting"><span>Terminal mouse reporting<small>Forward mouse clicks and movement to terminal apps. Disabled by default so pointer movement cannot type raw mouse codes into the shell; scrolling still works.</small></span></label><label class="option"><span>Close panel shortcut<small>Stored in browser storage and available after reopening the tab.</small></span><select class="settings-select" id="optCloseShortcut"><option value="off">Disabled</option><option value="altw">Option+W</option><option value="shiftspacew">Shift+Space then W</option></select></label><label class="option"><span>Agent sorting<small>Turn on status group sorting for the agents sidebar.</small></span><select class="settings-select" id="optAgentSortMode"><option value="off">Default order</option><option value="attention">Custom group order</option><option value="attention_inverted">Working-first preset</option></select></label><div class="option agent-sort-order" id="optAgentStatusOrder"><div><strong>Agent group order</strong><small>Move status groups with arrows. Idle green, working yellow, blocked red, done blue, others gray. Saved in this browser.</small></div><div class="agent-sort-list" id="agentStatusOrderList"></div></div><label class="option"><span>Workspace panel size<small>Percent of sidebar height used by Workspaces. Drag separator or type a percent.</small></span><input id="optSidebarWorkspacePercent" type="number" min="20" max="80" step="1"></label><label class="option"><span>Parent workspace close<small>Close panels only (keeps linked worktrees running) or full close with re-open (stops processes, re-opens worktrees with fresh shells).</small></span><select class="settings-select" id="optParentCloseMode"><option value="panels">Close panels only</option><option value="close">Full close + re-open worktrees</option></select></label><label class="option"><input type="checkbox" id="optStuckWorkingEnabled"><span>Ignore stuck working agents<small>Dismiss working agents that appear stuck. Clears automatically on status changes and terminal output.</small></span></label><label class="option"><span>Ignore stuck working for<small>Minutes to keep a local dismissed-working override before showing working again.</small></span><input id="optWorkingDismissMinutes" type="number" min="1" max="1440" step="1"></label><label class="option"><input type="checkbox" id="optShowTabActivity"><span>Show panel last update<small>Display local last-change age on top panel tabs. Updates on refreshes, events, and selected terminal output; no timer polling.</small></span></label><label class="option"><span>Workspace sorting<small>Default tree order, shared drag-and-drop order, or attention state priority.</small></span><select class="settings-select" id="optWorkspaceSort"><option value="default">Default</option><option value="drag">Drag&drop</option><option value="state">State</option></select></label><label class="option"><span>Notification scope<small>Choose whether alerts fire in every open tab or only the tab viewing the agent panel.</small></span><select class="settings-select" id="optSoundScope"><option value="current">Current agent tab</option><option value="all">All tabs</option></select></label><label class="option"><span>Notification volume<small><span id="notificationVolumeValue">24</span>% for local attention tone.</small></span><input type="range" id="optNotificationVolume" min="0" max="100" step="1"></label><label class="option"><input type="checkbox" id="optGenerateWorktreeNames"><span>Generate worktree branch names<small>Allow blank Branch name in Worktrees modal. Herdr generates worktree/&lt;name&gt;.</small></span></label><label class="option"><span>Worktree default directory<small>Base directory for generated worktree checkout paths. Relative paths resolve from repo root. Example: ../worktrees.</small></span><input id="optWorktreeDefaultDirectory" placeholder="../worktrees"></label><label class="option"><span>Exploration default directory<small>Prefills new/open workspace, worktree discovery, and Git cleanup scan paths.</small></span><input id="optExplorationDefaultDirectory" placeholder="~/Documents/code"></label><label class="option"><span>Scroll speed<small><span id="scrollLinesValue">3</span> terminal lines per wheel step.</small></span><input type="range" id="optScrollLines" min="1" max="20" step="1"></label><label class="option"><span>Worktree autodiscover<small>Seconds to wait after path input stops. Set 0 for immediate.</small></span><input type="number" id="optWorktreeAutoDiscover" min="0" max="30" step="0.5"></label>',
    );
const showTabActivitySetting = el("optShowTabActivity");
if (showTabActivitySetting && !el("optTreeIndentPx"))
  showTabActivitySetting
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      '<label class="option"><span>Tree indentation<small>Pixels added per folder level in file trees.</small></span><input id="optTreeIndentPx" type="number" min="0" max="40" step="1"></label><label class="option"><input type="checkbox" id="optFileBrowserAllowParent"><span>File browser parent folders<small>Allow Files to go above the workspace/worktree directory with the current folder Up button.</small></span></label><label class="option"><input type="checkbox" id="optFileBrowserGitStatus"><span>File browser git status colors<small>Color files and directories in the file browser by Git status: red for deleted, yellow for modified, green for new.</small></span></label><label class="option"><input type="checkbox" id="optFileBrowserLineNumbers"><span>File browser line numbers<small>Show line numbers by default when previewing text files.</small></span></label><label class="option"><input type="checkbox" id="optEditorFindShortcutEnabled"><span>File editor search shortcut<small>Let text editors capture Cmd/Ctrl-F for in-editor search. Disable to keep global browser search.</small></span></label><label class="option"><input type="checkbox" id="optHeaderSearchEnabled"><span>Header search button and shortcut<small>Show the header magnifier and allow the configured search shortcut to open the palette.</small></span></label><div class="option" id="optSearchSectionOrder"><span>Header search section order<small>Use arrows to move sections. Use the middle button to show or hide each section.</small></span><div id="searchSectionOrderList" class="agent-sort-list"></div></div><label class="option"><span>File/folder search page size<small>Backend result count loaded per lazy page.</small></span><input id="optFileBrowserSearchPageSize" type="number" min="10" max="500" step="10"></label><label class="option"><span>Content search minimum characters<small>Minimum typed characters before searching file contents.</small></span><input id="optFileContentSearchMinChars" type="number" min="1" max="20" step="1"></label><label class="option"><span>Content search page size<small>Backend file groups loaded per lazy page.</small></span><input id="optFileContentSearchPageSize" type="number" min="10" max="500" step="10"></label><label class="option"><span>Content search context lines<small>Default lines above and below each match.</small></span><input id="optFileContentSearchContextLines" type="number" min="0" max="20" step="1"></label><label class="option"><span>Content search auto-collapse<small>Collapse file groups when result files exceed this count. 0 means never auto-collapse.</small></span><input id="optFileContentSearchAutoCollapseFiles" type="number" min="0" max="200" step="1"></label><label class="option"><input type="checkbox" id="optFileContentSearchDefaultExpanded"><span>Content results expanded by default<small>Expand each file group when content results load. Auto-collapse can still collapse very large result sets.</small></span></label><label class="option"><span>Content search matches per file<small>Initial match count loaded per file before lazy expansion.</small></span><input id="optFileContentSearchMatchesPerFile" type="number" min="1" max="50" step="1"></label><label class="option"><input type="checkbox" id="optFileContentSearchMatchCase"><span>Content search match case<small>Match upper/lower case exactly in backend content search.</small></span></label><label class="option"><input type="checkbox" id="optFileContentSearchRegex"><span>Content search regular expression<small>Treat content search text as a Rust regex pattern.</small></span></label>',
    );
groupSettingsSections();
function groupSettingsSections() {
  if (!settingsBody || settingsBody.dataset.sections === "1") return;
  const sectionDefs = [
    {
      title: "Appearance",
      desc: "Theme mode and color palette.",
      ids: ["optTheme"],
      blocks: ["themeColorsApply"],
    },
    {
      title: "File browser",
      desc: "Tree display, navigation, and Git status colors.",
      ids: ["optTreeIndentPx", "optFileBrowserAllowParent", "optFileBrowserGitStatus", "optFileBrowserLineNumbers", "optEditorFindShortcutEnabled", "optHeaderSearchEnabled", "optSearchSectionOrder", "optFileBrowserSearchPageSize", "optFileContentSearchMinChars", "optFileContentSearchPageSize", "optFileContentSearchContextLines", "optFileContentSearchAutoCollapseFiles", "optFileContentSearchDefaultExpanded", "optFileContentSearchMatchesPerFile", "optFileContentSearchMatchCase", "optFileContentSearchRegex"],
    },
    {
      title: "Terminal input",
      desc: "Viewport sizing, scrolling, and keyboard behavior.",
      ids: [
        "optOverflow",
        "optFit",
        "optShiftEnterNewline",
        "optScrollLines",
        "optTerminalFontFamily",
        "optTerminalLinks",
        "optTerminalMouseReporting",
      ],
    },
    {
      title: "Agents and alerts",
      desc: "Attention sorting, shortcuts, and notification sound scope.",
      ids: [
        "optSound",
        "optBrowserNotifications",
        "optSoundScope",
        "optNotificationVolume",
        "optGlobalShortcutsEnabled",
        "optGlobalShortcutPrefix",
        "optSearchShortcut",
        "optAgentSortMode",
        "optAgentStatusOrder",
        "optSidebarWorkspacePercent",
        "optParentCloseMode",
        "optStuckWorkingEnabled",
        "optWorkingDismissMinutes",
        "optCloseShortcut",
        "optShowTabActivity",
      ],
    },
    {
      title: "Worktrees",
      desc: "Discovery, naming, and default workspace/worktree locations.",
      ids: [
        "optWorkspaceSort",
        "optGenerateWorktreeNames",
        "optWorktreeDefaultDirectory",
        "optExplorationDefaultDirectory",
        "optWorktreeAutoDiscover",
      ],
    },
    {
      title: "Server",
      desc: "Network access and server-side power behavior.",
      blocks: ["optServerBind"],
    },
    ...settingsModules.map((module) => ({
      title: module.title,
      desc: module.desc || "Module settings.",
      ids: module.ids || [],
      blocks: module.blocks || [],
    })),
  ];
  for (const def of sectionDefs) {
    const nodes = [];
    for (const id of def.ids || []) {
      const control = el(id);
      const row = control && control.closest(".option");
      if (row && !nodes.includes(row)) nodes.push(row);
    }
    for (const id of def.blocks || []) {
      const control = el(id);
      const block =
        control &&
        (control.closest(".theme-customizer") ||
          control.closest(".server-settings"));
      if (block && !nodes.includes(block)) nodes.push(block);
    }
    if (!nodes.length) continue;
    const section = document.createElement("section");
    section.className = "settings-section";
    section.innerHTML = `<div class="settings-section-head"><h3>${def.title}</h3><p>${def.desc}</p></div>`;
    for (const node of nodes) section.appendChild(node);
    settingsBody.appendChild(section);
  }
  settingsBody.dataset.sections = "1";
}
function setupSettingsSearch() {
  const input = el("settingsSearch"),
    body = settingsBody;
  if (!input || !body || body.dataset.search === "1") return;
  const empty = document.createElement("div");
  empty.className = "settings-empty settings-filter-hidden";
  empty.textContent = "No settings match your search.";
  body.appendChild(empty);
  input.addEventListener("input", filterSettings);
  body.dataset.search = "1";
  filterSettings();
}
function prepareSettingsModalOpen() {
  applyOptions();
  loadServerSettings();
  const input = el("settingsSearch");
  if (!input) return;
  input.value = "";
  filterSettings();
  requestAnimationFrame(() => input.focus());
}
function filterSettings() {
  const input = el("settingsSearch"),
    body = settingsBody;
  if (!input || !body) return;
  const query = input.value.trim().toLowerCase();
  let visibleSections = 0;
  const sections = Array.from(body.children || []).filter((node) =>
    node.classList.contains("settings-section"),
  );
  for (const section of sections) {
    const sectionHead = section.querySelector(".settings-section-head");
    const sectionMatches =
      !query ||
      (sectionHead && sectionHead.textContent.toLowerCase().includes(query));
    let visibleRows = 0;
    const rows = Array.from(section.children || []).filter(
      (node) => !node.classList.contains("settings-section-head"),
    );
    for (const row of rows) {
      const match = sectionMatches || row.textContent.toLowerCase().includes(query);
      row.classList.toggle("settings-filter-hidden", !match);
      if (match) visibleRows += 1;
    }
    const visible = sectionMatches || visibleRows > 0;
    section.classList.toggle("settings-filter-hidden", !visible);
    if (visible) visibleSections += 1;
  }
  const empty = body.querySelector(".settings-empty");
  if (empty) empty.classList.toggle("settings-filter-hidden", visibleSections > 0);
}
setupSettingsSearch();
function applyOptions() {
  const shell = el("terminalShell");
  if (shell) shell.classList.toggle("no-overflow", !options.overflow);
  const overflow = el("optOverflow"),
    fitOpt = el("optFit"),
    shiftEnterNewline = el("optShiftEnterNewline"),
    sound = el("optSound"),
    browserNotifications = el("optBrowserNotifications"),
    globalShortcutsEnabled = el("optGlobalShortcutsEnabled"),
    globalShortcutPrefix = el("optGlobalShortcutPrefix"),
    searchShortcut = el("optSearchShortcut"),
    terminalFontFamily = el("optTerminalFontFamily"),
    terminalLinks = el("optTerminalLinks"),
    terminalMouseReporting = el("optTerminalMouseReporting"),
    themeSelect = el("optTheme"),
    closeShortcut = el("optCloseShortcut"),
    sortAgents = el("optAgentSortMode"),
    sidebarWorkspacePercent = el("optSidebarWorkspacePercent"),
    parentCloseMode = el("optParentCloseMode"),
    stuckWorkingEnabled = el("optStuckWorkingEnabled"),
    workingDismissMinutes = el("optWorkingDismissMinutes"),
    workspaceSort = el("optWorkspaceSort"),
    soundScope = el("optSoundScope"),
    notificationVolume = el("optNotificationVolume"),
    notificationVolumeValue = el("notificationVolumeValue"),
    scrollLines = el("optScrollLines"),
    treeIndentPx = el("optTreeIndentPx"),
    fileBrowserAllowParent = el("optFileBrowserAllowParent"),
    fileBrowserGitStatus = el("optFileBrowserGitStatus"),
    fileBrowserLineNumbers = el("optFileBrowserLineNumbers"),
    editorFindShortcutEnabled = el("optEditorFindShortcutEnabled"),
    headerSearchEnabled = el("optHeaderSearchEnabled"),
    fileBrowserSearchPageSize = el("optFileBrowserSearchPageSize"),
    fileContentSearchMinChars = el("optFileContentSearchMinChars"),
    fileContentSearchPageSize = el("optFileContentSearchPageSize"),
    fileContentSearchContextLines = el("optFileContentSearchContextLines"),
    fileContentSearchAutoCollapseFiles = el("optFileContentSearchAutoCollapseFiles"),
    fileContentSearchDefaultExpanded = el("optFileContentSearchDefaultExpanded"),
    fileContentSearchMatchesPerFile = el("optFileContentSearchMatchesPerFile"),
    fileContentSearchMatchCase = el("optFileContentSearchMatchCase"),
    fileContentSearchRegex = el("optFileContentSearchRegex"),
    scrollLinesValue = el("scrollLinesValue"),
    showTabActivity = el("optShowTabActivity"),
    worktreeAutoDiscover = el("optWorktreeAutoDiscover"),
    generateWorktreeNames = el("optGenerateWorktreeNames"),
    worktreeDefaultDirectory = el("optWorktreeDefaultDirectory"),
    explorationDefaultDirectory = el("optExplorationDefaultDirectory"),
    closeShortcutCurrent = el("closeShortcutCurrent");
  if (overflow) overflow.checked = !!options.overflow;
  if (fitOpt) fitOpt.checked = !!options.fitToBrowser;
  if (shiftEnterNewline)
    shiftEnterNewline.checked = options.shiftEnterNewline !== false;
  if (sound) sound.checked = !!options.sound;
  if (browserNotifications) {
    browserNotifications.checked = !!options.browserNotifications;
    browserNotifications.disabled = !("Notification" in window);
  }
  if (globalShortcutsEnabled)
    globalShortcutsEnabled.checked = options.globalShortcutsEnabled !== false;
  if (globalShortcutPrefix)
    globalShortcutPrefix.value = globalShortcutPrefixLabel();
  if (searchShortcut) searchShortcut.value = searchShortcutLabel();
  const prefixKey = el("shortcutPrefixKey");
  if (prefixKey) prefixKey.textContent = globalShortcutPrefixLabel();
  renderShortcutEditor();
  if (terminalFontFamily)
    terminalFontFamily.value = options.terminalFontFamily || "";
  if (terminalLinks)
    terminalLinks.checked = options.terminalLinks !== false;
  if (terminalMouseReporting)
    terminalMouseReporting.checked = options.terminalMouseReporting === true;
  if (themeSelect) themeSelect.value = themeMode;
  if (closeShortcut) closeShortcut.value = options.closeShortcut || "off";
  if (closeShortcutCurrent)
    closeShortcutCurrent.textContent = closeShortcutLabel();
  if (sortAgents) sortAgents.value = options.agentSortMode || "off";
  if (sidebarWorkspacePercent)
    applySidebarWorkspacePercent(options.sidebarWorkspacePercent ?? 68);
  renderAgentStatusOrderSettings();
  if (parentCloseMode)
    parentCloseMode.value = options.parentCloseMode || "panels";
  if (stuckWorkingEnabled)
    stuckWorkingEnabled.checked = options.stuckWorkingEnabled !== false;
  if (workingDismissMinutes)
    workingDismissMinutes.value = String(options.workingDismissMinutes || 30);
  if (workspaceSort) workspaceSort.value = options.workspaceSort || "default";
  if (soundScope) soundScope.value = options.soundScope || "current";
  if (notificationVolume)
    notificationVolume.value = String(Math.round((options.notificationVolume ?? 0.24) * 100));
  if (notificationVolumeValue)
    notificationVolumeValue.textContent = String(
      Math.round((options.notificationVolume ?? 0.24) * 100),
    );
  if (scrollLines) scrollLines.value = String(options.scrollLines || 3);
  if (treeIndentPx) treeIndentPx.value = String(options.treeIndentPx ?? 14);
  if (fileBrowserAllowParent)
    fileBrowserAllowParent.checked = !!options.fileBrowserAllowParent;
  if (fileBrowserGitStatus)
    fileBrowserGitStatus.checked = !!options.fileBrowserGitStatus;
  if (fileBrowserLineNumbers)
    fileBrowserLineNumbers.checked = !!options.fileBrowserLineNumbers;
  if (editorFindShortcutEnabled)
    editorFindShortcutEnabled.checked = options.editorFindShortcutEnabled !== false;
  if (headerSearchEnabled)
    headerSearchEnabled.checked = options.headerSearchEnabled !== false;
  renderSearchSectionOrderSettings();
  if (fileBrowserSearchPageSize)
    fileBrowserSearchPageSize.value = String(options.fileBrowserSearchPageSize ?? 100);
  if (fileContentSearchMinChars)
    fileContentSearchMinChars.value = String(options.fileContentSearchMinChars ?? 3);
  if (fileContentSearchPageSize)
    fileContentSearchPageSize.value = String(options.fileContentSearchPageSize ?? 50);
  if (fileContentSearchContextLines)
    fileContentSearchContextLines.value = String(options.fileContentSearchContextLines ?? 2);
  if (fileContentSearchAutoCollapseFiles)
    fileContentSearchAutoCollapseFiles.value = String(options.fileContentSearchAutoCollapseFiles ?? 0);
  if (fileContentSearchDefaultExpanded)
    fileContentSearchDefaultExpanded.checked = options.fileContentSearchDefaultExpanded !== false;
  if (fileContentSearchMatchesPerFile)
    fileContentSearchMatchesPerFile.value = String(options.fileContentSearchMatchesPerFile ?? 5);
  if (fileContentSearchMatchCase)
    fileContentSearchMatchCase.checked = options.fileContentSearchMatchCase === true;
  if (fileContentSearchRegex)
    fileContentSearchRegex.checked = options.fileContentSearchRegex === true;
  document.body.style.setProperty("--herdr-tree-indent", `${options.treeIndentPx ?? 14}px`);
  if (scrollLinesValue)
    scrollLinesValue.textContent = String(options.scrollLines || 3);
  if (showTabActivity) showTabActivity.checked = !!options.showTabActivity;
  if (worktreeAutoDiscover)
    worktreeAutoDiscover.value = String(
      options.worktreeAutoDiscoverSeconds ?? 3,
    );
  if (generateWorktreeNames)
    generateWorktreeNames.checked = !!options.generateWorktreeNames;
  if (worktreeDefaultDirectory)
    worktreeDefaultDirectory.value = options.worktreeDefaultDirectory || "";
  if (explorationDefaultDirectory)
    explorationDefaultDirectory.value = options.explorationDefaultDirectory || "";
  for (const module of settingsModules) {
    if (typeof module.apply === "function") module.apply(options);
  }
  const actionsButton = el("headerActionsButton");
  if (actionsButton) {
    actionsButton.hidden = options.headerSearchEnabled === false;
    actionsButton.disabled = options.headerSearchEnabled === false;
  }
  syncGitWorkspaceToggle();
  syncThemeColorInputs();
  const worktreeNewBranch = el("worktreeNewBranch"),
    worktreeNewPath = el("worktreeNewPath");
  if (worktreeNewBranch)
    worktreeNewBranch.placeholder = options.generateWorktreeNames
      ? "optional, generated if blank"
      : "required unless selecting existing branch";
  if (worktreeNewPath)
    worktreeNewPath.placeholder = options.generateWorktreeNames
      ? "filled after branch name"
      : "auto-filled from branch name";
  fitTerminalShell();
  if (options.fitToBrowser) {
    const fit = browserTerminalSize();
    if (fit) {
      state.termCols = fit.cols;
      state.termRows = fit.rows;
      if (typeof Terminal !== "undefined") connectTerminal();
    }
  }
  syncShortcutTooltips();
}
function renderAgentStatusOrderSettings() {
  const list = el("agentStatusOrderList"),
    container = el("optAgentStatusOrder");
  if (!list || !container) return;
  const disabled = options.agentSortMode === "off";
  container.classList.toggle("disabled", disabled);
  list.innerHTML = normalizeAgentStatusOrder(options.agentStatusOrder)
    .map((key, index, order) => {
      const [, label, color] = agentStatusGroupByKey[key] || [key, key, "gray"];
      return `<div class="agent-sort-row" data-status="${escapeAttr(key)}"><span class="agent-sort-chip ${escapeAttr(color)}">${escapeHtml(label)}</span><span class="agent-sort-buttons"><button type="button" class="mini" ${index === 0 ? "disabled" : ""} onclick="moveAgentStatusGroup('${escapeAttr(key)}',-1)">↑</button><button type="button" class="mini" ${index === order.length - 1 ? "disabled" : ""} onclick="moveAgentStatusGroup('${escapeAttr(key)}',1)">↓</button></span></div>`;
    })
    .join("");
}
function moveAgentStatusGroup(key, delta) {
  const order = normalizeAgentStatusOrder(options.agentStatusOrder);
  const index = order.indexOf(key);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  options.agentStatusOrder = order;
  if (options.agentSortMode === "off") options.agentSortMode = "attention";
  saveOptions();
  applyOptions();
  render();
}
function renderSearchSectionOrderSettings() {
  const list = el("searchSectionOrderList"),
    container = el("optSearchSectionOrder");
  if (!list || !container) return;
  const disabled = options.headerSearchEnabled === false;
  container.classList.toggle("disabled", disabled);
  list.innerHTML = normalizeSearchSectionOrder(options.searchSectionOrder)
    .map((key, index, order) => {
      const [, label, desc] = searchSectionGroupByKey[key] || [key, key, ""];
      const enabled = searchSectionEnabled(key);
      return `<div class="agent-sort-row" data-section="${escapeAttr(key)}"><span class="agent-sort-chip gray"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(desc)}</small></span><span class="agent-sort-buttons"><button type="button" class="mini" ${index === 0 ? "disabled" : ""} onclick="moveSearchSectionGroup('${escapeAttr(key)}',-1)" title="Move ${escapeAttr(label)} up">↑</button><button type="button" class="mini ${enabled ? "active" : ""}" onclick="toggleSearchSectionGroup('${escapeAttr(key)}')" title="${enabled ? "Hide" : "Show"} ${escapeAttr(label)}">${enabled ? "Shown" : "Hidden"}</button><button type="button" class="mini" ${index === order.length - 1 ? "disabled" : ""} onclick="moveSearchSectionGroup('${escapeAttr(key)}',1)" title="Move ${escapeAttr(label)} down">↓</button></span></div>`;
    })
    .join("");
}
function toggleSearchSectionGroup(key) {
  const optionKey = searchSectionOptionKey(String(key || ""));
  if (!optionKey) return;
  options[optionKey] = options[optionKey] === false;
  saveOptions();
  applyOptions();
}
function moveSearchSectionGroup(key, delta) {
  const order = normalizeSearchSectionOrder(options.searchSectionOrder);
  const index = order.indexOf(key);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  options.searchSectionOrder = order.join(",");
  saveOptions();
  applyOptions();
}
function setSidebarWorkspacePercent(value) {
  options.sidebarWorkspacePercent = normalizeSidebarWorkspacePercent(value);
  saveOptions();
  applySidebarWorkspacePercent(options.sidebarWorkspacePercent);
}
function applySidebarWorkspacePercent(value) {
  const percent = normalizeSidebarWorkspacePercent(value);
  document.body.style.setProperty("--sidebar-workspace-percent", `${percent}%`);
  const input = el("optSidebarWorkspacePercent");
  if (input) input.value = String(percent);
  return percent;
}
function previewSidebarWorkspacePercent(value) {
  return applySidebarWorkspacePercent(value);
}
function syncThemeColorInputs() {
  for (const mode of ["dark", "light"]) {
    const colors = options.themeColors[mode] || themeColorDefaults[mode];
    for (const [key] of themeColorFields) {
      const input = el(themeColorInputId(mode, key));
      if (input) input.value = colors[key];
    }
  }
}
function closeShortcutLabel() {
  if (options.closeShortcut === "altw") return "Option+W";
  if (options.closeShortcut === "shiftspacew") return "Shift+Space, W";
  return "Disabled";
}
function saveCloseShortcutOption() {
  options.closeShortcut = el("optCloseShortcut").value;
  closeChordUntil = 0;
  saveOptions();
  applyOptions();
}
function readThemeColorInputs() {
  for (const mode of ["dark", "light"]) {
    for (const [key] of themeColorFields) {
      const input = el(themeColorInputId(mode, key));
      if (input) options.themeColors[mode][key] = input.value;
    }
  }
  options.themeColors = normalizeThemeColors(
    options.themeColors,
    themeColorDefaults,
  );
}
function applyThemeColorsFromSettings() {
  readThemeColorInputs();
  saveOptions();
  syncThemeColorInputs();
  applyTheme();
  render();
}
function applyThemeColorProfile(name) {
  options.themeColors = normalizeThemeColors(
    themeColorProfiles[name] || themeColorProfiles.default,
    themeColorDefaults,
  );
  saveOptions();
  syncThemeColorInputs();
  applyTheme();
  render();
}
function effectiveTheme() {
  if (themeMode === "dark") return "dark";
  if (themeMode === "light") return "light";
  if (window.matchMedia)
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  return "light";
}
function terminalTheme() {
  const mode = effectiveTheme();
  const colors = options.themeColors[mode] || themeColorDefaults[mode];
  return {
    ...(themes[mode] || themes.light),
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    selectionBackground: colors.selectionBackground,
  };
}
function shiftEnterSequence() {
  return "\n";
}
function terminalFontFamily() {
  return HerdrAppHelpers.resolveTerminalFontFamily(options.terminalFontFamily);
}
function applyTerminalFont() {
  if (!term) return;
  const family = terminalFontFamily();
  try {
    term.options.fontFamily = family;
  } catch (e) {
    try {
      term.setOption("fontFamily", family);
    } catch (_) {}
  }
  try {
    term.refresh(0, Math.max(0, (term.rows || 1) - 1));
  } catch (_) {}
}
function applyTheme() {
  themeMode = normalizeThemeMode(themeMode);
  const current = effectiveTheme();
  lastEffectiveTheme = current;
  const light = current === "light";
  document.body.classList.toggle("light", light);
  applyThemeColorVars(current);
  const toggle = el("themeToggle");
  if (toggle) {
    toggle.textContent =
      themeMode === "auto" ? "A" : themeMode === "dark" ? "☾" : "☀";
    toggle.title = "Theme: " + themeMode + " (" + current + ")";
  }
  const themeSelect = el("optTheme");
  if (themeSelect) themeSelect.value = themeMode;
  localStorage.setItem("herdr-web-theme", themeMode);
  if (term) {
    try {
      term.options.theme = terminalTheme();
    } catch (e) {
      try {
        term.setOption("theme", terminalTheme());
      } catch (_) {}
    }
  }
  fitTerminalShell();
}
function applyThemeColorVars(mode) {
  const colors = options.themeColors[mode] || themeColorDefaults[mode];
  for (const [key, , cssVar] of themeColorFields) {
    if (cssVar) document.body.style.setProperty(cssVar, colors[key]);
  }
}
function pollAutoTheme() {
  if (themeMode !== "auto") return;
  const current = effectiveTheme();
  if (current !== lastEffectiveTheme) applyTheme();
}
function el(id) {
  return document.getElementById(id);
}
function askQuestion({ title = "Confirm action", message = "Continue?", confirmText = "Confirm", danger = false } = {}) {
  const modal = el("questionModal");
  if (!modal) return Promise.resolve(confirm(message));
  el("questionTitle").textContent = title;
  el("questionMessage").textContent = message;
  const confirmButton = el("questionConfirm");
  confirmButton.textContent = confirmText;
  confirmButton.classList.toggle("danger", !!danger);
  modal.style.display = "grid";
  confirmButton.focus();
  return new Promise((resolve) => {
    state.questionResolve = resolve;
  });
}
function closeQuestion(answer) {
  const modal = el("questionModal");
  if (modal) modal.style.display = "none";
  const resolve = state.questionResolve;
  state.questionResolve = null;
  if (resolve) resolve(!!answer);
}
function gitUiEnabled() {
  return options.gitUiEnabled !== false;
}
function themeToggleIcon() {
  if (themeMode === "auto") return `${appIcon("themeAuto")}<sub>A</sub>`;
  return themeMode === "dark" ? '<span aria-hidden="true">☾</span>' : '<span aria-hidden="true">☀</span>';
}
function setupSessionChrome() {
  const head = document.querySelector(".head");
  const headerActions = el("headerActionsButton");
  const oldSessionButton = el("sessionButton");
  if (oldSessionButton) oldSessionButton.remove();
  const oldSearchButton = el("searchButtonHead");
  if (oldSearchButton) oldSearchButton.remove();
  if (headerActions) {
    headerActions.hidden = options.headerSearchEnabled === false;
    headerActions.disabled = options.headerSearchEnabled === false;
    headerActions.onclick = () => openSearchPalette();
  }
  if (!el("themeToggleHead")) {
    const b = document.createElement("button");
    b.className = "btn shell-action shell-icon-button";
    b.id = "themeToggleHead";
    b.title = "Toggle theme";
    b.innerHTML = themeToggleIcon();
    head.insertBefore(b, headerActions);
    b.onclick = () => {
      themeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
      applyTheme();
      render();
    };
  }
  if (!el("noSleepHead")) {
    const wrap = document.createElement("span");
    wrap.innerHTML = noSleepControlHtml("noSleepHead");
    head.insertBefore(wrap.firstChild, headerActions);
    syncNoSleepControls();
  }
  let shellModeGroup = el("shellModeGroup");
  if (!shellModeGroup) {
    shellModeGroup = document.createElement("span");
    shellModeGroup.id = "shellModeGroup";
    shellModeGroup.className = "shell-mode-group";
    shellModeGroup.setAttribute("role", "tablist");
    shellModeGroup.setAttribute("aria-label", "Workspace view");
    if (headerActions) headerActions.insertAdjacentElement("afterend", shellModeGroup);
    else head.appendChild(shellModeGroup);
  }
  if (!el("terminalWorkspaceToggle")) {
    const t = document.createElement("button");
    t.className = "btn worktree-open-trigger shell-action shell-icon-button";
    t.id = "terminalWorkspaceToggle";
    t.title = titleWithWebuiShortcut("Show terminal", "focusTerminal");
    t.innerHTML = appIcon("terminal");
    t.setAttribute("aria-label", "Show terminal");
    t.setAttribute("role", "tab");
    shellModeGroup.appendChild(t);
    t.onclick = () => showTerminalShellMode();
  } else if (el("terminalWorkspaceToggle").parentNode !== shellModeGroup) {
    shellModeGroup.appendChild(el("terminalWorkspaceToggle"));
  }
  if (!gitUiEnabled()) {
    const existingGitToggle = el("gitWorkspaceToggle");
    if (existingGitToggle) existingGitToggle.remove();
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
  } else if (!el("gitWorkspaceToggle")) {
    const b = document.createElement("button");
    b.className = "btn worktree-open-trigger shell-action shell-icon-button git-workspace-toggle unknown";
    b.id = "gitWorkspaceToggle";
    b.title = "Show Git drawer";
    b.innerHTML = appIcon("git");
    b.setAttribute("aria-label", "Show Git drawer");
    b.setAttribute("role", "tab");
    shellModeGroup.appendChild(b);
    b.onclick = () => openWorkspaceGitUi(state.ws);
  } else if (el("gitWorkspaceToggle").parentNode !== shellModeGroup) {
    shellModeGroup.appendChild(el("gitWorkspaceToggle"));
  }
  if (!el("fileWorkspaceToggle")) {
    const b = document.createElement("button");
    b.className = "btn worktree-open-trigger shell-action shell-icon-button";
    b.id = "fileWorkspaceToggle";
    b.title = "Show file browser";
    b.innerHTML = appIcon("file");
    b.setAttribute("aria-label", "Show file browser");
    b.setAttribute("role", "tab");
    shellModeGroup.appendChild(b);
    b.onclick = () => openWorkspaceFileBrowser(state.ws);
  } else if (el("fileWorkspaceToggle").parentNode !== shellModeGroup) {
    shellModeGroup.appendChild(el("fileWorkspaceToggle"));
  }
  syncShellModeButtons();
  const side = document.querySelector(".side");
  const workspacePane = el("workspacePane");
  if (workspacePane && !el("workspaceContextActions")) {
    const header = workspacePane.querySelector(".section-header");
    const actions = document.createElement("div");
    actions.id = "workspaceContextActions";
    actions.className = "workspace-context-actions";
    if (header) header.insertAdjacentElement("afterend", actions);
    else workspacePane.insertBefore(actions, workspacePane.firstChild);
  }
  const stalePanelActions = el("panelContextActions");
  if (stalePanelActions) stalePanelActions.remove();
  const versionsEl = el("versions");
  let footer = el("sideFooterBar");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "sideFooterBar";
    footer.className = "side-footer-bar";
    side.appendChild(footer);
  }
  const brand = document.querySelector(".brand");
  if (brand && brand.parentNode !== footer) footer.appendChild(brand);
  if (!el("footerSessionButton")) {
    const b = document.createElement("button");
    b.id = "footerSessionButton";
    b.className = "footer-session-button";
    b.title = "Session manager";
    b.textContent = state.session || "default";
    b.onclick = () => showSessionManager(state.backendOnline ? "Session manager" : "Herdr session offline");
    const brandText = brand && brand.querySelector(".brand-text");
    if (brandText) brandText.appendChild(b);
    else footer.appendChild(b);
  } else {
    const button = el("footerSessionButton"),
      brandText = brand && brand.querySelector(".brand-text");
    if (button && brandText && button.parentNode !== brandText)
      brandText.appendChild(button);
  }
  if (versionsEl && versionsEl.parentNode !== footer) {
    versionsEl.remove();
    versionsEl.classList.add("side-footer", "footer-meta");
    footer.appendChild(versionsEl);
  }
  if (versionsEl) versionsEl.classList.add("side-footer", "footer-meta");
  if (!el("footerShortcutsButton")) {
    const actions = document.createElement("span");
    actions.className = "footer-actions";
    actions.innerHTML = `<button class="mini footer-icon-button" id="footerShortcutsButton" title="${escapeAttr(titleWithWebuiShortcut("Shortcuts", "help"))}" aria-label="${escapeAttr(titleWithWebuiShortcut("Shortcuts", "help"))}">${appIcon("help")}</button><button class="mini footer-icon-button" id="footerSettingsButton" title="${escapeAttr(titleWithWebuiShortcut("Settings", "settings"))}" aria-label="${escapeAttr(titleWithWebuiShortcut("Settings", "settings"))}">${appIcon("settings")}</button>`;
    footer.appendChild(actions);
    el("footerShortcutsButton").onclick = () => { applyOptions(); el("shortcutsModal").style.display = "grid"; };
    el("footerSettingsButton").onclick = () => { el("settingsModal").style.display = "grid"; prepareSettingsModalOpen(); };
  }
  const footerShortcutsButton = el("footerShortcutsButton");
  const footerSettingsButton = el("footerSettingsButton");
  if (footerShortcutsButton) {
    footerShortcutsButton.classList.add("footer-icon-button");
    footerShortcutsButton.innerHTML = appIcon("help");
  }
  if (footerSettingsButton) {
    footerSettingsButton.classList.add("footer-icon-button");
    footerSettingsButton.innerHTML = appIcon("settings");
  }
  if (!el("sessionManager")) {
    const m = document.createElement("div");
    m.className = "session-manager";
    m.id = "sessionManager";
    m.innerHTML =
      '<div class="session-card"><div class="session-hero"><div><h1 id="sessionManagerTitle">Sessions</h1><p id="sessionManagerText">Choose a built-in or Herdr backend session to open.</p></div><div class="session-current"><span class="dot unknown"></span><span id="sessionCurrentLabel">default · built-in</span></div></div><div class="session-actions"><div class="session-list" id="sessionList"></div><div class="session-line session-new"><span><strong>Create or target session</strong><small>Choose where to create/open it. Built-in starts inside WebUI. Herdr starts external daemon.</small></span><span class="session-controls"><button class="session-button primary" id="newBuiltinSessionTarget">New built-in</button><button class="session-button" id="newHerdrSessionTarget">New Herdr</button></span></div></div></div>';
    document.querySelector(".main").prepend(m);
    el("newBuiltinSessionTarget").onclick = () => newSessionTarget("builtin");
    el("newHerdrSessionTarget").onclick = () => newSessionTarget("external-herdr");
  }
  syncShortcutTooltips();
}
function sessionBackendLabel(backend) {
  return backend === "external-herdr" ? "Herdr" : "built-in";
}
function currentSessionBackend() {
  return state.sessionBackend || state.backendMode || "builtin";
}
async function newSessionTarget(backend) {
  const name = prompt(`${sessionBackendLabel(backend)} session name`);
  if (!name) return;
  await launchBackend(name, backend);
  goSession(name, backend);
}
async function loadSessions() {
  try {
    const r = await api("/api/sessions");
    state.sessions = r.sessions || [];
    state.sessionBackend = r.current_backend || currentSessionBackend();
  } catch (e) {
    state.sessions = [{ name: state.session || "default", backend: currentSessionBackend(), running: false }];
  }
}
function renderSessionRows() {
  const list = state.sessions.length
    ? state.sessions
    : [{ name: state.session || "default", backend: currentSessionBackend(), running: state.backendOnline }];
  return list
    .map((s) => {
      const backend = s.backend || "external-herdr";
      const active = s.name === state.session && backend === currentSessionBackend();
      const status = `<span class="status-pill ${s.running ? "running" : "offline"}">${s.running ? "running" : "offline"}</span>`;
      const backendPill = `<span class="status-pill">${escapeHtml(s.backend_label || sessionBackendLabel(backend))}</span>`;
      const controls = active
        ? `<span class="session-controls">${backendPill}<button class="session-button primary" onclick="event.stopPropagation();launchBackend('${escapeAttr(s.name)}','${escapeAttr(backend)}')">Launch</button><button class="session-button" onclick="event.stopPropagation();refresh()">Retry</button><button class="session-button" onclick="event.stopPropagation();resetSession()">Reset workspaces</button><button class="session-button danger" onclick="event.stopPropagation();closeCurrentSession()">Close</button></span>`
        : `<span class="session-controls">${backendPill}${status}</span>`;
      const hint = active
        ? "current browser target"
        : s.running
          ? `click to switch to this ${sessionBackendLabel(backend)} session`
          : `click to target this offline ${sessionBackendLabel(backend)} session`;
      return `<div class="session-line ${active ? "active" : ""}" onclick="goSession('${escapeAttr(s.name)}','${escapeAttr(backend)}')"><span><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(hint)}</small></span>${controls}</div>`;
    })
    .join("");
}
async function showSessionManager(title, text) {
  await loadSessions();
  const titleEl = el("sessionManagerTitle"),
    textEl = el("sessionManagerText"),
    manager = el("sessionManager"),
    list = el("sessionList"),
    current = el("sessionCurrentLabel");
  if (titleEl) titleEl.textContent = title || "Session manager";
  if (textEl)
    textEl.textContent =
      text || `Current target: ${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`;
  if (current)
    current.textContent = `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`;
  if (list) list.innerHTML = renderSessionRows();
  if (manager) manager.style.display = "block";
}
function hideSessionManager() {
  const manager = el("sessionManager");
  if (manager) manager.style.display = "none";
}
async function launchBackend(session = state.session, backend = currentSessionBackend()) {
  const textEl = el("sessionManagerText");
  if (textEl) textEl.textContent = `Launching ${sessionBackendLabel(backend)} session...`;
  try {
    const r = await api("/api/session/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: session || "default", backend }),
    });
    if (textEl)
      textEl.textContent = r.ok
        ? r.pid
          ? `Launched pid ${r.pid}. Waiting for backend...`
          : `Launched ${sessionBackendLabel(backend)} session.`
        : r.error || "Launch failed";
    setTimeout(refresh, 1200);
  } catch (e) {
    if (textEl) textEl.textContent = e.message || String(e);
  }
}
async function closeCurrentSession() {
  if (!confirm(`Close current ${sessionBackendLabel(currentSessionBackend())} session?`)) return;
  try {
    await api("/api/session/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.session || "default", backend: currentSessionBackend() }),
    });
    showSessionManager(
      "Session closed",
      "Session stopped. You can launch it again.",
    );
    setTimeout(refresh, 800);
  } catch (e) {
    showSessionManager("Close failed", e.message || String(e));
  }
}
async function resetSession() {
  if (!confirm("Close all workspaces in this session?")) return;
  for (const w of [...state.workspaces]) {
    try {
      await api(`/api/workspaces/${encodeURIComponent(w.workspace_id)}/close`, {
        method: "POST",
      });
    } catch (e) {}
  }
  state.ws = null;
  state.tab = null;
  state.pane = null;
  refresh();
}
const statusClass = (s) => (s === "done" ? "done" : s || "unknown");
function statusMark(status, withText = false) {
  const s = statusClass(status);
  if (s === "working")
    return '<span class="herdr-spinner" aria-label="working"><i></i><i></i><i></i><i></i></span>';
  if (s === "blocked")
    return withText ? '<span class="blocked-text">blocked</span>' : "";
  return "";
}
function statusDot(status) {
  const s = statusClass(status);
  if (s === "working") return '<span class="dot working"></span>';
  if (s === "blocked") return '<span class="dot blocked"></span>';
  if (s === "idle" || s === "done")
    return `<span class="dot ${s === "done" ? "done" : "idle"}"></span>`;
  return '<span class="dot unknown"></span>';
}
function apiOptions(opt) {
  const next = Object.assign({}, opt || {});
  next.headers = Object.assign(
    {},
    next.headers || {},
    state.session && state.session !== "default"
      ? { "x-herdr-session": state.session }
      : {},
    currentSessionBackend()
      ? { "x-herdr-backend": currentSessionBackend() }
      : {},
  );
  return next;
}
function apiErrorMessage(body, statusText) {
  const err = body && body.error;
  if (!err) return statusText;
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  if (err.code) return String(err.code);
  try {
    return JSON.stringify(err);
  } catch (_) {
    return statusText;
  }
}
async function api(url, opt) {
  const r = await fetch(url, apiOptions(opt));
  if (r.status === 401) {
    location.href = "/";
    throw Error("unauthorized");
  }
  const body = await r.json();
  if (!r.ok || body.error) throw Error(apiErrorMessage(body, r.statusText));
  return body;
}
async function loadServerSettings() {
  const err = el("serverSettingsError");
  if (err) err.textContent = "";
  try {
    const settings = await api("/api/server-settings");
    el("optServerBind").value = settings.bind || "127.0.0.1:8787";
    el("optServerUser").value = settings.username || "";
    el("optServerPassword").value = "";
    el("optServerPassword").placeholder = settings.has_password
      ? "current password saved"
      : "required for public bind";
    el("optServerPassword").dataset.hasPassword = settings.has_password
      ? "true"
      : "false";
    el("optServerLocalBypass").checked = !!settings.localhost_no_auth;
    el("optBackendMode").value = settings.backend_mode || "builtin";
    el("optBuiltinBackendEnabled").checked = settings.builtin_backend_enabled !== false;
    el("optExternalHerdrBackendEnabled").checked = settings.external_herdr_backend_enabled !== false;
    el("optBuiltinShell").value = settings.builtin_shell || "";
    state.defaultFolder = settings.default_folder || state.defaultFolder || "";
    el("optDefaultFolder").value = state.defaultFolder || "";
    syncGitWorkspaceToggle();
    syncFileWorkspaceToggle();
    el("optNoSleepAutoCooldown").value = String(
      settings.no_sleep_auto_cooldown_seconds ?? 60,
    );
  } catch (ex) {
    if (err) err.textContent = ex.message || String(ex);
  }
}
async function applyServerSettings() {
  const err = el("serverSettingsError"),
    submit = el("serverSettingsApply"),
    bind = el("optServerBind").value.trim(),
    username = el("optServerUser").value.trim(),
    password = el("optServerPassword").value,
    hasSavedPassword = el("optServerPassword").dataset.hasPassword === "true",
    localhostNoAuth = el("optServerLocalBypass").checked,
    backendMode = el("optBackendMode").value,
    builtinBackendEnabled = el("optBuiltinBackendEnabled").checked,
    externalHerdrBackendEnabled = el("optExternalHerdrBackendEnabled").checked,
    builtinShell = el("optBuiltinShell").value.trim(),
    defaultFolder = el("optDefaultFolder").value.trim(),
    noSleepAutoCooldown = Number(el("optNoSleepAutoCooldown").value || 60);
  if (err) err.textContent = "";
  const validationError = serverSettingsValidationError(
    bind,
    username,
    password,
    hasSavedPassword,
  );
  if (validationError) {
    if (err) err.textContent = validationError;
    return;
  }
  submit.disabled = true;
  try {
    const updatedSettings = await api("/api/server-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bind,
        username: username || null,
        password: password ? password : null,
        localhost_no_auth: localhostNoAuth,
        backend_mode: backendMode,
        builtin_backend_enabled: builtinBackendEnabled,
        external_herdr_backend_enabled: externalHerdrBackendEnabled,
        builtin_shell: builtinShell || null,
        default_folder: defaultFolder || null,
        no_sleep_auto_cooldown_seconds: noSleepAutoCooldown,
      }),
    });
    state.defaultFolder = updatedSettings.default_folder || state.defaultFolder || "";
    el("optDefaultFolder").value = state.defaultFolder || "";
    if (err)
      err.textContent =
        "Saved. If Bind changed, listener is restarting. If Backend mode changed, restart WebUI, then reload this page.";
    el("optServerPassword").value = "";
  } catch (ex) {
    if (err) err.textContent = ex.message || String(ex);
  } finally {
    submit.disabled = false;
  }
}
async function loadVersions() {
  const versionsEl = el("versions");
  try {
    const v = await api("/api/versions");
    state.backendMode = v.backend_mode || "builtin";
    state.sessionBackend =
      v.current_backend ||
      (state.backendMode === "external" || state.backendMode === "external-herdr"
        ? "external-herdr"
        : state.backendMode === "builtin"
          ? "builtin"
          : state.sessionBackend || "builtin");
    const session = v.session || state.session || "default";
    const compat = v.compatibility || {},
      status =
        compat.status && compat.status !== "compatible"
          ? " · " + compat.status
          : "";
    const backendIsBuiltin =
      state.sessionBackend === "builtin" ||
      String(v.backend || "") === "builtin" ||
      String(v.backend || "").startsWith("builtin-");
    const backendLabel = backendIsBuiltin ? "built-in" : v.backend || "offline";
    if (versionsEl) {
      versionsEl.textContent = `webui ${v.webui || "-"} · backend ${backendLabel}${status}`;
      versionsEl.title = `session ${session}${compat.message ? ` · ${compat.message}` : ""}`;
    }
    const button = el("footerSessionButton");
    if (button) button.textContent = `${state.session || session} · ${sessionBackendLabel(currentSessionBackend())}`;
  } catch (e) {
    if (versionsEl) versionsEl.textContent = "webui - · backend offline";
    const button = el("footerSessionButton");
    if (button) button.textContent = `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`;
  }
}
function sessionPrefix() {
  return "/session/" + encodeURIComponent(state.session || "default");
}
// Desktop backend (builtin_backend.rs `next_id` -> `tab_N`) returns UNSCOPED
// tab/pane ids. The URL stores them raw (`/workspace/ws1/tab/tab_2`), and every
// comparison in refreshOnline / closeTab / etc. is against the raw backend id.
// Earlier code scoped ids as `${ws}:${id}` in parseRoute, which made
// `state.tab` (scoped) never match `state.tabs[].tab_id` (unscoped), so the
// panel switcher always snapped back to the focused/first tab after a refresh.
// Ids stay raw end-to-end on desktop — no scoping helpers needed.
// (Mobile keeps a real scoped implementation in src/assets/mobile/core.js.)
function selectionPath(ws, tab, pane) {
  let p = sessionPrefix() + "/workspace/" + encodeURIComponent(ws);
  if (tab) p += "/tab/" + encodeURIComponent(tab);
  if (pane) p += "/pane/" + encodeURIComponent(pane);
  return p;
}
function parseRoute() {
  const p = location.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  let i = 0;
  state.session = "default";
  if (p[0] === "session") {
    state.session = p[1] || "default";
    i = 2;
  }
  state.ws = p[i] === "workspace" ? p[i + 1] : null;
  state.tab = p[i + 2] === "tab" ? (p[i + 3] || null) : null;
  state.pane = p[i + 4] === "pane" ? (p[i + 5] || null) : null;
}
function setTerminalLoading(show) {
  const loading = el("terminalLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function resetTerminalConnection(clear = false, destroy = false) {
  if (inputFlushTimer) {
    clearTimeout(inputFlushTimer);
    inputFlushTimer = null;
  }
  inputQueue = [];
  terminalQueryReplyState = {};
  inputQueueMaxBufferedAmount = 65536;
  if (pasteChunkTimer) {
    clearTimeout(pasteChunkTimer);
    pasteChunkTimer = null;
  }
  if (pasteProgressHideTimer) {
    clearTimeout(pasteProgressHideTimer);
    pasteProgressHideTimer = null;
  }
  pasteJob = null;
  if (typeof hideTerminalPasteProgress === "function") hideTerminalPasteProgress();
  if (terminalWriteQueue.length && typeof flushTerminalFrames === "function") flushTerminalFrames();
  terminalWriteQueue = [];
  terminalWriteFlushPending = false;
  terminalAttachPending = false;
  setTerminalFollowPaused(false);
  if (
    terminalViewportScrollElement &&
    typeof terminalViewportScrollElement.removeEventListener === "function" &&
    typeof handleTerminalViewportScroll === "function"
  ) {
    terminalViewportScrollElement.removeEventListener("scroll", handleTerminalViewportScroll);
  }
  terminalViewportScrollElement = null;
  if (termWs) {
    termWs.onclose = null;
    try {
      termWs.close();
    } catch (e) {}
    termWs = null;
  }
  connectedTerminalId = null;
  connectedSize = "";
  if (destroy && term) {
    if (terminalLinkProvider && terminalLinkProvider.dispose) {
      try { terminalLinkProvider.dispose(); } catch (_) {}
    }
    terminalLinkProvider = null;
    try {
      term.dispose();
    } catch (_) {}
    term = null;
  }
  if (destroy) {
    const terminalEl = el("terminal");
    if (terminalEl) terminalEl.innerHTML = "";
  } else if (clear && term) term.clear();
}
function replaceSelectionHistory() {
  history.replaceState(null, "", state.ws ? selectionPath(state.ws, state.tab, state.pane) : sessionPrefix());
}
function navigateSelection(e, ws, tab, pane) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1))
    return true;
  e.preventDefault();
  const gitWasVisible = !!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible());
  const fileWasVisible = !!(window.HerdrFileBrowser && window.HerdrFileBrowser.isVisible && window.HerdrFileBrowser.isVisible());
  go(ws, tab, pane);
  if (gitWasVisible) openWorkspaceGitUi(ws, { forceOpen: true });
  else if (fileWasVisible) openWorkspaceFileBrowser(ws, { forceOpen: true });
  else {
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
  }
  return false;
}
function go(ws, tab, pane) {
  history.pushState(null, "", selectionPath(ws, tab, pane));
  parseRoute();
  resetTerminalConnection(true);
  setTerminalLoading(true);
  refresh();
}
function goSession(name, backend = currentSessionBackend()) {
  state.session = name || "default";
  state.sessionBackend = backend || "builtin";
  localStorage.setItem("herdr-session-backend", state.sessionBackend);
  state.ws = null;
  state.tab = null;
  state.pane = null;
  resetTerminalConnection(true);
  setTerminalLoading(true);
  if (eventWs) {
    eventWs.onclose = null;
    try {
      eventWs.close();
    } catch (e) {}
    eventWs = null;
  }
  history.pushState(null, "", sessionPrefix());
  parseRoute();
  loadVersions();
  refresh();
  connectEvents();
}
async function refreshOnline(seq) {
  parseRoute();
  const routeWs = state.ws,
    routeTab = state.tab,
    routePane = state.pane;
  const w = await api("/api/workspaces");
  if (seq !== refreshSeq) return;
  state.workspaces = w.result.workspaces || [];
  creatingDefaultWorkspace = false;
  if (state.ws && !state.workspaces.some((w) => w.workspace_id === state.ws)) {
    resetTerminalConnection(true);
    setTerminalLoading(false);
    state.ws = (state.workspaces[0] || {}).workspace_id || null;
    state.tab = null;
    state.pane = null;
    state.terminalId = null;
    if (state.ws) history.replaceState(null, "", selectionPath(state.ws));
    else history.replaceState(null, "", sessionPrefix());
  }
  const worktreeSources = worktreeSourceWorkspaceIds();
  const worktreeResults = await Promise.all(
    worktreeSources.map((id) =>
      api("/api/worktrees?workspace_id=" + encodeURIComponent(id)).catch(
        () => null,
      ),
    ),
  );
  if (seq !== refreshSeq) return;
  state.worktrees = worktreeResults.flatMap((r) => {
    const result = (r || {}).result || {},
      source = result.source || {};
    return (result.worktrees || []).map((wt) =>
      Object.assign({}, wt, {
        source_workspace_id: source.source_workspace_id,
        source_repo_name: source.repo_name,
        source_repo_key: source.repo_key,
        source_repo_root: source.repo_root,
        source_cwd: source.source_checkout_path,
        default_worktree_directory: source.default_worktree_directory,
      }),
    );
  });
  state.workspaceBranches = {};
  for (const r of worktreeResults) {
    const result = (r || {}).result || {},
      source = result.source || {},
      sourceId = source.source_workspace_id,
      sourcePath = source.source_checkout_path;
    if (!sourceId || !sourcePath) continue;
    const match = (result.worktrees || []).find((wt) =>
      samePath(wt.path, sourcePath),
    );
    if (match && (match.branch || match.is_detached))
      state.workspaceBranches[sourceId] =
        match.branch || (match.is_detached ? "detached" : "");
  }
  try {
    const order = await api("/api/workspace-order");
    if (seq !== refreshSeq) return;
    state.workspaceOrder = order.order || [];
  } catch (e) {
    state.workspaceOrder = [];
  }
  if (!state.ws) {
    state.allTabs = [];
    state.tabs = [];
    state.panes = [];
    state.agents = [];
    state.terminalId = null;
    setTerminalLoading(false);
  }
  if (state.ws) {
    const [allT, t, p, a] = await Promise.all([
      api("/api/tabs"),
      api("/api/tabs?workspace_id=" + encodeURIComponent(state.ws)),
      api("/api/panes?workspace_id=" + encodeURIComponent(state.ws)),
      api("/api/agents"),
    ]);
    if (seq !== refreshSeq) return;
    state.allTabs = allT.result.tabs || [];
    state.tabs = t.result.tabs || [];
    state.panes = p.result.panes || [];
    state.agents = a.result.agents || [];
    handleAttentionSound();
    if (!state.tabs.some((t) => t.tab_id === state.tab)) {
      const focused = state.tabs.find((t) => t.focused);
      state.tab = (focused || state.tabs[0] || {}).tab_id || null;
    }
    if (
      state.tab &&
      !state.panes.some((p) => p.tab_id === state.tab) &&
      state.panes.length
    ) {
      const pane =
        state.panes.find((p) => p.focused) ||
        state.panes.find((p) => p.workspace_id === state.ws) ||
        state.panes[0];
      state.tab = pane && pane.tab_id;
      state.pane = pane && pane.pane_id;
    }
    if (!state.panes.some((p) => p.pane_id === state.pane)) {
      const pane =
        state.panes.find((x) => x.tab_id === state.tab && x.focused) ||
        state.panes.find((x) => x.tab_id === state.tab) ||
        state.panes[0];
      state.pane = pane && pane.pane_id;
      if (pane && pane.tab_id) state.tab = pane.tab_id;
    }
    const pane = state.panes.find((x) => x.pane_id === state.pane);
    state.terminalId = pane && pane.terminal_id;
    if (
      routeWs &&
      (routeWs !== state.ws || routeTab !== state.tab || routePane !== state.pane)
    ) {
      resetTerminalConnection(true, true);
      history.replaceState(null, "", selectionPath(state.ws, state.tab, state.pane));
    }
    state.termCols = null;
    state.termRows = null;
    state.layoutCols = null;
    state.layoutRows = null;
    state.layoutPaneCount = 0;
    if (state.pane) {
      // Prefer the cached layout snapshot (populated by session.snapshot or
      // layout.updated events) to avoid a per-pane pane.layout round trip on
      // every refresh. Fall back to the legacy request only when no cache
      // exists for the current tab.
      let layout = currentTabLayout();
      if (!layout) {
        try {
          const l = await api(
            "/api/pane-layout?pane_id=" + encodeURIComponent(state.pane),
          );
          if (seq !== refreshSeq) return;
          layout = (l.result || {}).layout || null;
        } catch (e) {
          layout = null;
        }
      }
      if (layout) {
        const lp = layout.panes || [];
        const selected = lp.find((x) => x.pane_id === state.pane);
        if (selected && selected.rect) {
          state.termCols = Math.max(1, selected.rect.width);
          state.termRows = Math.max(1, selected.rect.height);
          state.layoutCols = Math.max(
            1,
            (layout.area || {}).width || state.termCols,
          );
          state.layoutRows = Math.max(
            1,
            (layout.area || {}).height || state.termRows,
          );
          state.layoutPaneCount = lp.length;
        }
      }
    }
    if (
      state.fitDefault ||
      options.fitToBrowser ||
      shouldFitFocusedWebTerminal() ||
      shouldAutoFitDetachedTerminal()
    ) {
      const fit = browserTerminalSize();
      if (fit) {
        state.termCols = fit.cols;
        state.termRows = fit.rows;
        state.fitDefault = false;
      }
    }
    if (
      (location.pathname === "/" ||
        location.pathname === "/session" ||
        location.pathname ===
          "/session/" + encodeURIComponent(state.session)) &&
      state.ws
    )
      history.replaceState(
        null,
        "",
        selectionPath(state.ws, state.tab, state.pane),
      );
  }
  render();
  if (state.ws) connectTerminal();
}
async function refresh() {
  const seq = ++refreshSeq;
  try {
    await refreshOnline(seq);
    if (seq !== refreshSeq) return;
    state.backendOnline = true;
    hideSessionManager();
    const button = el("footerSessionButton");
    if (button) button.textContent = state.session || "default";
  } catch (e) {
    state.backendOnline = false;
    state.workspaces = [];
    state.tabs = [];
    state.panes = [];
    state.agents = [];
    render();
    showSessionManager(
      "Herdr session offline",
      `No backend reachable for session ${state.session || "default"}: ${e.message || e}`,
    );
    const button = el("footerSessionButton");
    if (button) button.textContent = (state.session || "default") + " offline";
  }
}
function scheduleRefresh(delay = 500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}
function scheduleRefreshBurst(delays = [50, 250, 1000]) {
  for (const delay of delays) setTimeout(refresh, delay);
}
function eventNeedsFastRefresh(kind) {
  return FAST_REFRESH_EVENTS.has(kind);
}
function forgetClosedSelection(kind, data) {
  if (kind === "pane.exited" && data && data.pane_id) {
    if (tempTerminal && tempTerminal.handlePaneExited) tempTerminal.handlePaneExited(data.pane_id);
    closePaneById(data.pane_id)
      .then(() => scheduleRefresh(50))
      .catch(() => {});
  }
  if (kind === "pane.closed" || kind === "pane.exited") {
    const closedPane = data && data.pane_id
      ? (state.panes || []).find((pane) => pane.pane_id === data.pane_id)
      : null;
    if (data && data.pane_id) removeClosedPaneFromState(data.pane_id);
    const closedLastPaneInTab =
      closedPane &&
      closedPane.tab_id &&
      !(state.panes || []).some((pane) => pane.tab_id === closedPane.tab_id);
    if (closedLastPaneInTab) removeClosedTabFromState(closedPane.tab_id);
    if (data && data.pane_id && data.pane_id === state.pane) {
      resetTerminalConnection(true, true);
      if (closedLastPaneInTab) selectFallbackTabAfterClosed(closedPane.tab_id);
      else selectFallbackPaneAfterClosed(data.pane_id);
      render();
      replaceSelectionHistory();
      if (typeof Terminal !== "undefined") connectTerminal();
    }
  } else if (kind === "tab.closed") {
    if (data && data.tab_id) removeClosedTabFromState(data.tab_id);
    if (data && data.tab_id && data.tab_id === state.tab) {
      resetTerminalConnection(true);
      selectFallbackTabAfterClosed(data.tab_id);
      render();
      replaceSelectionHistory();
      if (typeof Terminal !== "undefined") connectTerminal();
    }
  }
}

function removeClosedPaneFromState(paneId) {
  state.panes = (state.panes || []).filter((pane) => pane.pane_id !== paneId);
  state.agents = (state.agents || []).filter((agent) => agent.pane_id !== paneId);
}

function removeClosedTabFromState(tabId) {
  state.tabs = (state.tabs || []).filter((tab) => tab.tab_id !== tabId);
  state.allTabs = (state.allTabs || []).filter((tab) => tab.tab_id !== tabId);
  state.panes = (state.panes || []).filter((pane) => pane.tab_id !== tabId);
  state.agents = (state.agents || []).filter((agent) => agent.tab_id !== tabId);
}

function selectFallbackTabAfterClosed(closedTabId) {
  const nextTab =
    (state.tabs || []).find((tab) => tab.tab_id !== closedTabId && tab.focused) ||
    (state.tabs || []).find((tab) => tab.tab_id !== closedTabId) ||
    null;
  state.tab = nextTab && nextTab.tab_id;
  const nextPane =
    (state.panes || []).find((pane) => pane.tab_id === state.tab && pane.focused) ||
    (state.panes || []).find((pane) => pane.tab_id === state.tab) ||
    null;
  state.pane = nextPane && nextPane.pane_id;
  state.terminalId = (nextPane && nextPane.terminal_id) || null;
}

function selectFallbackPaneAfterClosed(closedPaneId) {
  const remainingPanes = (state.panes || []).filter((pane) => pane.pane_id !== closedPaneId);
  let nextPane = remainingPanes.find((pane) => pane.tab_id === state.tab && pane.focused) ||
    remainingPanes.find((pane) => pane.tab_id === state.tab) ||
    remainingPanes.find((pane) => pane.workspace_id === state.ws) ||
    remainingPanes[0] ||
    null;
  if (!nextPane) {
    const nextTab = (state.tabs || []).find((tab) => tab.tab_id !== state.tab) || state.tabs[0] || null;
    state.tab = nextTab && nextTab.tab_id;
    state.pane = null;
    state.terminalId = null;
    return;
  }
  state.tab = nextPane.tab_id || state.tab;
  state.pane = nextPane.pane_id;
  state.terminalId = nextPane.terminal_id || null;
}
// Delegate to the legacy polling snapshot helper (see legacy_polling.js).
// The events socket pushes this every 5s for backends that do not support
// session.snapshot. Kept as the fallback path.
function applySnapshot(msg) {
  applyLegacyPollingSnapshot(msg);
}

// Applies a layout.updated event payload. Replaces the cached layout for the
// matching workspace/tab so the next render uses fresh pane rects without a
// pane.layout round trip. Only triggers a terminal resize when the layout for
// the currently focused tab changed, avoiding a full refresh storm.
function applyLayoutUpdated(layout) {
  if (!layout || !layout.workspace_id || !layout.tab_id) return;
  const key = layout.workspace_id + "/" + layout.tab_id;
  state.layouts[key] = layout;
  // Only act when the current tab's layout changed. A full refreshOnline
  // re-fetches all tabs/panes/agents and can cause flicker, so we update
  // terminal sizing directly instead.
  if (state.ws === layout.workspace_id && state.tab === layout.tab_id && state.pane) {
    const lp = layout.panes || [];
    const selected = lp.find((x) => x.pane_id === state.pane);
    if (selected && selected.rect) {
      const prevCols = state.termCols;
      const prevRows = state.termRows;
      state.termCols = Math.max(1, selected.rect.width);
      state.termRows = Math.max(1, selected.rect.height);
      state.layoutCols = Math.max(1, (layout.area || {}).width || state.termCols);
      state.layoutRows = Math.max(1, (layout.area || {}).height || state.termRows);
      state.layoutPaneCount = lp.length;
      // Only reconnect the terminal if the size actually changed.
      if (prevCols !== state.termCols || prevRows !== state.termRows) {
        if (typeof connectTerminal === "function") connectTerminal();
      } else {
        // Size unchanged, just update the surface dimensions.
        if (typeof fitTerminalSurface === "function") fitTerminalSurface();
      }
    }
  }
}

// Reads the cached layout snapshot for the current tab, if any. Returns null
// when no layout.updated or session.snapshot has populated it yet.
function currentTabLayout() {
  if (!state.ws || !state.tab) return null;
  return state.layouts[state.ws + "/" + state.tab] || null;
}
function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioCtx =
      audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const resumed = audioCtx.resume();
    if (resumed && resumed.then) {
      resumed
        .then(() => {
          audioUnlocked = true;
        })
        .catch(() => {});
    } else {
      audioUnlocked = true;
    }
  } catch (e) {}
}
function handleAttentionSound() {
  const attentionAgents = state.agents.filter(needsAttention);
  const current = new Set(attentionAgents.map(agentKey));
  syncBrowserFavicon();
  if (knownAttention === null) {
    knownAttention = current;
    return;
  }
  const newlyAttentioned = attentionAgents.filter(
    (a) => !knownAttention.has(agentKey(a)),
  );
  knownAttention = current;
  if (newlyAttentioned.length && shouldPlayAttentionSound(newlyAttentioned))
    playAttentionSound();
  if (newlyAttentioned.length) notifyAttention(newlyAttentioned);
}
function notificationTitle(agent) {
  const status = statusClass(agent.agent_status);
  return status === "blocked" ? "Agent blocked" : "Agent done";
}
function notificationBody(agent) {
  const workspace = state.workspaces.find((w) => w.workspace_id === agent.workspace_id);
  const name = agent.name || agent.display_agent || agent.agent || agent.terminal_id || "agent";
  const workspaceName = workspace ? workspaceDisplayTitle(workspace) : agent.workspace_id || "workspace";
  return `${name} in ${workspaceName}`;
}
function notifyAttention(agents) {
  if (!options.browserNotifications || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  for (const agent of agents.slice(0, 3)) {
    try {
      const notification = new Notification(notificationTitle(agent), {
        body: notificationBody(agent),
        icon: "/favicon-attention.svg",
        tag: agentKey(agent),
      });
      notification.onclick = () => {
        window.focus();
        if (agent.workspace_id) go(agent.workspace_id, agent.tab_id, agent.pane_id);
        notification.close();
      };
    } catch (_) {}
  }
}
async function setBrowserNotifications(enabled) {
  if (!enabled) {
    options.browserNotifications = false;
    saveOptions();
    applyOptions();
    return;
  }
  if (!("Notification" in window)) {
    options.browserNotifications = false;
    saveOptions();
    applyOptions();
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (_) {
      permission = "denied";
    }
  }
  options.browserNotifications = permission === "granted";
  saveOptions();
  applyOptions();
}
function syncBrowserFavicon() {
  if (browserFaviconError) {
    browserFavicon.set("error");
    return;
  }
  browserFavicon.set(document.hidden && state.agents.some(needsAttention) ? "attention" : "normal");
}
function needsAttention(a) {
  const s = statusClass(a.agent_status);
  return s === "blocked" || s === "done";
}
function agentKey(a) {
  return a.terminal_id || `${a.workspace_id}:${a.tab_id}:${a.pane_id}`;
}
function shouldPlayAttentionSound(agents) {
  if ((options.soundScope || "current") === "all") return true;
  return agents.some(
    (a) =>
      a.workspace_id === state.ws &&
      a.tab_id === state.tab &&
      a.pane_id === state.pane,
  );
}
function playAttentionSound() {
  if (!options.sound || !audioUnlocked) return;
  const now = Date.now();
  if (now - lastAttentionSound < 1500) return;
  lastAttentionSound = now;
  if (!audioCtx || audioCtx.state !== "running") return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(880, audioCtx.currentTime);
  o.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08);
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(attentionSoundVolume(), audioCtx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.24);
}
function attentionSoundVolume() {
  return Math.max(0.0001, Math.min(1, Number(options.notificationVolume) || 0));
}
function tabTitle(t) {
  return t.label || `tab ${t.number}`;
}
