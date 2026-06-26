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
  editingWorkspace: null,
  editingWorkspaceValue: "",
  workspaceCreateSuggestedLabel: "",
  workspaceCreatePathSuggestTimer: null,
  createWorktreeOriginalSource: "",
  createWorktreePathSuggestTimer: null,
  createWorktreePathSuggestions: [],
  createWorktreeSuggestionIndex: -1,
  createWorktreeSource: null,
  createWorktreeAutodiscoverTimer: null,
  createWorktreeDefaultPath: "",
  createWorktreeSuggestionLocked: false,
};
let term,
  termWs,
  eventWs,
  hiddenTimer,
  refreshTimer,
  connectedTerminalId = null,
  connectedSize = "",
  termScrollBound = false,
  audioCtx = null,
  audioUnlocked = false,
  knownAttention = null,
  lastAttentionSound = 0,
  creatingDefaultWorkspace = false,
  refreshSeq = 0,
  terminalFramePending = false,
  resizeFramePending = false,
  lastWorkspacesHtml = "",
  lastAgentsHtml = "",
  lastTabsHtml = "",
  tabActivity = {},
  closeChordUntil = 0,
  inputQueue = [],
  inputFlushTimer = null,
  pasteFrameUntil = 0,
  wheelScrollRemainder = 0;
const SIDEBAR_COLLAPSED_KEY = "herdr-web-sidebar-collapsed";
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
const inputEncoder = new TextEncoder();
const {
  branchPathSlug,
  normalizeAbsolutePath,
  normalizeThemeColors,
  resolveTerminalFontFamily,
  textValue,
  resolveWorktreeSource: resolveWorktreeSourceHelper,
  checkedOutWorktreeForBranch: checkedOutWorktreeForBranchHelper,
  validateWorktreeCreate: validateWorktreeCreateHelper,
  buildWorktreeCreateBody,
  terminalPasteInput,
  tabActivityLabel,
  terminalWheelScrollBatch,
} = globalThis.HerdrAppHelpers;
const workspaces = el("workspaces"),
  agents = el("agents"),
  tabs = el("tabs"),
  newWs = el("newWs");
applySidebarCollapsed();
const sidebarToggle = el("sidebarToggle");
if (sidebarToggle)
  sidebarToggle.onclick = () => {
    sidebarCollapsed = !sidebarCollapsed;
    storeFlag(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed);
    applySidebarCollapsed();
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
    '<div class="section-header">Workspaces</div>',
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
  split.appendChild(workspacePane);
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
const settingsModal = el("settingsModal");
if (settingsModal && !settingsModal.dataset.ux) {
  const modal = settingsModal.querySelector(".modal");
  const heading = modal && modal.querySelector("h2");
  if (modal && heading) {
    const head = document.createElement("div");
    head.className = "settings-head";
    head.innerHTML =
      '<div><h2>Settings</h2><p>Browser-local preferences for terminal, theme, and agent behavior.</p></div><button class="mini settings-close" id="settingsCloseTop" title="Close">✕</button>';
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
            <input id="worktreeCreateSource" list="worktreeCreatePathOptions" placeholder="parent workspace path" autocomplete="off">
          </label>
          <datalist id="worktreeCreatePathOptions"></datalist>
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
            <h2>Worktrees</h2>
            <p>Type a repo path to open existing linked worktrees or create a new one.</p>
          </div>
          <button class="mini settings-close" id="worktreeOpenClose" title="Close">✕</button>
        </div>
        <div class="worktree-open-controls">
          <label>
            <span>Repo or worktrees folder</span>
            <input id="worktreeDiscoverPath" list="worktreePathOptions" placeholder="~/Documents/code/repo-or-worktrees">
          </label>
          <datalist id="worktreePathOptions"></datalist>
          <div class="worktree-loading" id="worktreeLoading">Discovering worktrees...</div>
        </div>
        <div class="worktree-open-list" id="worktreeOpenList"></div>
        <div class="worktree-new" id="worktreeNewSection">
          <div class="worktree-new-head">
            <strong>Create a new worktree</strong>
            <small>Uses repo path above. Leave base blank to use repo default branch.</small>
          </div>
          <form class="worktree-form" id="worktreeNewForm">
            <div class="worktree-grid">
              <label><span>Branch name</span><input id="worktreeNewBranch" placeholder="feature/my-branch"></label>
              <label><span>Base branch</span><input id="worktreeNewBase" list="worktreeBranchOptions" placeholder="default branch"></label>
              <datalist id="worktreeBranchOptions"></datalist>
            </div>
            <div class="worktree-grid">
              <label><span>Label</span><input id="worktreeNewLabel" placeholder="optional"></label>
              <label><span>Checkout path</span><input id="worktreeNewPath" placeholder="select base branch or enter branch name"></label>
            </div>
            <button class="btn" id="worktreeNewSubmit">New worktree</button>
          </form>
        </div>
        <div class="worktree-error" id="worktreeOpenError"></div>
        <div class="worktree-open-footer">
          <button type="button" class="tab add" id="worktreeOpenRefresh">Refresh</button>
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
            <input id="workspaceCreatePath" list="workspacePathOptions" placeholder="~/Documents/code/project" required>
          </label>
          <datalist id="workspacePathOptions"></datalist>
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
            <h2>Shortcuts</h2>
            <p>Browser/WebUI shortcuts. Terminal apps may handle their own keybindings inside the pane.</p>
          </div>
          <button class="mini settings-close" id="shortcutsCloseTop" title="Close">✕</button>
        </div>
        <div class="shortcuts-list">
          <div class="shortcut-row"><kbd id="closeShortcutCurrent">Disabled</kbd><span>Close current Herdr panel. Configure in Settings.</span></div>
          <div class="shortcut-row"><kbd>Shift+Enter</kbd><span>Send configured newline sequence to terminal.</span></div>
          <div class="shortcut-row"><kbd>PageUp/PageDown</kbd><span>Scroll Herdr terminal backend.</span></div>
          <div class="shortcut-row"><kbd>Option+Wheel</kbd><span>Scroll browser overflow instead of terminal backend.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Ctrl+C</kbd><span>Copy selected terminal text.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Ctrl+V</kbd><span>Paste clipboard into terminal.</span></div>
          <div class="shortcut-row"><kbd>Ctrl+B</kbd><span>Herdr prefix key. Passes through to the terminal; Herdr handles its own keybindings.</span></div>
          <div class="shortcut-row"><kbd>Double-click</kbd><span>Rename workspaces and panels.</span></div>
          <div class="shortcut-row"><kbd>Cmd/Middle-click</kbd><span>Open workspace, agent, or panel link using browser tab behavior.</span></div>
        </div>
        <div class="modal-actions"><button class="btn" id="shortcutsClose">Close</button></div>
      </div>
    </div>`;
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
  return `<div class="server-settings"><section class="settings-section"><div class="settings-section-head"><h3>Network access</h3><p>Saved in ~/.config/herdr-webui/webui-settings.json. Changing Bind restarts the WebUI listener.</p></div><label class="option"><span>Bind address<small>Use 127.0.0.1:8787 for local only or 0.0.0.0:8787 for LAN/public access.</small></span><input id="optServerBind" placeholder="127.0.0.1:8787"></label><label class="option"><span>Username<small>Required when binding outside localhost.</small></span><input id="optServerUser" autocomplete="username"></label><label class="option"><span>Password<small>Required when binding outside localhost. Leave blank to keep current password.</small></span><input id="optServerPassword" type="password" autocomplete="new-password"></label><label class="option"><input type="checkbox" id="optServerLocalBypass"><span>Allow localhost without login<small>Only applies to loopback requests.</small></span></label></section><section class="settings-section"><div class="settings-section-head"><h3>Power behavior</h3><p>Server-side sleep prevention defaults.</p></div><label class="option"><span>No-sleep Auto cooldown<small>Seconds to wait after agents stop working before releasing no-sleep.</small></span><input id="optNoSleepAutoCooldown" type="number" min="0" max="3600" step="1"></label></section><div class="worktree-error" id="serverSettingsError"></div><div class="modal-actions"><button type="button" class="tab add" id="serverSettingsLoad">Reload server settings</button><button type="button" class="btn" id="serverSettingsApply">Apply server settings</button></div></div>`;
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
const settingsBody =
  settingsModal && settingsModal.querySelector(".settings-body");
if (settingsBody && !el("optServerBind"))
  settingsBody.insertAdjacentHTML("beforeend", serverSettingsHtml());
if (settingsBody && !el("themeColorsApply"))
  settingsBody.insertAdjacentHTML("beforeend", themeCustomizerHtml());
function normalizeThemeMode(value) {
  if (value === "night") return "dark";
  if (value === "day") return "light";
  return ["auto", "light", "dark"].includes(value) ? value : "auto";
}
let themeMode = normalizeThemeMode(localStorage.getItem("herdr-web-theme")),
  lastEffectiveTheme = null;
const defaultOptions = {
  overflow: true,
  fitToBrowser: false,
  sound: true,
  soundScope: "current",
  shiftEnterNewline: true,
  closeShortcut: "off",
  agentSortMode: "off",
  parentCloseMode: "panels",
  stuckWorkingEnabled: true,
  workingDismissMinutes: 30,
  workspaceSort: "default",
  scrollLines: 3,
  terminalFontFamily: "",
  showTabActivity: false,
  worktreeAutoDiscoverSeconds: 3,
  generateWorktreeNames: false,
  worktreeDefaultDirectory: "../worktrees",
  themeColors: themeColorDefaults,
};
function loadOptions() {
  try {
    return {
      ...defaultOptions,
      ...JSON.parse(localStorage.getItem("herdr-web-options") || "{}"),
    };
  } catch (_) {
    return { ...defaultOptions };
  }
}
function normalizeOptions(value) {
  const next = { ...defaultOptions, ...(value || {}) };
  delete next.shiftEnter;
  if (next.captureCmdW === true || next.closeShortcut === true)
    next.closeShortcut = "altw";
  delete next.captureCmdW;
  if (!["off", "altw", "shiftspacew"].includes(next.closeShortcut))
    next.closeShortcut = defaultOptions.closeShortcut;
  next.shiftEnterNewline = next.shiftEnterNewline !== false;
  if (!["off", "attention", "attention_inverted"].includes(next.agentSortMode))
    next.agentSortMode = defaultOptions.agentSortMode;
  if (!["panels", "close"].includes(next.parentCloseMode))
    next.parentCloseMode = defaultOptions.parentCloseMode;
  next.stuckWorkingEnabled = next.stuckWorkingEnabled !== false;
  if (next.sortAgentsByStatus === true) next.agentSortMode = "attention";
  delete next.sortAgentsByStatus;
  next.workingDismissMinutes = Math.max(
    1,
    Math.min(1440, Number(next.workingDismissMinutes) || 30),
  );
  if (!["all", "current"].includes(next.soundScope))
    next.soundScope = defaultOptions.soundScope;
  if (!["default", "drag", "state"].includes(next.workspaceSort))
    next.workspaceSort = defaultOptions.workspaceSort;
  next.scrollLines = Math.max(1, Math.min(20, Number(next.scrollLines) || 3));
  next.terminalFontFamily = String(next.terminalFontFamily || "").trim();
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
  next.worktreeDefaultDirectory =
    String(next.worktreeDefaultDirectory || "").trim() ||
    defaultOptions.worktreeDefaultDirectory;
  next.themeColors = normalizeThemeColors(next.themeColors, themeColorDefaults);
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
  if (mode === "auto") return "Auto";
  if (mode === "1h") return "◷ 1h";
  if (mode === "2h") return "◷ 2h";
  if (mode === "4h") return "◷ 4h";
  if (mode === "infinite") return "∞ Infinite";
  return "No sleep: off";
}
function noSleepControlHtml(extraId) {
  const suffix = extraId ? ` id="${extraId}"` : "";
  return `<select class="mini no-sleep-control"${suffix} title="Prevent computer sleep"><option value="off">No sleep: off</option><option value="auto">Auto</option><option value="1h">◷ 1h</option><option value="2h">◷ 2h</option><option value="4h">◷ 4h</option><option value="infinite">∞ Infinite</option></select>`;
}
function noSleepControls() {
  return Array.from(document.querySelectorAll(".no-sleep-control"));
}
function syncNoSleepControls() {
  const mode = noSleepState.mode || "off";
  for (const control of noSleepControls()) {
    if (document.activeElement === control) continue;
    if (control.value !== mode)
      control.value = mode;
    control.title = noSleepState.error
      ? `No-sleep error: ${noSleepState.error}`
      : !noSleepState.supported
        ? "No-sleep mode is not supported on this host"
        : mode === "auto" && !noSleepState.active
          ? "Auto no-sleep: monitoring agents"
          : mode === "off"
            ? "Prevent computer sleep from WebUI server"
            : `WebUI server preventing sleep: ${noSleepLabel(mode)}`;
    control.classList.toggle("active", !!noSleepState.active);
    control.classList.toggle("unsupported", !!noSleepState.error || !noSleepState.supported);
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
  try {
    noSleepState = await api("/api/no-sleep");
  } catch (_) {
    noSleepState = { mode: "off", until_ms: null, error: "server unavailable", supported: true };
  }
  syncNoSleepControls();
}
async function setNoSleepMode(mode) {
  try {
    noSleepState = await api("/api/no-sleep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch (ex) {
    noSleepState = { mode: "off", until_ms: null, error: ex.message || String(ex), supported: true };
  }
  syncNoSleepControls();
}
saveOptions();
const soundSetting = el("optSound");
if (soundSetting && !el("optAgentSortMode"))
  soundSetting
    .closest("label")
    .insertAdjacentHTML(
      "afterend",
      '<label class="option"><span>Close panel shortcut<small>Stored in browser storage and available after reopening the tab.</small></span><select class="settings-select" id="optCloseShortcut"><option value="off">Disabled</option><option value="altw">Option+W</option><option value="shiftspacew">Shift+Space then W</option></select></label><label class="option"><span>Agent sorting<small>Sort agents by attention priority, or show them in default order.</small></span><select class="settings-select" id="optAgentSortMode"><option value="off">Default order</option><option value="attention">Attention (blocked first)</option><option value="attention_inverted">Attention (working first)</option></select></label><label class="option"><span>Parent workspace close<small>Close panels only (keeps linked worktrees running) or full close with re-open (stops processes, re-opens worktrees with fresh shells).</small></span><select class="settings-select" id="optParentCloseMode"><option value="panels">Close panels only</option><option value="close">Full close + re-open worktrees</option></select></label><label class="option"><input type="checkbox" id="optStuckWorkingEnabled"><span>Ignore stuck working agents<small>Dismiss working agents that appear stuck. Clears automatically on status changes and terminal output.</small></span></label><label class="option"><span>Ignore stuck working for<small>Minutes to keep a local dismissed-working override before showing working again.</small></span><input id="optWorkingDismissMinutes" type="number" min="1" max="1440" step="1"></label><label class="option"><input type="checkbox" id="optShowTabActivity"><span>Show panel last update<small>Display local last-change age on top panel tabs. Updates on refreshes, events, and selected terminal output; no timer polling.</small></span></label><label class="option"><span>Workspace sorting<small>Default tree order, shared drag-and-drop order, or attention state priority.</small></span><select class="settings-select" id="optWorkspaceSort"><option value="default">Default</option><option value="drag">Drag&drop</option><option value="state">State</option></select></label><label class="option"><span>Notification scope<small>Choose whether sounds ring in every open tab or only the tab viewing the agent panel.</small></span><select class="settings-select" id="optSoundScope"><option value="current">Current agent tab</option><option value="all">All tabs</option></select></label><label class="option"><input type="checkbox" id="optGenerateWorktreeNames"><span>Generate worktree branch names<small>Allow blank Branch name in Worktrees modal. Herdr generates worktree/&lt;name&gt;.</small></span></label><label class="option"><span>Default worktree directory<small>Relative paths resolve from repo root. Example: ../worktrees.</small></span><input id="optWorktreeDefaultDirectory" placeholder="../worktrees"></label><label class="option"><span>Scroll speed<small><span id="scrollLinesValue">3</span> terminal lines per wheel step.</small></span><input type="range" id="optScrollLines" min="1" max="20" step="1"></label><label class="option"><span>Terminal font<small>CSS font-family for the terminal. Add a Nerd Font family name (for example, JetBrainsMono Nerd Font) so icon glyphs render. Leave blank for the default stack.</small></span><input id="optTerminalFont" placeholder="JetBrainsMono Nerd Font, monospace"></label><label class="option"><span>Worktree autodiscover<small>Seconds to wait after path input stops. Set 0 for immediate.</small></span><input type="number" id="optWorktreeAutoDiscover" min="0" max="30" step="0.5"></label>',
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
      title: "Terminal input",
      desc: "Viewport sizing, scrolling, and keyboard behavior.",
      ids: ["optOverflow", "optFit", "optShiftEnterNewline", "optScrollLines", "optTerminalFont"],
    },
    {
      title: "Agents and alerts",
      desc: "Attention sorting, shortcuts, and notification sound scope.",
      ids: [
        "optSound",
        "optSoundScope",
        "optAgentSortMode",
        "optParentCloseMode",
        "optStuckWorkingEnabled",
        "optWorkingDismissMinutes",
        "optCloseShortcut",
        "optShowTabActivity",
      ],
    },
    {
      title: "Worktrees",
      desc: "Discovery, naming, and default worktree locations.",
      ids: [
        "optWorkspaceSort",
        "optGenerateWorktreeNames",
        "optWorktreeDefaultDirectory",
        "optWorktreeAutoDiscover",
      ],
    },
    {
      title: "Server",
      desc: "Network access and server-side power behavior.",
      blocks: ["optServerBind"],
    },
  ];
  for (const def of sectionDefs) {
    const nodes = [];
    for (const id of def.ids || []) {
      const control = el(id);
      const row = control && control.closest("label.option");
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
function applyOptions() {
  const shell = el("terminalShell");
  if (shell) shell.classList.toggle("no-overflow", !options.overflow);
  const overflow = el("optOverflow"),
    fitOpt = el("optFit"),
    shiftEnterNewline = el("optShiftEnterNewline"),
    sound = el("optSound"),
    themeSelect = el("optTheme"),
    closeShortcut = el("optCloseShortcut"),
    sortAgents = el("optAgentSortMode"),
    parentCloseMode = el("optParentCloseMode"),
    stuckWorkingEnabled = el("optStuckWorkingEnabled"),
    workingDismissMinutes = el("optWorkingDismissMinutes"),
    workspaceSort = el("optWorkspaceSort"),
    soundScope = el("optSoundScope"),
    scrollLines = el("optScrollLines"),
    scrollLinesValue = el("scrollLinesValue"),
    terminalFont = el("optTerminalFont"),
    showTabActivity = el("optShowTabActivity"),
    worktreeAutoDiscover = el("optWorktreeAutoDiscover"),
    generateWorktreeNames = el("optGenerateWorktreeNames"),
    worktreeDefaultDirectory = el("optWorktreeDefaultDirectory"),
    closeShortcutCurrent = el("closeShortcutCurrent");
  if (overflow) overflow.checked = !!options.overflow;
  if (fitOpt) fitOpt.checked = !!options.fitToBrowser;
  if (shiftEnterNewline)
    shiftEnterNewline.checked = options.shiftEnterNewline !== false;
  if (sound) sound.checked = !!options.sound;
  if (themeSelect) themeSelect.value = themeMode;
  if (closeShortcut) closeShortcut.value = options.closeShortcut || "off";
  if (closeShortcutCurrent)
    closeShortcutCurrent.textContent = closeShortcutLabel();
  if (sortAgents) sortAgents.value = options.agentSortMode || "off";
  if (parentCloseMode)
    parentCloseMode.value = options.parentCloseMode || "panels";
  if (stuckWorkingEnabled)
    stuckWorkingEnabled.checked = options.stuckWorkingEnabled !== false;
  if (workingDismissMinutes)
    workingDismissMinutes.value = String(options.workingDismissMinutes || 30);
  if (workspaceSort) workspaceSort.value = options.workspaceSort || "default";
  if (soundScope) soundScope.value = options.soundScope || "current";
  if (scrollLines) scrollLines.value = String(options.scrollLines || 3);
  if (scrollLinesValue)
    scrollLinesValue.textContent = String(options.scrollLines || 3);
  if (terminalFont) terminalFont.value = options.terminalFontFamily || "";
  if (showTabActivity) showTabActivity.checked = !!options.showTabActivity;
  if (worktreeAutoDiscover)
    worktreeAutoDiscover.value = String(
      options.worktreeAutoDiscoverSeconds ?? 3,
    );
  if (generateWorktreeNames)
    generateWorktreeNames.checked = !!options.generateWorktreeNames;
  if (worktreeDefaultDirectory)
    worktreeDefaultDirectory.value = options.worktreeDefaultDirectory || "";
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
      connectTerminal();
    }
  }
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
function applyTerminalFont() {
  if (!term) return;
  const family = resolveTerminalFontFamily(options.terminalFontFamily);
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
  fitTerminalSurface();
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
function setupSessionChrome() {
  const head = document.querySelector(".head");
  if (!el("sessionButton")) {
    const b = document.createElement("button");
    b.className = "mini";
    b.id = "sessionButton";
    b.title = "Session manager";
    b.textContent = "session";
    head.insertBefore(b, el("themeToggle"));
    b.onclick = () =>
      showSessionManager(
        state.backendOnline ? "Session manager" : "Herdr session offline",
      );
  }
  if (!el("openWorktrees")) {
    const newWsButton = el("newWs");
    const b = document.createElement("button");
    b.className = "btn worktree-open-trigger";
    b.id = "openWorktrees";
    b.title = "Open or create worktrees";
    b.textContent = "♧";
    newWsButton.insertAdjacentElement("afterend", b);
    b.onclick = () => openWorktreeOpenModal();
  }
  const side = document.querySelector(".side");
  const versionsEl = el("versions");
  if (versionsEl && !versionsEl.classList.contains("side-footer")) {
    versionsEl.remove();
    versionsEl.classList.add("side-footer");
    side.appendChild(versionsEl);
  }
  if (!el("sessionManager")) {
    const m = document.createElement("div");
    m.className = "session-manager";
    m.id = "sessionManager";
    m.innerHTML =
      '<div class="session-card"><div class="session-hero"><div><h1 id="sessionManagerTitle">Sessions</h1><p id="sessionManagerText">Choose a Herdr backend session to open.</p></div><div class="session-current"><span class="dot unknown"></span><span id="sessionCurrentLabel">default</span></div></div><div class="session-actions"><div class="session-list" id="sessionList"></div><div class="session-line session-new"><span><strong>Target another session</strong><small>Create or open a named target URL. Launch starts backend for current target.</small></span><span class="session-controls"><button class="btn" id="newSessionTarget">New target</button></span></div></div></div>';
    document.querySelector(".main").prepend(m);
    el("newSessionTarget").onclick = () => {
      const name = prompt("session name");
      if (name) goSession(name);
    };
  }
}
async function loadSessions() {
  try {
    const r = await api("/api/sessions");
    state.sessions = r.sessions || [];
  } catch (e) {
    state.sessions = [{ name: state.session || "default", running: false }];
  }
}
function renderSessionRows() {
  const list = state.sessions.length
    ? state.sessions
    : [{ name: state.session || "default", running: state.backendOnline }];
  return list
    .map((s) => {
      const active = s.name === state.session;
      const status = `<span class="status-pill ${s.running ? "running" : "offline"}">${s.running ? "running" : "offline"}</span>`;
      const controls = active
        ? `<span class="session-controls"><button class="btn" onclick="event.stopPropagation();launchBackend()">Launch</button><button class="tab add" onclick="event.stopPropagation();refresh()">Retry</button><button class="tab add" onclick="event.stopPropagation();resetSession()">Reset workspaces</button><button class="mini danger" onclick="event.stopPropagation();closeCurrentSession()">Close</button></span>`
        : `<span class="session-controls">${status}</span>`;
      return `<div class="session-line ${active ? "active" : ""}" onclick="goSession('${escapeAttr(s.name)}')"><span><strong>${escapeHtml(s.name)}</strong><small>${active ? "current browser target" : s.running ? "click to switch to this running session" : "click to target this offline session"}</small></span>${controls}</div>`;
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
      text || `Current target: ${state.session || "default"}`;
  if (current) current.textContent = state.session || "default";
  if (list) list.innerHTML = renderSessionRows();
  if (manager) manager.style.display = "block";
}
function hideSessionManager() {
  const manager = el("sessionManager");
  if (manager) manager.style.display = "none";
}
async function launchBackend() {
  const textEl = el("sessionManagerText");
  if (textEl) textEl.textContent = "Launching Herdr session...";
  try {
    const r = await api("/api/session/launch", { method: "POST" });
    if (textEl)
      textEl.textContent = r.ok
        ? `Launched pid ${r.pid}. Waiting for backend...`
        : r.error || "Launch failed";
    setTimeout(refresh, 1200);
  } catch (e) {
    if (textEl) textEl.textContent = e.message || String(e);
  }
}
async function closeCurrentSession() {
  if (!confirm("Close current Herdr session?")) return;
  try {
    await api("/api/session/close", { method: "POST" });
    showSessionManager(
      "Herdr session closed",
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
    await api("/api/server-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bind,
        username: username || null,
        password: password ? password : null,
        localhost_no_auth: localhostNoAuth,
        no_sleep_auto_cooldown_seconds: noSleepAutoCooldown,
      }),
    });
    if (err)
      err.textContent =
        "Saved. If Bind changed, listener is restarting; reload this page using the new address if needed.";
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
    const session = v.session || state.session || "default";
    const compat = v.compatibility || {},
      status =
        compat.status && compat.status !== "compatible"
          ? " · " + compat.status
          : "";
    if (versionsEl) {
      versionsEl.textContent = `session ${session} · webui ${v.webui || "-"} · backend ${v.backend || "offline"}${status}`;
      versionsEl.title = compat.message || "";
    }
    const button = el("sessionButton");
    if (button) button.textContent = state.session || session;
  } catch (e) {
    if (versionsEl) versionsEl.textContent = "webui - · backend offline";
  }
}
function sessionPrefix() {
  return "/session/" + encodeURIComponent(state.session || "default");
}
function expandScopedId(ws, id) {
  if (!ws || !id) return id || null;
  return `${ws}:${id}`;
}
function compactScopedId(ws, id) {
  if (!ws || !id) return id || null;
  const prefix = `${ws}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
function selectionPath(ws, tab, pane) {
  let p = sessionPrefix() + "/workspace/" + encodeURIComponent(ws);
  if (tab) p += "/tab/" + encodeURIComponent(compactScopedId(ws, tab));
  if (pane) p += "/pane/" + encodeURIComponent(compactScopedId(ws, pane));
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
  state.tab = p[i + 2] === "tab" ? expandScopedId(state.ws, p[i + 3]) : null;
  state.pane = p[i + 4] === "pane" ? expandScopedId(state.ws, p[i + 5]) : null;
}
function setTerminalLoading(show) {
  const loading = el("terminalLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function resetTerminalConnection(clear = false) {
  wheelScrollRemainder = 0;
  if (inputFlushTimer) {
    clearTimeout(inputFlushTimer);
    inputFlushTimer = null;
  }
  inputQueue = [];
  if (termWs) {
    termWs.onclose = null;
    try {
      termWs.close();
    } catch (e) {}
    termWs = null;
  }
  connectedTerminalId = null;
  connectedSize = "";
  if (clear && term) term.clear();
}
function navigateSelection(e, ws, tab, pane) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1))
    return true;
  e.preventDefault();
  go(ws, tab, pane);
  return false;
}
function go(ws, tab, pane) {
  history.pushState(null, "", selectionPath(ws, tab, pane));
  parseRoute();
  resetTerminalConnection(true);
  setTerminalLoading(true);
  refresh();
}
function goSession(name) {
  state.session = name || "default";
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
  const w = await api("/api/workspaces");
  if (seq !== refreshSeq) return;
  state.workspaces = w.result.workspaces || [];
  if (state.workspaces.length === 0 && !creatingDefaultWorkspace) {
    creatingDefaultWorkspace = true;
    try {
      const r = await api("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "default", cwd: null }),
      });
      if (seq !== refreshSeq) return;
      state.ws = r.result.workspace.workspace_id;
      state.fitDefault = true;
      history.replaceState(null, "", selectionPath(state.ws));
      creatingDefaultWorkspace = false;
      return refresh();
    } catch (e) {
      creatingDefaultWorkspace = false;
    }
  }
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
  if (!state.ws && state.workspaces[0])
    state.ws = state.workspaces[0].workspace_id;
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
    if (!state.panes.some((p) => p.pane_id === state.pane)) {
      const pane =
        state.panes.find((x) => x.tab_id === state.tab && x.focused) ||
        state.panes.find((x) => x.tab_id === state.tab) ||
        state.panes[0];
      state.pane = pane && pane.pane_id;
    }
    const pane = state.panes.find((x) => x.pane_id === state.pane);
    state.terminalId = pane && pane.terminal_id;
    state.termCols = null;
    state.termRows = null;
    state.layoutCols = null;
    state.layoutRows = null;
    state.layoutPaneCount = 0;
    if (state.pane) {
      try {
        const l = await api(
          "/api/pane-layout?pane_id=" + encodeURIComponent(state.pane),
        );
        if (seq !== refreshSeq) return;
        const layout = (l.result || {}).layout || {},
          lp = layout.panes || [];
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
      } catch (e) {}
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
  connectTerminal();
}
async function refresh() {
  const seq = ++refreshSeq;
  try {
    await refreshOnline(seq);
    if (seq !== refreshSeq) return;
    state.backendOnline = true;
    hideSessionManager();
    const button = el("sessionButton");
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
    const button = el("sessionButton");
    if (button) button.textContent = (state.session || "default") + " offline";
  }
}
function scheduleRefresh(delay = 500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}
function eventNeedsFastRefresh(kind) {
  return FAST_REFRESH_EVENTS.has(kind);
}
function forgetClosedSelection(kind, data) {
  if (kind === "pane.closed" || kind === "pane.exited") {
    if (data && data.pane_id && data.pane_id === state.pane) {
      resetTerminalConnection(true);
      state.pane = null;
      state.terminalId = null;
      render();
    }
  } else if (kind === "tab.closed") {
    if (data && data.tab_id && data.tab_id === state.tab) {
      resetTerminalConnection(true);
      state.tab = null;
      state.pane = null;
      state.terminalId = null;
      render();
    }
  }
}
function applySnapshot(msg) {
  const wr = msg.workspaces && msg.workspaces.result;
  const ar = msg.agents && msg.agents.result;
  if (wr && wr.workspaces) state.workspaces = wr.workspaces;
  if (ar && ar.agents) {
    state.agents = ar.agents;
    handleAttentionSound();
  }
  render();
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
  g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.24);
}
function tabTitle(t) {
  return t.label || `tab ${t.number}`;
}
function render() {
  cleanupWorkingDismissals();
  updateTabActivity();
  const wsById = Object.fromEntries(
    state.workspaces.map((w) => [w.workspace_id, w]),
  );
  const tabById = Object.fromEntries(
    state.allTabs.concat(state.tabs).map((t) => [t.tab_id, t]),
  );
  const panesByTab = new Map();
  for (const pane of state.panes) {
    const panes = panesByTab.get(pane.tab_id) || [];
    panes.push(pane);
    panesByTab.set(pane.tab_id, panes);
  }
  const tabCountsByWorkspace = new Map();
  for (const tab of state.allTabs)
    tabCountsByWorkspace.set(
      tab.workspace_id,
      (tabCountsByWorkspace.get(tab.workspace_id) || 0) + 1,
    );
  const workspacesHtml = renderSpaces();
  if (workspacesHtml !== lastWorkspacesHtml) {
    workspaces.innerHTML = workspacesHtml;
    lastWorkspacesHtml = workspacesHtml;
  }
  const agentsHtml = renderAgents(wsById, tabById, tabCountsByWorkspace);
  if (agentsHtml !== lastAgentsHtml) {
    agents.innerHTML = agentsHtml;
    lastAgentsHtml = agentsHtml;
  }
  applySidebarCollapsed();
  const pane = state.panes.find((p) => p.pane_id === state.pane);
  const themeIcon =
    themeMode === "auto" ? "A" : themeMode === "dark" ? "☾" : "☀";
  const sessionLabel = escapeHtml(state.session || "default");
  const tabsTools = `<div class="tabs-tools"><button class="mini" id="sessionButtonTabs" title="Session manager" onclick="showSessionManager(state.backendOnline?'Session manager':'Herdr session offline')">${sessionLabel}</button><button class="mini" id="themeToggleTabs" title="Toggle theme" onclick="themeMode=themeMode==='auto'?'dark':(themeMode==='dark'?'light':'auto');applyTheme();render()">${themeIcon}</button>${noSleepControlHtml()}<button class="mini" title="Shortcuts" onclick="applyOptions();el('shortcutsModal').style.display='grid'">?</button><button class="mini" title="Settings" onclick="el('settingsModal').style.display='grid';applyOptions();loadServerSettings()">⚙</button></div>`;
  const tabsHtml =
    state.tabs.map((t) => renderTabButton(t, panesByTab)).join("") +
    (state.ws
      ? `<button class="tab add" title="New panel" onclick="newTab()">+</button>`
      : "") +
    tabsTools;
  if (tabsHtml !== lastTabsHtml) {
    tabs.innerHTML = tabsHtml;
    lastTabsHtml = tabsHtml;
    syncNoSleepControls();
  }
  updateTitle(wsById, tabById, tabCountsByWorkspace, pane);
  if (state.editingTab) {
    const input = document.querySelector(".tab-rename-input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }
  if (state.editingWorkspace) {
    const input = document.querySelector(".workspace-rename-input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }
  fitTerminalShell();
}
function updateTitle(wsById, tabById, tabCountsByWorkspace, pane) {
  const w = wsById[state.ws];
  const t = tabById[state.tab];
  const workspace = w
    ? w.worktree
      ? worktreeDisplayName(w)
      : w.label
    : state.ws || state.session || "herdr";
  const panel = t
    ? agentTabLabel(state.ws, t, tabCountsByWorkspace)
    : pane
      ? pane.pane_id
      : "panel";
  document.title = `${workspace} • ${panel}`;
}
function tabActivityKey(workspaceId, tabId) {
  return `${state.session || "default"}|${workspaceId || ""}|${tabId || ""}`;
}
function tabActivitySignature(t) {
  const panes = state.panes
    .filter((p) => p.tab_id === t.tab_id)
    .map((p) => [p.pane_id, p.terminal_id, !!p.focused]);
  const agents = state.agents
    .filter((a) => a.workspace_id === t.workspace_id && a.tab_id === t.tab_id)
    .map((a) => [
      a.pane_id,
      a.terminal_id,
      a.name || a.display_agent || a.agent || "",
      statusClass(a.agent_status),
    ]);
  return JSON.stringify([
    t.workspace_id,
    t.tab_id,
    t.label || "",
    t.number || 0,
    !!t.focused,
    panes,
    agents,
  ]);
}
function updateTabActivity() {
  const now = Date.now(),
    seen = new Set();
  for (const t of state.allTabs.concat(state.tabs)) {
    const key = tabActivityKey(t.workspace_id, t.tab_id),
      signature = tabActivitySignature(t),
      current = tabActivity[key];
    seen.add(key);
    if (!current || current.signature !== signature)
      tabActivity[key] = { signature, updatedAt: now };
  }
  for (const key of Object.keys(tabActivity)) {
    if (key.startsWith(`${state.session || "default"}|`) && !seen.has(key))
      delete tabActivity[key];
  }
}
function tabHoverInfo(t, panesByTab) {
  const panes = panesByTab.get(t.tab_id) || [];
  const pane = panes.find((p) => p.pane_id === state.pane) || panes[0];
  if (!pane) return tabTitle(t);
  const size =
    t.tab_id === state.tab && state.termCols && state.termRows
      ? ` · ${state.termCols}x${state.termRows}`
      : "";
  return `${tabTitle(t)} · ${pane.pane_id} · ${pane.terminal_id}${size}`;
}
function renderTabButton(t, panesByTab) {
  if (state.editingTab === t.tab_id)
    return `<span class="tab ${t.tab_id === state.tab ? "active" : ""}"><input class="tab-rename-input" value="${escapeAttr(state.editingTabValue)}" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${t.tab_id}')"></span>`;
  const activity = tabActivity[tabActivityKey(t.workspace_id, t.tab_id)],
    activityLabel =
      options.showTabActivity && activity
        ? tabActivityLabel(activity.updatedAt, Date.now())
        : "";
  return `<a class="tab ${t.tab_id === state.tab ? "active" : ""}" title="${escapeAttr(tabHoverInfo(t, panesByTab))}" href="${escapeAttr(selectionPath(t.workspace_id, t.tab_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${t.workspace_id}','${t.tab_id}')" ondblclick="event.preventDefault();event.stopPropagation();startTabRename('${t.tab_id}','${escapeAttr(tabTitle(t))}')"><span class="tab-label">${escapeHtml(tabTitle(t))}</span>${activityLabel ? `<span class="tab-activity">${escapeHtml(activityLabel)}</span>` : ""}<span class="tab-actions"><span class="mini warn" title="Close panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${t.tab_id}')">✕</span></span></a>`;
}
function renderSpaces() {
  const groups = new Map(),
    usedParents = new Set(),
    linkedIds = new Set();
  for (const w of state.workspaces) {
    if (!isLinkedWorktree(w)) continue;
    const k = worktreeGroupKey(w);
    linkedIds.add(w.workspace_id);
    if (!groups.has(k))
      groups.set(k, {
        type: "group",
        key: k,
        label: w.worktree.repo_name || w.label,
        children: [],
        parent: null,
      });
    groups.get(k).children.push(w);
  }
  for (const g of groups.values()) {
    g.parent = findWorktreeParent(g);
    if (g.parent) usedParents.add(g.parent.workspace_id);
  }
  let items = [];
  for (const w of state.workspaces) {
    if (linkedIds.has(w.workspace_id) || usedParents.has(w.workspace_id))
      continue;
    items.push({ type: "single", workspace: w });
  }
  for (const g of groups.values()) items.push(g);
  items = sortWorkspaceItems(items);
  let html = "";
  for (const item of items) {
    if (item.type === "single") {
      html += renderWorkspaceCard(item.workspace, "");
      continue;
    }
    const children = sortGroupChildren(item.children);
    html += renderRepoHeader(item);
    if (item.parent)
      html += renderWorkspaceCard(item.parent, "workspace-group-main");
    html += children
      .map((w, i) =>
        renderWorkspaceCard(
          w,
          "workspace-child " + (i === children.length - 1 ? "last" : ""),
        ),
      )
      .join("");
  }
  return html;
}
function renderRepoHeader(group) {
  const actions = [],
    keyToken = encodeURIComponent(group.key);
  actions.push(
    group.parent
      ? `<span class="mini tree" title="Create worktree" onclick="event.preventDefault();event.stopPropagation();openWorktreeCreateModal('${group.parent.workspace_id}')">♧+</span>`
      : `<span class="mini tree" title="Create worktree" onclick="event.preventDefault();event.stopPropagation();openWorktreesForRepo('${keyToken}')">♧+</span>`,
  );
  if (repoHasUnopenedWorktrees(group))
    actions.push(
      `<span class="mini tree" title="Open worktree" onclick="event.preventDefault();event.stopPropagation();openWorktreesForRepo('${keyToken}')">↗</span>`,
    );
  return `<div class="repo-header workspace-orphan-header ${actions.length ? "with-actions" : ""}"><span>${escapeHtml(group.label)}</span>${actions.length ? `<span class="repo-actions">${actions.join("")}</span>` : ""}</div>`;
}
function workspaceItemIds(item) {
  return item.type === "single"
    ? [item.workspace.workspace_id]
    : [
        (item.parent && item.parent.workspace_id) || "",
        ...item.children.map((w) => w.workspace_id),
      ].filter(Boolean);
}
function workspaceOrderIndex(id) {
  const i = state.workspaceOrder.indexOf(id);
  return i < 0 ? 999999 : i;
}
function workspaceItemOrder(item) {
  return Math.min(...workspaceItemIds(item).map(workspaceOrderIndex));
}
function workspacePriority(w) {
  return (
    { blocked: 0, done: 1, unknown: 2, idle: 3, working: 4 }[
      statusClass(w.agent_status)
    ] ?? 2
  );
}
function workspaceItemPriority(item) {
  const all =
    item.type === "single"
      ? [item.workspace]
      : [item.parent, ...item.children].filter(Boolean);
  return Math.min(...all.map(workspacePriority));
}
function sortWorkspaceItems(items) {
  if (options.workspaceSort === "state")
    return items
      .slice()
      .sort((a, b) => workspaceItemPriority(a) - workspaceItemPriority(b));
  if (options.workspaceSort === "drag")
    return items
      .slice()
      .sort((a, b) => workspaceItemOrder(a) - workspaceItemOrder(b));
  return items;
}
function sortGroupChildren(children) {
  if (options.workspaceSort === "state")
    return children
      .slice()
      .sort((a, b) => workspacePriority(a) - workspacePriority(b));
  if (options.workspaceSort === "drag")
    return children
      .slice()
      .sort(
        (a, b) =>
          workspaceOrderIndex(a.workspace_id) -
          workspaceOrderIndex(b.workspace_id),
      );
  return children;
}
function renderWorkspaceCard(w, extraClass) {
  const editing = state.editingWorkspace === w.workspace_id;
  const label = editing
    ? `<input class="workspace-rename-input" value="${escapeAttr(state.editingWorkspaceValue)}" oninput="state.editingWorkspaceValue=this.value" onkeydown="workspaceRenameKey(event,'${w.workspace_id}')">`
    : `<span class="label">${escapeHtml(w.label)}</span>`;
  const linked = isLinkedWorktree(w);
  const worktreeAction = linked
    ? `<span class="mini danger" title="Remove worktree from disk" onclick="event.preventDefault();event.stopPropagation();removeWorktree('${w.workspace_id}')">🗑</span>`
    : `<span class="mini tree" title="Create worktree" onclick="event.preventDefault();event.stopPropagation();openWorktreeCreateModal('${w.workspace_id}')">♧+</span>`;
  const closeTitle = linked ? "Close worktree" : "Close workspace";
  const drag =
    options.workspaceSort === "drag"
      ? ' draggable="true" ondragstart="workspaceDragStart(event,\'' +
        w.workspace_id +
        "')\" ondragover=\"workspaceDragOver(event,'" +
        w.workspace_id +
        '\')" ondragleave="workspaceDragLeave(event)" ondrop="workspaceDrop(event,\'' +
        w.workspace_id +
        '\')" ondragend="workspaceDragEnd(event)"'
      : "";
  return `<a class="item ${w.workspace_id === state.ws ? "active" : ""} ${extraClass || ""}" data-workspace-id="${escapeAttr(w.workspace_id)}" href="${escapeAttr(selectionPath(w.workspace_id))}" target="herdr-selection"${drag} onclick="if(state.editingWorkspace){event.preventDefault();return false}return navigateSelection(event,'${w.workspace_id}')" ondblclick="event.preventDefault();event.stopPropagation();startWorkspaceRename('${w.workspace_id}','${escapeAttr(w.label)}')"><div class="space-title"><span>${statusDot(w.agent_status)}</span>${label}<span class="space-actions">${worktreeAction}<span class="mini warn" title="${closeTitle}" onclick="event.preventDefault();event.stopPropagation();closeWorkspace('${w.workspace_id}')">✕</span></span></div><div class="muted">${spaceMeta(w)}</div></a>`;
}
function spaceMeta(w) {
  const wt = worktreeForWorkspace(w);
  const parts = [`${w.pane_count} panes`];
  const branch =
    (wt && (wt.branch || (wt.is_detached ? "detached" : ""))) ||
    state.workspaceBranches[w.workspace_id];
  if (branch)
    parts.push(`<span class="chip branch">${escapeHtml(branch)}</span>`);
  return parts.join(" ");
}
function isLinkedWorktree(w) {
  return !!(w && w.worktree && w.worktree.is_linked_worktree);
}
function worktreeSourceWorkspaceIds() {
  const idsByKey = new Map();
  for (const w of state.workspaces) {
    if (!w || !w.workspace_id) continue;
    const key = worktreeGroupKey(w) || `workspace:${w.workspace_id}`;
    if (!idsByKey.has(key) || (w.worktree && !w.worktree.is_linked_worktree))
      idsByKey.set(key, w.workspace_id);
  }
  return [...idsByKey.values()];
}
function worktreeGroupKey(w) {
  return (
    (w &&
      w.worktree &&
      (w.worktree.repo_key || w.worktree.repo_root || w.worktree.repo_name)) ||
    ""
  );
}
function worktreeRowGroupKey(w) {
  return (
    (w && (w.source_repo_key || w.source_repo_root || w.source_repo_name)) || ""
  );
}
function repoRowsForGroup(group) {
  return state.worktrees.filter(
    (w) => w.is_linked_worktree && worktreeRowGroupKey(w) === group.key,
  );
}
function repoHasUnopenedWorktrees(group) {
  return repoRowsForGroup(group).some((w) => !w.open_workspace_id);
}
function findWorktreeParent(group) {
  return (
    state.workspaces.find(
      (w) =>
        w.worktree &&
        !w.worktree.is_linked_worktree &&
        worktreeGroupKey(w) ===
          (group.children[0] ? worktreeGroupKey(group.children[0]) : ""),
    ) ||
    state.workspaces.find((w) => !w.worktree && w.label === group.label) ||
    null
  );
}
function worktreeForWorkspace(w) {
  if (!w.worktree) return null;
  return (
    state.worktrees.find((t) => t.open_workspace_id === w.workspace_id) ||
    state.worktrees.find((t) => samePath(t.path, w.worktree.checkout_path)) ||
    null
  );
}
function samePath(a, b) {
  return (
    String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "")
  );
}
function renderAgents(wsById, tabById, tabCountsByWorkspace) {
  const list = state.agents.slice();
  if (options.agentSortMode !== "off")
    list.sort(agentAttentionCompare);
  return list
    .map((a) => renderAgentRow(a, wsById, tabById, tabCountsByWorkspace))
    .join("");
}
function agentAttentionCompare(a, b) {
  const aRank = agentAttentionRank(a),
    bRank = agentAttentionRank(b);
  return aRank - bRank;
}
function agentAttentionRank(a) {
  const status = statusClass(a.agent_status);
  if (status === "blocked") return 0;
  if (options.agentSortMode === "attention_inverted") {
    if (isWorkingDismissed(a)) return 2;
    return { working: 1, unknown: 3, done: 4, idle: 5 }[status] ?? 3;
  }
  if (isWorkingDismissed(a)) return 4;
  return { idle: 1, done: 2, unknown: 3, working: 5 }[status] ?? 3;
}
function agentToken(cls, value) {
  const s = String(value || "");
  return `<span class="agent-token ${cls}" title="${escapeAttr(s)}">${escapeHtml(s)}</span>`;
}
function renderAgentRow(a, wsById, tabById, tabCountsByWorkspace) {
  const w = wsById[a.workspace_id];
  const repo = w && w.worktree ? parentWorkspaceName(w, wsById) : null;
  const worktree =
    w && w.worktree ? worktreeDisplayName(w) : w ? w.label : a.workspace_id;
  const t = tabById[a.tab_id];
  const tab = agentTabLabel(a.workspace_id, t, tabCountsByWorkspace);
  const fullTitle =
    (repo ? `${repo} › ${worktree}` : worktree) + (tab ? ` › ${tab}` : "");
  const titleParts = repo
    ? [
        agentToken("agent-repo", repo),
        `<span class="agent-sep">›</span>`,
        agentToken("agent-worktree", worktree),
      ]
    : [agentToken("agent-worktree", worktree)];
  if (tab)
    titleParts.push(
      `<span class="agent-sep">›</span>${agentToken("agent-panel", tab)}`,
    );
  const label = a.name || a.display_agent || a.agent || a.terminal_id;
  const status = statusClass(a.agent_status);
  const dismissed = isWorkingDismissed(a);
  const displayStatus = dismissed ? "ignored" : status;
  const action =
    status === "working" && options.stuckWorkingEnabled
      ? dismissed
        ? `<span class="mini agent-action" title="Show this working agent again" onclick="event.preventDefault();event.stopPropagation();restoreWorkingAgent('${a.workspace_id}','${a.tab_id}','${a.pane_id}','${a.terminal_id || ""}')">Undo</span>`
        : `<span class="mini agent-action" title="Locally ignore this stuck working state" onclick="event.preventDefault();event.stopPropagation();dismissWorkingAgent('${a.workspace_id}','${a.tab_id}','${a.pane_id}','${a.terminal_id || ""}')">Dismiss</span>`
      : "";
  const active =
    a.workspace_id === state.ws &&
    a.tab_id === state.tab &&
    a.pane_id === state.pane;
  return `<a class="item ${active ? "active" : ""} ${dismissed ? "agent-dismissed" : ""}" title="${escapeAttr(fullTitle)}" href="${escapeAttr(selectionPath(a.workspace_id, a.tab_id, a.pane_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${a.workspace_id}','${a.tab_id}','${a.pane_id}')"><div class="agent-title">${statusMark(displayStatus, status === "blocked")}${titleParts.join("")}</div><div class="agent-meta"><span class="agent-status ${displayStatus}">${escapeHtml(displayStatus)}</span><span>•</span><span class="agent-name">${escapeHtml(label)}</span>${action}</div></a>`;
}
function agentTabLabel(wsId, t, tabCountsByWorkspace) {
  if (!t) return "";
  const count = tabCountsByWorkspace.get(wsId) || 0;
  return count > 1 || t.label ? tabTitle(t) : "";
}
function pathBasename(path) {
  const parts = String(path || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
function worktreeDisplayName(w) {
  if (!w) return "worktree";
  const wt = worktreeForWorkspace(w);
  return (
    pathBasename((wt && wt.path) || (w.worktree && w.worktree.checkout_path)) ||
    (wt && wt.label) ||
    w.label
  );
}
function parentWorkspaceName(w, wsById) {
  if (!w || !w.worktree) return "workspace";
  const key =
    w.worktree.repo_key || w.worktree.repo_root || w.worktree.repo_name;
  const match =
    Object.values(wsById).find(
      (x) =>
        x.workspace_id !== w.workspace_id &&
        x.worktree &&
        (x.worktree.repo_key ||
          x.worktree.repo_root ||
          x.worktree.repo_name) === key &&
        !x.worktree.is_linked_worktree,
    ) ||
    Object.values(wsById).find(
      (x) =>
        x.workspace_id !== w.workspace_id &&
        !x.worktree &&
        x.label === w.worktree.repo_name,
    );
  return match ? match.label : w.worktree.repo_name;
}
function connectEvents() {
  if (document.hidden || eventWs) return;
  const eventSession = state.session;
  const ws = new WebSocket(wsUrl("/ws/events"));
  eventWs = ws;
  ws.onmessage = (e) => {
    if (eventWs !== ws || eventSession !== state.session) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      scheduleRefresh();
      return;
    }
    if (msg.type === "snapshot") applySnapshot(msg);
    else if (msg.type === "event") {
      const evt = msg.event || {},
        kind = evt.event || evt.type,
        data = evt.data || {};
      if (kind === "pane.agent_status_changed") {
        const d = data;
        if (statusClass(d.agent_status) !== "working") {
          for (const agent of state.agents) {
            if (
              agent.pane_id === d.pane_id &&
              agent.workspace_id === d.workspace_id
            ) {
              const key = agentOverrideKey(agent);
              if (workingDismissals[key]) {
                delete workingDismissals[key];
                saveWorkingDismissals();
              }
            }
          }
        }
      }
      forgetClosedSelection(kind, data);
      scheduleRefresh(eventNeedsFastRefresh(kind) ? 50 : 500);
    }
  };
  ws.onclose = () => {
    if (eventWs === ws) eventWs = null;
    if (!document.hidden && eventSession === state.session)
      setTimeout(connectEvents, 1500);
  };
}
function connectTerminal() {
  if (document.hidden) return;
  if (!state.terminalId) {
    resetTerminalConnection(true);
    setTerminalLoading(false);
    return;
  }
  fitTerminalShell();
  const cols = state.termCols || 100,
    rows = state.termRows || 30,
    size = `${cols}x${rows}`;
  const target = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}`;
  if (
    termWs &&
    termWs.readyState === 1 &&
    connectedTerminalId === target &&
    connectedSize === size
  ) {
    setTerminalLoading(false);
    fitTerminalSurface();
    focusTerminal();
    return;
  }
  resetTerminalConnection(true);
  setTerminalLoading(true);
  connectedTerminalId = target;
  connectedSize = size;
  if (!term) {
    term = new Terminal({
      convertEol: false,
      fontFamily: resolveTerminalFontFamily(options.terminalFontFamily),
      theme: terminalTheme(),
      scrollback: 10000,
    });
    term.open(terminal);
    applyTheme();
    term.onData(sendInputData);
    if (term.attachCustomKeyEventHandler)
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && handleCloseShortcut(e)) return false;
        if (
          options.shiftEnterNewline !== false &&
          e.type === "keydown" &&
          e.key === "Enter" &&
          e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          pasteToTerminal(shiftEnterSequence());
          return false;
        }
        if (
          e.type === "keydown" &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "PageUp" || e.key === "PageDown")
        ) {
          sendBackendScroll(
            e.key === "PageUp" ? "up" : "down",
            Math.max(1, (state.termRows || rows) - 1),
          );
          return false;
        }
        return true;
      });
  }
  if (!termScrollBound) {
    el("terminalShell").addEventListener(
      "wheel",
      (e) => {
        if (wheelOnShellScrollbar(e)) return;
        if (e.altKey) {
          e.preventDefault();
          scrollBrowserOverflow(e.deltaX, e.deltaY);
          return;
        }
        if (!termWs || termWs.readyState !== 1) return;
        e.preventDefault();
        const delta =
          Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const scroll = terminalWheelScrollBatch(
          wheelScrollRemainder,
          delta,
          e.deltaMode,
          options.scrollLines,
          state.termRows || rows,
        );
        wheelScrollRemainder = scroll.remainder;
        if (!scroll.lines) return;
        sendBackendScroll(
          scroll.direction,
          scroll.lines,
          mouseCell(e),
          mouseModifiers(e),
        );
      },
      { passive: false },
    );
    el("terminalShell").addEventListener(
      "paste",
      (e) => {
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteToTerminal(text);
      },
      true,
    );
    el("terminalShell").addEventListener(
      "keydown",
      (e) => {
        if (
          options.shiftEnterNewline !== false &&
          e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "Enter" || e.code === "Enter" || e.keyCode === 13)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendInputData(shiftEnterSequence());
        }
      },
      true,
    );
    el("terminalShell").addEventListener("mousedown", () =>
      setTimeout(focusTerminal, 0),
    );
    termScrollBound = true;
  }
  try {
    term.resize(cols, rows);
    fitTerminalSurface();
  } catch (e) {}
  const ws = new WebSocket(
    wsUrl(
      `/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${cols}&rows=${rows}`,
    ),
  );
  termWs = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    if (termWs === ws) focusTerminal();
  };
  ws.onmessage = (e) => {
    if (termWs !== ws || connectedTerminalId !== target) return;
    setTerminalLoading(false);
    if (typeof e.data === "string") term.write(e.data);
    else term.write(new Uint8Array(e.data));
    clearDismissedWorkingForTerminal(state.terminalId);
    scheduleTerminalFrameWork();
  };
  ws.onclose = () => {
    if (termWs === ws) {
      termWs = null;
      connectedTerminalId = null;
      connectedSize = "";
      setTerminalLoading(false);
      scheduleRefresh();
    }
  };
}
function modalOpen() {
  return [
    "settingsModal",
    "workspaceCreateModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "shortcutsModal",
  ].some((id) => {
    const m = el(id);
    return m && m.style.display && m.style.display !== "none";
  });
}
function preserveActiveElementFocus() {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active.isContentEditable) return true;
  return !!active.closest("input, select, textarea, button, [role='button']");
}
function focusTerminal() {
  if (
    state.editingTab ||
    state.editingWorkspace ||
    modalOpen() ||
    preserveActiveElementFocus() ||
    !term
  )
    return;
  try {
    term.focus();
  } catch (e) {}
}
function scheduleTerminalFrameWork() {
  if (Date.now() < pasteFrameUntil) return;
  if (terminalFramePending) return;
  terminalFramePending = true;
  requestAnimationFrame(() => {
    terminalFramePending = false;
    fitTerminalShell();
    fitTerminalSurface();
    focusTerminal();
  });
}
function sendBackendScroll(direction, lines, cell, modifiers = 0) {
  if (termWs && termWs.readyState === 1)
    termWs.send(
      JSON.stringify({
        type: "scroll",
        direction,
        lines,
        column: cell && cell.column,
        row: cell && cell.row,
        modifiers,
      }),
    );
}
function mouseCell(e) {
  const screen = terminal.querySelector(".xterm-screen");
  const rowsEl = terminal.querySelector(".xterm-rows");
  if (!screen || !rowsEl) return null;
  const rect = screen.getBoundingClientRect();
  if (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  )
    return null;
  const colWidth = rect.width / (state.termCols || 100);
  const rowHeight = rect.height / (state.termRows || 30);
  if (!colWidth || !rowHeight) return null;
  return {
    column: Math.max(
      0,
      Math.min(
        (state.termCols || 100) - 1,
        Math.floor((e.clientX - rect.left) / colWidth),
      ),
    ),
    row: Math.max(
      0,
      Math.min(
        (state.termRows || 30) - 1,
        Math.floor((e.clientY - rect.top) / rowHeight),
      ),
    ),
  };
}
function mouseModifiers(e) {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
}
async function copySelection() {
  const text = term && term.getSelection ? term.getSelection() : "";
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  hideClipboardMenu();
  return true;
}
async function pasteClipboard() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    text = prompt("Paste text") || "";
  }
  if (text) pasteToTerminal(text);
  hideClipboardMenu();
}
function sendInputData(data) {
  if (!termWs || termWs.readyState !== 1 || !data) return;
  const bytes = inputEncoder.encode(data);
  const chunkSize = 2048;
  if (
    bytes.length <= chunkSize &&
    inputQueue.length === 0 &&
    termWs.bufferedAmount < 65536
  ) {
    termWs.send(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i += chunkSize)
    inputQueue.push(bytes.slice(i, i + chunkSize));
  scheduleInputFlush();
}
function scheduleInputFlush() {
  if (inputFlushTimer) return;
  inputFlushTimer = setTimeout(flushInputQueue, 4);
}
function flushInputQueue() {
  inputFlushTimer = null;
  if (!termWs || termWs.readyState !== 1) {
    inputQueue = [];
    return;
  }
  while (inputQueue.length && termWs.bufferedAmount < 65536)
    termWs.send(inputQueue.shift());
  if (inputQueue.length) scheduleInputFlush();
}
function finishPasteFrameSoon() {
  setTimeout(() => {
    pasteFrameUntil = 0;
    scheduleTerminalFrameWork();
  }, 250);
}
function pasteToTerminal(text) {
  if (!termWs || termWs.readyState !== 1 || !text) return;
  const input = terminalPasteInput(
    text,
    !!(term && term.modes && term.modes.bracketedPasteMode),
  );
  const bytes = inputEncoder.encode(input);
  pasteFrameUntil = Date.now() + 250;
  if (
    bytes.length <= 32 * 1024 * 1024 &&
    inputQueue.length === 0 &&
    termWs.bufferedAmount < 1024 * 1024
  ) {
    termWs.send(bytes);
    finishPasteFrameSoon();
    return;
  }
  sendInputData(input);
  finishPasteFrameSoon();
}
function showClipboardMenu(x, y) {
  const menu = el("clipboardMenu");
  if (!menu) return;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.display = "block";
}
function hideClipboardMenu() {
  const menu = el("clipboardMenu");
  if (menu) menu.style.display = "none";
}
function fitTerminalSurface() {
  const x = terminal.querySelector(".xterm");
  const screen = terminal.querySelector(".xterm-screen");
  const viewport = terminal.querySelector(".xterm-viewport");
  const rowsEl = terminal.querySelector(".xterm-rows");
  const helper = terminal.querySelector(".xterm-helper-textarea");
  if (!x || !screen) return;
  const cols = state.termCols || 100,
    rows = state.termRows || 30;
  const dims =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell;
  const firstRow = rowsEl && rowsEl.firstElementChild;
  const cellWidth =
    (dims && dims.width) ||
    (firstRow && firstRow.getBoundingClientRect().width) / cols ||
    9;
  const rowHeight =
    (dims && dims.height) ||
    (firstRow && firstRow.getBoundingClientRect().height) ||
    17;
  const width = Math.ceil(cellWidth * cols);
  const height = Math.ceil(rowHeight * rows);
  terminal.style.width = width + "px";
  terminal.style.height = height + "px";
  terminal.style.minWidth = width + "px";
  terminal.style.minHeight = height + "px";
  x.style.width = width + "px";
  x.style.height = height + "px";
  x.style.minWidth = width + "px";
  x.style.minHeight = height + "px";
  screen.style.width = width + "px";
  screen.style.height = height + "px";
  if (viewport) viewport.style.height = height + "px";
  if (rowsEl) {
    rowsEl.style.width = width + "px";
    rowsEl.style.height = height + "px";
  }
  if (helper) {
    helper.style.width = width + "px";
    helper.style.height = height + "px";
  }
}
function fitTerminalShell() {
  const main = document.querySelector(".main");
  const tabsEl = document.querySelector(".tabs");
  const shell = el("terminalShell");
  if (!main || !tabsEl || !shell) return;
  const m = main.getBoundingClientRect();
  const t = tabsEl.getBoundingClientRect();
  shell.style.width = Math.max(0, Math.floor(m.width)) + "px";
  shell.style.height = Math.max(0, Math.floor(m.height - t.height)) + "px";
}
function browserTerminalSize() {
  fitTerminalShell();
  const shell = el("terminalShell");
  if (!shell) return null;
  const width = Math.max(80, shell.clientWidth - 16);
  const height = Math.max(24, shell.clientHeight - 16);
  const dims =
    term &&
    term._core &&
    term._core._renderService &&
    term._core._renderService.dimensions &&
    term._core._renderService.dimensions.css &&
    term._core._renderService.dimensions.css.cell;
  const cellWidth = (dims && dims.width) || 9;
  const cellHeight = (dims && dims.height) || 17;
  return {
    cols: Math.max(80, Math.floor(width / cellWidth)),
    rows: Math.max(24, Math.floor(height / cellHeight)),
  };
}
function shouldFitFocusedWebTerminal() {
  return !document.hidden && (!document.hasFocus || document.hasFocus());
}
function shouldAutoFitDetachedTerminal() {
  if (options.fitToBrowser) return false;
  const fit = browserTerminalSize();
  if (!fit) return false;
  const singlePane = (state.layoutPaneCount || 1) === 1;
  return (
    singlePane &&
    state.layoutCols === state.termCols &&
    state.layoutRows === state.termRows &&
    (fit.cols > state.termCols || fit.rows > state.termRows)
  );
}
function fitFocusedTerminal() {
  if (!state.terminalId || !shouldFitFocusedWebTerminal()) return;
  const fit = browserTerminalSize();
  if (!fit) return;
  state.termCols = fit.cols;
  state.termRows = fit.rows;
  connectTerminal();
}
window.addEventListener("resize", () => {
  if (resizeFramePending) return;
  resizeFramePending = true;
  requestAnimationFrame(() => {
    resizeFramePending = false;
    fitTerminalShell();
    if (
      options.fitToBrowser ||
      shouldFitFocusedWebTerminal() ||
      shouldAutoFitDetachedTerminal()
    ) {
      const fit = browserTerminalSize();
      if (fit) {
        state.termCols = fit.cols;
        state.termRows = fit.rows;
        connectTerminal();
      }
    }
  });
});
window.addEventListener("focus", () =>
  requestAnimationFrame(fitFocusedTerminal),
);
function scrollBrowserOverflow(dx, dy) {
  const shell = el("terminalShell");
  if (!shell) return;
  const maxTop = Math.max(0, shell.scrollHeight - shell.clientHeight);
  const maxLeft = Math.max(0, shell.scrollWidth - shell.clientWidth);
  shell.scrollTop = Math.max(0, Math.min(maxTop, shell.scrollTop + dy));
  shell.scrollLeft = Math.max(0, Math.min(maxLeft, shell.scrollLeft + dx));
}
function wheelOnShellScrollbar(e) {
  const shell = el("terminalShell");
  if (!shell) return false;
  const r = shell.getBoundingClientRect();
  const vertical =
    shell.scrollHeight > shell.clientHeight && e.clientX >= r.right - 14;
  const horizontal =
    shell.scrollWidth > shell.clientWidth && e.clientY >= r.bottom - 14;
  return vertical || horizontal;
}
function wsUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  const session =
    state.session && state.session !== "default"
      ? sep + "session=" + encodeURIComponent(state.session)
      : "";
  return (
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    path +
    session
  );
}
function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
function workspaceCloseName(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id);
  if (!w) return id;
  const branch = workspaceBranch(w);
  return `${w.label}${branch ? " - " + branch : ""}`;
}
function workspaceBranch(w) {
  const wt = worktreeForWorkspace(w);
  return (
    (wt && (wt.branch || (wt.is_detached ? "detached" : ""))) ||
    state.workspaceBranches[w.workspace_id] ||
    ""
  );
}
function panelCloseName(id) {
  const t = state.allTabs.concat(state.tabs).find((x) => x.tab_id === id);
  if (!t) return id;
  return `${workspaceCloseName(t.workspace_id)} - ${tabTitle(t)}`;
}
function workspaceDragStart(e, id) {
  state.dragWorkspace = id;
  e.currentTarget.classList.add("workspace-drag");
  try {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  } catch (_) {}
}
function workspaceDragOver(e, id) {
  if (
    options.workspaceSort !== "drag" ||
    !state.dragWorkspace ||
    state.dragWorkspace === id
  )
    return;
  e.preventDefault();
  e.currentTarget.classList.add("workspace-drop");
}
function workspaceDragLeave(e) {
  e.currentTarget.classList.remove("workspace-drop");
}
function workspaceDragEnd(e) {
  e.currentTarget.classList.remove("workspace-drag");
  document
    .querySelectorAll(".workspace-drop")
    .forEach((x) => x.classList.remove("workspace-drop"));
  state.dragWorkspace = null;
}
async function workspaceDrop(e, targetId) {
  e.preventDefault();
  e.currentTarget.classList.remove("workspace-drop");
  const source = state.dragWorkspace;
  if (!source || source === targetId) return;
  const ids = orderedWorkspaceIds().filter((id) => id !== source);
  const index = Math.max(0, ids.indexOf(targetId));
  ids.splice(index, 0, source);
  state.workspaceOrder = ids;
  state.dragWorkspace = null;
  render();
  await api("/api/workspace-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: ids }),
  });
}
function orderedWorkspaceIds() {
  return Array.from(document.querySelectorAll("#workspaces .item"))
    .map((x) => x.dataset.workspaceId)
    .filter(Boolean);
}
function openWorktreeCreateModal(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id);
  if (!w || isLinkedWorktree(w)) return;
  state.createWorktreeWorkspace = id;
  const sourcePath = (w.worktree && w.worktree.checkout_path) || "";
  state.createWorktreeOriginalSource = sourcePath;
  state.createWorktreePathSuggestions = [];
  state.createWorktreeSuggestionIndex = -1;
  state.createWorktreeSource = null;
  state.createWorktreeDefaultPath = "";
  el("worktreeCreateSource").value = sourcePath;
  el("worktreeBranch").value = "";
  el("worktreeBase").value = "";
  el("worktreeLabel").value = "";
  el("worktreePath").value = "";
  el("worktreeCreateError").textContent = "";
  setCreateWorktreeLoading(false);
  renderPathOptions("worktreeCreatePathOptions", []);
  el("worktreeCreateModal").style.display = "grid";
  setTimeout(() => {
    el("worktreeBranch").focus();
    loadCreateWorktreePathSuggestions();
  }, 0);
}
function closeWorktreeCreateModal() {
  const m = el("worktreeCreateModal");
  if (m) m.style.display = "none";
  clearTimeout(state.createWorktreePathSuggestTimer);
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  state.createWorktreeWorkspace = null;
  state.createWorktreeOriginalSource = "";
  state.createWorktreePathSuggestions = [];
  state.createWorktreeSuggestionIndex = -1;
  state.createWorktreeSource = null;
  state.createWorktreeDefaultPath = "";
  state.createWorktreeSuggestionLocked = false;
  setCreateWorktreeLoading(false);
}
function setCreateWorktreeLoading(show) {
  const loading = el("worktreeCreateLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function setWorktreeLoading(show) {
  const loading = el("worktreeLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function closeWorktreeOpenModal() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  state.openWorktreeSuggestionLocked = false;
  setWorktreeLoading(false);
  const m = el("worktreeOpenModal");
  if (m) m.style.display = "none";
}
function openWorktreeOpenModal() {
  state.openWorktreeSelected = null;
  state.openWorktreePathSuggestions = [];
  state.openWorktreeSuggestionLocked = false;
  state.openWorktreeSource = null;
  state.openWorktreeRows = [];
  state.openWorktreeAllRows = [];
  state.openWorktreeBranches = [];
  state.openWorktreeBranchSourceKey = "";
  state.openWorktreeDefaultPath = "";
  state.openWorktreeBaseBranchName = "";
  el("worktreeNewBranch").value = "";
  el("worktreeNewBase").value = "";
  el("worktreeNewLabel").value = "";
  el("worktreeNewPath").value = "";
  syncWorktreeBranchOptions([]);
  renderWorktreeOpenList();
  el("worktreeOpenError").textContent = "";
  el("worktreeOpenModal").style.display = "grid";
  setTimeout(() => {
    el("worktreeDiscoverPath").focus();
    loadWorktreePathSuggestions();
  }, 0);
}
function openWorktreesForRepo(keyToken) {
  const key = decodeURIComponent(keyToken),
    allRows = state.worktrees.filter((w) => worktreeRowGroupKey(w) === key),
    rows = allRows.filter((w) => w.is_linked_worktree);
  const source = allRows[0] || rows[0] || {};
  state.openWorktreeSelected = null;
  state.openWorktreePathSuggestions = [];
  state.openWorktreeSource = {
    workspace_id: source.source_workspace_id || null,
    cwd: source.source_cwd || null,
    repo_name: source.source_repo_name || "",
    repo_root: source.source_repo_root || "",
    default_worktree_directory: source.default_worktree_directory || "",
  };
  state.openWorktreeAllRows = allRows.map((w) =>
    Object.assign({}, w, {
      path: textValue(w.path),
      label: textValue(w.label),
      branch: textValue(w.branch),
      source_cwd: textValue(w.source_cwd),
      source_repo_root: textValue(w.source_repo_root),
    }),
  );
  state.openWorktreeRows = rows.map((w) =>
    Object.assign({}, w, {
      path: textValue(w.path),
      label: textValue(w.label),
      branch: textValue(w.branch),
      source_cwd: textValue(w.source_cwd),
      source_repo_root: textValue(w.source_repo_root),
    }),
  );
  el("worktreeNewBranch").value = "";
  el("worktreeNewBase").value = "";
  el("worktreeNewLabel").value = "";
  el("worktreeNewPath").value = "";
  state.openWorktreeDefaultPath = "";
  state.openWorktreeBaseBranchName = "";
  state.openWorktreeBranchSourceKey = "";
  syncWorktreeBranchOptions([]);
  el("worktreeOpenError").textContent = "";
  el("worktreeDiscoverPath").value =
    source.source_cwd || source.source_repo_root || "";
  renderWorktreeOpenList();
  el("worktreeOpenModal").style.display = "grid";
  loadWorktreeBranchOptions();
}
function validOpenWorktreeRows() {
  return (state.openWorktreeRows || state.worktrees || [])
    .map((w) =>
      Object.assign({}, w, {
        path: textValue(w.path),
        label: textValue(w.label),
        branch: textValue(w.branch),
        source_cwd: textValue(w.source_cwd),
      }),
    )
    .filter(
      (w) => w.is_linked_worktree && (w.source_workspace_id || w.source_cwd),
    );
}
function syncWorktreePathOptions(rows) {
  const seen = new Set(),
    items = [];
  for (const w of rows || []) {
    if (!w.path || seen.has(w.path)) continue;
    seen.add(w.path);
    items.push(
      `<option value="${escapeAttr(w.path)}">${escapeAttr(worktreeOpenRowTitle(w))}</option>`,
    );
  }
  for (const s of state.openWorktreePathSuggestions || []) {
    if (!s.path || seen.has(s.path)) continue;
    seen.add(s.path);
    items.push(
      `<option value="${escapeAttr(s.path)}">${escapeAttr(s.label || "directory")}</option>`,
    );
  }
  renderPathOptions("worktreePathOptions", items);
}
function renderPathOptions(optionsId, items) {
  const optionsEl = el(optionsId);
  if (!optionsEl) return;
  optionsEl.innerHTML = items.join("");
}
function syncDirectoryPathOptions(optionsId, suggestions) {
  renderPathOptions(
    optionsId,
    (suggestions || []).map(
      (s) =>
        `<option value="${escapeAttr(s.path)}">${escapeAttr(s.label || "directory")}</option>`,
    ),
  );
}
function scheduleWorktreePathSuggestions() {
  state.openWorktreePathSuggestTimer = schedulePathSuggestions(
    state.openWorktreePathSuggestTimer,
    loadWorktreePathSuggestions,
  );
}
function scheduleWorkspacePathSuggestions() {
  state.workspaceCreatePathSuggestTimer = schedulePathSuggestions(
    state.workspaceCreatePathSuggestTimer,
    loadWorkspacePathSuggestions,
  );
}
function schedulePathSuggestions(timer, load) {
  clearTimeout(timer);
  return setTimeout(load, 120);
}
async function loadWorktreePathSuggestions() {
  const suggestions = await loadDirectoryPathSuggestions(
    "worktreeDiscoverPath",
    () => syncWorktreePathOptions(validOpenWorktreeRows()),
  );
  if (suggestions) state.openWorktreePathSuggestions = suggestions;
}
async function loadCreateWorktreePathSuggestions() {
  const suggestions = await loadDirectoryPathSuggestions(
    "worktreeCreateSource",
    (items) => syncDirectoryPathOptions("worktreeCreatePathOptions", items),
  );
  if (suggestions) {
    state.createWorktreePathSuggestions = suggestions;
    state.createWorktreeSuggestionIndex = -1;
  }
}
async function discoverCreateWorktreeSource() {
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  setCreateWorktreeLoading(true);
  const path = el("worktreeCreateSource").value.trim();
  el("worktreeCreateError").textContent = "";
  try {
    let url = "/api/worktrees";
    if (path) url += "?cwd=" + encodeURIComponent(path);
    const r = await api(url);
    const source = (r.result || {}).source || {};
    const sourceCwd = textValue(source.source_checkout_path) || path || null;
    state.createWorktreeSource = {
      workspace_id: source.source_workspace_id || null,
      cwd: sourceCwd,
      repo_name: textValue(source.repo_name),
      repo_root: textValue(source.repo_root),
      default_worktree_directory: textValue(source.default_worktree_directory),
    };
    syncCreateWorktreeCheckoutPath();
  } catch (ex) {
    state.createWorktreeSource = null;
    el("worktreeCreateError").textContent = ex.message || String(ex);
  } finally {
    setCreateWorktreeLoading(false);
  }
}
function clearCreateWorktreeSuggestions() {
  state.createWorktreePathSuggestions = [];
  state.createWorktreeSuggestionIndex = -1;
  renderPathOptions("worktreeCreatePathOptions", []);
}
function scheduleCreateWorktreeAutodiscover() {
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  const seconds = Number(options.worktreeAutoDiscoverSeconds) || 0;
  const value = el("worktreeCreateSource").value.trim();
  setCreateWorktreeLoading(false);
  if (!value) return;
  setCreateWorktreeLoading(true);
  state.createWorktreeAutodiscoverTimer = setTimeout(
    () => {
      if (
        el("worktreeCreateModal").style.display === "grid" &&
        el("worktreeCreateSource").value.trim() === value
      )
        discoverCreateWorktreeSource();
      else setCreateWorktreeLoading(false);
    },
    Math.max(0, seconds) * 1000,
  );
}
function syncCreateWorktreeCheckoutPath() {
  const input = el("worktreePath");
  if (!input) return;
  const source = state.createWorktreeSource || {},
    branch = el("worktreeBranch").value.trim(),
    root = worktreeRootForSource(source),
    repo = source.repo_name;
  if (!root || !repo || !branch) {
    const prev = state.createWorktreeDefaultPath || "";
    if (input.value.trim() === prev) input.value = "";
    state.createWorktreeDefaultPath = "";
    return;
  }
  const next = joinPath(root, repo, branchPathSlug(branch));
  if (!input.value.trim() || input.value.trim() === state.createWorktreeDefaultPath)
    input.value = next;
  state.createWorktreeDefaultPath = next;
}
async function loadDirectoryPathSuggestions(inputId, onDone) {
  const input = el(inputId);
  if (!input) return null;
  const prefix = input.value;
  let suggestions = [];
  try {
    const r = await api(
      "/api/path-suggestions?prefix=" + encodeURIComponent(prefix),
    );
    if (input.value !== prefix) return null;
    suggestions = r.suggestions || [];
  } catch (_) {
    suggestions = [];
  }
  if (onDone) onDone(suggestions);
  return suggestions;
}
function syncWorktreeBranchOptions(branches) {
  const optionsEl = el("worktreeBranchOptions");
  if (!optionsEl) return;
  optionsEl.innerHTML = (branches || [])
    .map((branch) => `<option value="${escapeAttr(branch)}"></option>`)
    .join("");
}
function worktreeSourceKey(source) {
  return source
    ? source.cwd || source.repo_root || source.workspace_id || ""
    : "";
}
async function loadWorktreeBranchOptions() {
  const source = state.openWorktreeSource;
  if (!source || !source.cwd) {
    state.openWorktreeBranches = [];
    syncWorktreeBranchOptions([]);
    state.openWorktreeBranchSourceKey = "";
    return;
  }
  const key = worktreeSourceKey(source);
  if (state.openWorktreeBranchSourceKey === key) return;
  state.openWorktreeBranchSourceKey = key;
  try {
    const r = await api(
      "/api/git-branches?cwd=" + encodeURIComponent(source.cwd),
    );
    state.openWorktreeBranches = r.branches || [];
    syncWorktreeBranchOptions(state.openWorktreeBranches);
  } catch (_) {
    state.openWorktreeBranches = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
  }
}
function joinPath(...parts) {
  const clean = parts.filter(Boolean).map((part, index) => {
    part = String(part);
    if (index === 0) return part.replace(/\/+$/g, "");
    return part.replace(/^\/+|\/+$/g, "");
  });
  return clean.join("/");
}
function worktreeRootForSource(source) {
  let root = String(options.worktreeDefaultDirectory || "").trim();
  if (!root) root = source.default_worktree_directory || "../worktrees";
  if (root.startsWith("~") || root.startsWith("/")) return root;
  return normalizeAbsolutePath(joinPath(source.repo_root, root));
}
function defaultWorktreeCheckoutPath() {
  const source = state.openWorktreeSource || {},
    branch = el("worktreeNewBranch").value.trim(),
    root = worktreeRootForSource(source),
    repo = source.repo_name;
  if (!root || !repo || !branch) return "";
  return joinPath(root, repo, branchPathSlug(branch));
}
function syncWorktreeCheckoutPath() {
  const input = el("worktreeNewPath");
  if (!input) return;
  const next = defaultWorktreeCheckoutPath();
  const previous = state.openWorktreeDefaultPath || "";
  if (!next) {
    if (input.value.trim() === previous) input.value = "";
    state.openWorktreeDefaultPath = "";
    return;
  }
  if (!input.value.trim() || input.value.trim() === previous)
    input.value = next;
  state.openWorktreeDefaultPath = next;
}
function checkedOutWorktreeForBranch(branch) {
  return checkedOutWorktreeForBranchHelper(branch, [
    state.openWorktreeAllRows || state.openWorktreeRows || [],
    state.worktrees || [],
  ]);
}
function resolveWorktreeSource(input) {
  return resolveWorktreeSourceHelper(input);
}
async function submitWorktreeCreate(input) {
  const errEl = input.errEl,
    submitEl = input.submitEl,
    closeFn = input.closeFn,
    source = input.source,
    branch = String(input.branch || "").trim(),
    base = String(input.base || "").trim(),
    label = String(input.label || "").trim(),
    path = String(input.path || "").trim();
  errEl.textContent = "";
  const error = validateWorktreeCreateHelper({
    branch,
    generateWorktreeNames: options.generateWorktreeNames,
    worktreeLists: [
      state.openWorktreeAllRows || state.openWorktreeRows || [],
      state.worktrees || [],
    ],
  });
  if (error) {
    errEl.textContent = error;
    return;
  }
  submitEl.disabled = true;
  try {
    const r = await api("/api/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildWorktreeCreateBody({ source, branch, base, label, path }),
      ),
    });
    closeFn();
    const result = r.result || {};
    go(
      result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (ex) {
    errEl.textContent = ex.message || String(ex);
  } finally {
    submitEl.disabled = false;
  }
}
function defaultBaseBranch() {
  const branches = state.openWorktreeBranches || [];
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0] || "";
}
function syncBranchNameFromBase() {
  const base = el("worktreeNewBase").value.trim(),
    branchInput = el("worktreeNewBranch");
  if (!base) return;
  if (base === defaultBaseBranch()) {
    if (branchInput.value.trim() === state.openWorktreeBaseBranchName)
      branchInput.value = "";
    state.openWorktreeBaseBranchName = "";
    syncWorktreeCheckoutPath();
    return;
  }
  if (
    branchInput.value.trim() &&
    branchInput.value.trim() !== state.openWorktreeBaseBranchName
  )
    return;
  branchInput.value = base;
  state.openWorktreeBaseBranchName = base;
  syncWorktreeCheckoutPath();
}
function firstWorktreePathSuggestion() {
  const rows = validOpenWorktreeRows();
  if (rows.length) return rows[0].path;
  const suggestions = state.openWorktreePathSuggestions || [];
  return suggestions.length ? textValue(suggestions[0].path) : "";
}
function acceptFirstWorktreePathSuggestion() {
  const path = firstWorktreePathSuggestion();
  if (!path) return false;
  el("worktreeDiscoverPath").value = path;
  const idx = (state.openWorktreeRows || []).findIndex(
    (w) => textValue(w.path) === path && w.is_linked_worktree,
  );
  state.openWorktreeSelected = idx >= 0 ? idx : null;
  scheduleWorktreeAutodiscover();
  return true;
}
function scheduleWorktreeAutodiscover() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  const seconds = Number(options.worktreeAutoDiscoverSeconds) || 0;
  const value = el("worktreeDiscoverPath").value.trim();
  setWorktreeLoading(false);
  if (!value) return;
  setWorktreeLoading(true);
  state.openWorktreeAutodiscoverTimer = setTimeout(
    () => {
      if (
        el("worktreeOpenModal").style.display === "grid" &&
        el("worktreeDiscoverPath").value.trim() === value
      )
        discoverWorktrees(true);
      else setWorktreeLoading(false);
    },
    Math.max(0, seconds) * 1000,
  );
}
function updateWorktreeNewVisibility() {
  const section = el("worktreeNewSection");
  if (section)
    section.style.display = state.openWorktreeSource ? "block" : "none";
}
function worktreeOpenRowTitle(w) {
  const pathName = (w.path || "").split(/[\\/]/).filter(Boolean).pop();
  return w.branch || pathName || w.label || "worktree";
}
function renderWorktreeOpenList() {
  const list = el("worktreeOpenList");
  if (!list) return;
  const rows = validOpenWorktreeRows();
  state.openWorktreeRows = rows;
  syncWorktreePathOptions(rows);
  updateWorktreeNewVisibility();
  if (!rows.length) {
    list.innerHTML = `<div class="worktree-open-empty">${state.openWorktreeSource ? "No linked worktrees found. Create a new one below." : "Enter a repo path or worktrees folder. Discovery starts automatically."}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (w, i) =>
        `<div class="worktree-open-row ${state.openWorktreeSelected === i ? "selected" : ""}"><span><strong>${escapeHtml(worktreeOpenRowTitle(w))}</strong><small>${escapeHtml(w.branch || "detached")} · ${escapeHtml(w.path)}</small></span><span class="session-controls"><button class="mini danger" title="Remove worktree from disk" onclick="event.stopPropagation();removeDiscoveredWorktree(${i})">🗑</button><button class="btn" onclick="openDiscoveredWorktree(${i})">Open</button></span></div>`,
    )
    .join("");
}
async function discoverWorktrees() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  setWorktreeLoading(true);
  const err = el("worktreeOpenError"),
    path = el("worktreeDiscoverPath").value.trim();
  err.textContent = "";
  state.openWorktreeSelected = null;
  try {
    let url = "/api/worktrees";
    if (path) url += "?cwd=" + encodeURIComponent(path);
    const r = await api(url);
    const source = (r.result || {}).source || {};
    const sourceCwd = textValue(source.source_checkout_path) || path || null;
    const previousSourceKey = worktreeSourceKey(state.openWorktreeSource);
    state.openWorktreeSource = {
      workspace_id: source.source_workspace_id || null,
      cwd: sourceCwd,
      repo_name: textValue(source.repo_name),
      repo_root: textValue(source.repo_root),
      default_worktree_directory: textValue(source.default_worktree_directory),
    };
    const nextSourceKey = worktreeSourceKey(state.openWorktreeSource);
    if (previousSourceKey !== nextSourceKey) {
      state.openWorktreeBranches = [];
      state.openWorktreeBranchSourceKey = "";
      syncWorktreeBranchOptions([]);
    }
    state.openWorktreeAllRows = ((r.result || {}).worktrees || []).map((w) =>
      Object.assign({}, w, {
        path: textValue(w.path),
        label: textValue(w.label),
        branch: textValue(w.branch),
        source_workspace_id: source.source_workspace_id,
        source_repo_name: textValue(source.repo_name),
        source_repo_root: textValue(source.repo_root),
        source_cwd: sourceCwd,
      }),
    );
    state.openWorktreeRows = state.openWorktreeAllRows;
    renderWorktreeOpenList();
    loadWorktreeBranchOptions();
    syncWorktreeCheckoutPath();
  } catch (ex) {
    state.openWorktreeSource = null;
    state.openWorktreeRows = [];
    state.openWorktreeAllRows = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
    renderWorktreeOpenList();
    err.textContent = ex.message || String(ex);
  } finally {
    setWorktreeLoading(false);
  }
}
async function openDiscoveredWorktree(index) {
  const row = (state.openWorktreeRows || [])[index];
  if (!row || !row.is_linked_worktree) return;
  const err = el("worktreeOpenError");
  err.textContent = "";
  try {
    const r = await api("/api/worktrees/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: row.source_workspace_id || null,
        cwd: row.source_workspace_id ? null : row.source_cwd,
        path: row.path,
        label: null,
      }),
    });
    closeWorktreeOpenModal();
    const result = r.result || {};
    go(
      result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  }
}
async function removeDiscoveredWorktree(index) {
  const row = (state.openWorktreeRows || [])[index];
  if (!row || !row.is_linked_worktree) return;
  if (
    !confirm(
      `Remove worktree "${row.label || row.branch || row.path}" from disk?`,
    )
  )
    return;
  const err = el("worktreeOpenError");
  err.textContent = "";
  try {
    if (row.open_workspace_id)
      await api(
        `/api/workspaces/${encodeURIComponent(row.open_workspace_id)}/worktree-remove`,
        { method: "POST" },
      );
    else
      await api("/api/worktrees/remove-path", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_root: row.source_repo_root,
          path: row.path,
          force: false,
        }),
      });
    await discoverWorktrees();
    refresh();
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  }
}
async function createDiscoveredWorktree() {
  const err = el("worktreeOpenError"),
    submitEl = el("worktreeNewSubmit"),
    sourcePath = el("worktreeDiscoverPath").value.trim();
  err.textContent = "";
  if (sourcePath && !state.openWorktreeSource) {
    submitEl.disabled = true;
    try {
      await discoverWorktrees();
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      return;
    } finally {
      submitEl.disabled = false;
    }
  }
  const source = resolveWorktreeSource({
    sourcePath,
    discoveredSource: state.openWorktreeSource || {},
    fallbackWorkspaceId: state.ws,
  });
  await submitWorktreeCreate({
    errEl: el("worktreeOpenError"),
    submitEl: el("worktreeNewSubmit"),
    closeFn: closeWorktreeOpenModal,
    source,
    branch: el("worktreeNewBranch").value,
    base: el("worktreeNewBase").value,
    label: el("worktreeNewLabel").value,
    path: el("worktreeNewPath").value,
  });
}
async function closeWorkspace(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id),
    kind = isLinkedWorktree(w) ? "worktree" : "workspace";
  const hasLinkedWorktrees =
    w &&
    !isLinkedWorktree(w) &&
    state.workspaces.some(
      (x) =>
        isLinkedWorktree(x) && worktreeGroupKey(x) === worktreeGroupKey(w),
    );
  if (hasLinkedWorktrees) {
    const mode = options.parentCloseMode || "panels";
    if (mode === "close") {
      const linkedToReopen = state.workspaces
        .filter(
          (x) =>
            isLinkedWorktree(x) &&
            worktreeGroupKey(x) === worktreeGroupKey(w),
        )
        .map((x) => ({
          path: x.worktree && x.worktree.checkout_path,
          label: x.label,
        }))
        .filter((x) => x.path);
      let msg = `Close workspace "${workspaceCloseName(id)}"?`;
      if (linkedToReopen.length)
        msg += `\n\nThis will close ${linkedToReopen.length} linked worktree(s) and stop their processes. They will be re-opened with fresh shells.`;
      if (!confirm(msg)) return;
      await api(`/api/workspaces/${encodeURIComponent(id)}/close`, {
        method: "POST",
      });
      if (state.ws === id) {
        state.ws = null;
        state.tab = null;
        state.pane = null;
      }
      await refresh();
      for (const wt of linkedToReopen) {
        try {
          await api("/api/worktrees/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: wt.path, label: wt.label }),
          });
        } catch (e) {}
      }
      refresh();
      return;
    }
    const wsTabs = state.tabs.filter((t) => t.workspace_id === id);
    if (
      !confirm(
        `Close panels in "${workspaceCloseName(id)}"? Linked worktrees will keep running.`,
      )
    )
      return;
    for (const tab of wsTabs) {
      const tabPanes = state.panes.filter((p) => p.tab_id === tab.tab_id);
      for (const pane of tabPanes) {
        try {
          await api(
            `/api/panes/${encodeURIComponent(pane.pane_id)}/close`,
            { method: "POST" },
          );
        } catch (e) {}
      }
    }
    refresh();
    return;
  }
  if (!confirm(`Close ${kind} "${workspaceCloseName(id)}"?`)) return;
  await api(`/api/workspaces/${encodeURIComponent(id)}/close`, {
    method: "POST",
  });
  if (state.ws === id) {
    state.ws = null;
    state.tab = null;
    state.pane = null;
  }
  refresh();
}
async function removeWorktree(id) {
  if (!confirm(`Remove and close worktree "${workspaceCloseName(id)}"?`))
    return;
  await api(`/api/workspaces/${encodeURIComponent(id)}/worktree-remove`, {
    method: "POST",
  });
  if (state.ws === id) {
    state.ws = null;
    state.tab = null;
    state.pane = null;
  }
  refresh();
}
async function newTab() {
  if (!state.ws) return;
  const r = await api("/api/tabs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: state.ws }),
  });
  const tab = r.result.tab.tab_id;
  go(state.ws, tab);
}
function startWorkspaceRename(id, label) {
  state.editingWorkspace = id;
  state.editingWorkspaceValue = label || "";
  render();
}
function workspaceRenameKey(e, id) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitWorkspaceRename(id);
  } else if (e.key === "Escape") {
    state.editingWorkspace = null;
    state.editingWorkspaceValue = "";
    render();
  }
}
async function commitWorkspaceRename(id) {
  if (state.editingWorkspace !== id) return;
  const label = String(state.editingWorkspaceValue || "").trim();
  state.editingWorkspace = null;
  state.editingWorkspaceValue = "";
  if (label)
    await api(`/api/workspaces/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
  refresh();
}
function startTabRename(id, label) {
  state.editingTab = id;
  state.editingTabValue = label || "";
  render();
}
function tabRenameKey(e, id) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitTabRename(id);
  } else if (e.key === "Escape") {
    state.editingTab = null;
    state.editingTabValue = "";
    render();
  }
}
async function commitTabRename(id) {
  if (state.editingTab !== id) return;
  const label = String(state.editingTabValue || "").trim();
  state.editingTab = null;
  state.editingTabValue = "";
  if (label)
    await api(`/api/tabs/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
  refresh();
}
async function closeTab(id) {
  if (!confirm(`Close panel "${panelCloseName(id)}"?`)) return;
  await api(`/api/tabs/${encodeURIComponent(id)}/close`, { method: "POST" });
  state.tab = null;
  state.pane = null;
  refresh();
}
function shortcutW(e) {
  return String(e.key || "").toLowerCase() === "w" || e.code === "KeyW";
}
function shortcutSpace(e) {
  return e.code === "Space" || e.key === " " || e.key === "Spacebar";
}
function handleCloseShortcut(e) {
  const mode = options.closeShortcut || "off";
  if (
    mode === "altw" &&
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    shortcutW(e)
  )
    return closeCurrentPanelShortcut();
  if (mode === "shiftspacew") {
    const now = Date.now();
    if (
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      shortcutSpace(e)
    ) {
      closeChordUntil = now + 1500;
      return true;
    }
    if (
      closeChordUntil > now &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      shortcutW(e)
    ) {
      closeChordUntil = 0;
      return closeCurrentPanelShortcut();
    }
    if (!e.shiftKey && !shortcutW(e)) closeChordUntil = 0;
  }
  return false;
}
function closeCurrentPanelShortcut() {
  if ((options.closeShortcut || "off") === "off" || !state.tab) return false;
  closeTab(state.tab);
  return true;
}
function closeShortcutKeydown(e) {
  if (!handleCloseShortcut(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  return true;
}
function openWorkspaceCreateModal() {
  clearTimeout(state.workspaceCreatePathSuggestTimer);
  state.workspaceCreateSuggestedLabel = "";
  el("workspaceCreatePath").value = "";
  el("workspaceCreateLabel").value = "";
  el("workspaceCreateError").textContent = "";
  syncDirectoryPathOptions("workspacePathOptions", []);
  el("workspaceCreateModal").style.display = "grid";
  setTimeout(() => el("workspaceCreatePath").focus(), 0);
}
function closeWorkspaceCreateModal() {
  clearTimeout(state.workspaceCreatePathSuggestTimer);
  el("workspaceCreateModal").style.display = "none";
}
function focusWorkspaceCreateLabel() {
  syncWorkspaceCreateLabel();
  el("workspaceCreateLabel").focus();
  el("workspaceCreateLabel").select();
}
function suggestedWorkspaceLabel(path) {
  return pathBasename(path) || "workspace";
}
function syncWorkspaceCreateLabel() {
  const pathInput = el("workspaceCreatePath"),
    labelInput = el("workspaceCreateLabel"),
    previous = state.workspaceCreateSuggestedLabel || "",
    next = suggestedWorkspaceLabel(pathInput.value.trim());
  if (!labelInput.value.trim() || labelInput.value.trim() === previous)
    labelInput.value = next;
  state.workspaceCreateSuggestedLabel = next;
}
async function loadWorkspacePathSuggestions() {
  await loadDirectoryPathSuggestions(
    "workspaceCreatePath",
    (items) => syncDirectoryPathOptions("workspacePathOptions", items),
  );
}
async function createWorkspaceFromModal() {
  const err = el("workspaceCreateError"),
    submit = el("workspaceCreateSubmit"),
    cwd = el("workspaceCreatePath").value.trim(),
    label = el("workspaceCreateLabel").value.trim();
  err.textContent = "";
  if (!cwd) {
    err.textContent = "Folder is required.";
    return;
  }
  if (!label) {
    err.textContent = "Workspace name is required.";
    return;
  }
  submit.disabled = true;
  try {
    const r = await api("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, cwd }),
    });
    closeWorkspaceCreateModal();
    const ws = r.result.workspace.workspace_id;
    go(ws);
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  } finally {
    submit.disabled = false;
  }
}
newWs.onclick = () => {
  openWorkspaceCreateModal();
};
el("workspaceCreateClose").onclick = closeWorkspaceCreateModal;
el("workspaceCreateCancel").onclick = closeWorkspaceCreateModal;
el("workspaceCreateForm").onsubmit = (e) => {
  e.preventDefault();
  if (document.activeElement === el("workspaceCreatePath")) {
    focusWorkspaceCreateLabel();
    return;
  }
  createWorkspaceFromModal();
};
function workspaceCreatePathChanged() {
  syncWorkspaceCreateLabel();
  scheduleWorkspacePathSuggestions();
}
el("workspaceCreatePath").addEventListener("input", workspaceCreatePathChanged);
el("workspaceCreatePath").addEventListener("change", workspaceCreatePathChanged);
el("themeToggle").onclick = () => {
  themeMode =
    themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
  applyTheme();
};
document.addEventListener("change", (e) => {
  if (!e.target || !e.target.classList.contains("no-sleep-control")) return;
  setNoSleepMode(e.target.value);
});
if (window.matchMedia) {
  try {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (media.addEventListener)
      media.addEventListener("change", () => {
        if (themeMode === "auto") applyTheme();
      });
    else if (media.addListener)
      media.addListener(() => {
        if (themeMode === "auto") applyTheme();
      });
  } catch (e) {}
}
setInterval(pollAutoTheme, 2000);
let settingsBackdropDown = false,
  shortcutsBackdropDown = false;
el("settingsToggle").onclick = () => {
  el("settingsModal").style.display = "grid";
  applyOptions();
  loadServerSettings();
};
el("settingsClose").onclick = () => {
  el("settingsModal").style.display = "none";
};
el("settingsModal").addEventListener("pointerdown", (e) => {
  settingsBackdropDown = e.target === el("settingsModal");
});
el("settingsModal").addEventListener("click", (e) => {
  if (settingsBackdropDown && e.target === el("settingsModal"))
    el("settingsModal").style.display = "none";
  settingsBackdropDown = false;
});
el("shortcutsToggle").onclick = () => {
  applyOptions();
  el("shortcutsModal").style.display = "grid";
};
el("shortcutsClose").onclick = () => {
  el("shortcutsModal").style.display = "none";
};
el("shortcutsCloseTop").onclick = () => {
  el("shortcutsModal").style.display = "none";
};
el("shortcutsModal").addEventListener("pointerdown", (e) => {
  shortcutsBackdropDown = e.target === el("shortcutsModal");
});
el("shortcutsModal").addEventListener("click", (e) => {
  if (shortcutsBackdropDown && e.target === el("shortcutsModal"))
    el("shortcutsModal").style.display = "none";
  shortcutsBackdropDown = false;
});
el("optTheme").onchange = () => {
  themeMode = normalizeThemeMode(el("optTheme").value);
  applyTheme();
};
el("themeColorsApply").onclick = applyThemeColorsFromSettings;
el("themeColorsReset").onclick = () => applyThemeColorProfile("default");
el("themeColorsApplyProfile").onclick = () => {
  applyThemeColorProfile(el("themeColorProfile").value);
};
el("serverSettingsLoad").onclick = loadServerSettings;
el("serverSettingsApply").onclick = applyServerSettings;
el("optOverflow").onchange = () => {
  options.overflow = el("optOverflow").checked;
  saveOptions();
  applyOptions();
};
el("optFit").onchange = () => {
  options.fitToBrowser = el("optFit").checked;
  saveOptions();
  applyOptions();
};
el("optShiftEnterNewline").onchange = () => {
  options.shiftEnterNewline = el("optShiftEnterNewline").checked;
  saveOptions();
  applyOptions();
};
el("optCloseShortcut").oninput = saveCloseShortcutOption;
el("optCloseShortcut").onchange = saveCloseShortcutOption;
el("optAgentSortMode").onchange = () => {
  options.agentSortMode = el("optAgentSortMode").value;
  saveOptions();
  applyOptions();
  render();
};
el("optParentCloseMode").onchange = () => {
  options.parentCloseMode = el("optParentCloseMode").value;
  saveOptions();
  applyOptions();
};
el("optStuckWorkingEnabled").onchange = () => {
  options.stuckWorkingEnabled = el("optStuckWorkingEnabled").checked;
  saveOptions();
  applyOptions();
  render();
};
el("optWorkingDismissMinutes").oninput = () => {
  options.workingDismissMinutes = Math.max(
    1,
    Math.min(1440, Number(el("optWorkingDismissMinutes").value) || 30),
  );
  saveOptions();
  applyOptions();
  render();
};
el("optShowTabActivity").onchange = () => {
  options.showTabActivity = el("optShowTabActivity").checked;
  saveOptions();
  applyOptions();
  render();
};
el("optWorkspaceSort").onchange = () => {
  options.workspaceSort = el("optWorkspaceSort").value;
  saveOptions();
  applyOptions();
  render();
};
el("optSoundScope").onchange = () => {
  options.soundScope = el("optSoundScope").value;
  saveOptions();
  applyOptions();
};
el("optScrollLines").oninput = () => {
  options.scrollLines = Math.max(
    1,
    Math.min(20, Number(el("optScrollLines").value) || 3),
  );
  saveOptions();
  applyOptions();
};
el("optTerminalFont").oninput = () => {
  options.terminalFontFamily = el("optTerminalFont").value.trim();
  saveOptions();
  applyOptions();
  applyTerminalFont();
};
el("optWorktreeAutoDiscover").oninput = () => {
  options.worktreeAutoDiscoverSeconds = Math.max(
    0,
    Math.min(30, Number(el("optWorktreeAutoDiscover").value) || 0),
  );
  saveOptions();
  applyOptions();
  scheduleWorktreeAutodiscover();
};
el("optGenerateWorktreeNames").onchange = () => {
  options.generateWorktreeNames = el("optGenerateWorktreeNames").checked;
  saveOptions();
  applyOptions();
};
el("optWorktreeDefaultDirectory").oninput = () => {
  options.worktreeDefaultDirectory =
    el("optWorktreeDefaultDirectory").value.trim() || "../worktrees";
  saveOptions();
  syncWorktreeCheckoutPath();
};
el("optSound").onchange = () => {
  options.sound = el("optSound").checked;
  saveOptions();
  applyOptions();
};
el("worktreeCreateClose").onclick = closeWorktreeCreateModal;
el("worktreeCreateCancel").onclick = closeWorktreeCreateModal;
el("worktreeCreateSource").oninput = () => {
  if (state.createWorktreeSuggestionLocked) {
    state.createWorktreeSuggestionLocked = false;
    return;
  }
  state.createWorktreeSuggestionIndex = -1;
  state.createWorktreePathSuggestTimer = schedulePathSuggestions(
    state.createWorktreePathSuggestTimer,
    loadCreateWorktreePathSuggestions,
  );
  scheduleCreateWorktreeAutodiscover();
};
el("worktreeCreateSource").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    state.createWorktreeSuggestionLocked = true;
    clearCreateWorktreeSuggestions();
    discoverCreateWorktreeSource();
  }
});
el("worktreeBranch").addEventListener("input", syncCreateWorktreeCheckoutPath);
el("worktreeBranch").addEventListener("change", syncCreateWorktreeCheckoutPath);
el("worktreeCreateForm").onsubmit = async (e) => {
  e.preventDefault();
  const source = resolveWorktreeSource({
    workspaceId: state.createWorktreeWorkspace,
    sourcePath: el("worktreeCreateSource").value,
    originalSource: state.createWorktreeOriginalSource,
  });
  await submitWorktreeCreate({
    errEl: el("worktreeCreateError"),
    submitEl: el("worktreeCreateSubmit"),
    closeFn: closeWorktreeCreateModal,
    source,
    branch: el("worktreeBranch").value,
    base: el("worktreeBase").value,
    label: el("worktreeLabel").value,
    path: el("worktreePath").value,
  });
};
el("worktreeOpenClose").onclick = closeWorktreeOpenModal;
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    if (el("workspaceCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceCreateModal();
    } else if (el("worktreeOpenModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeOpenModal();
    } else if (el("worktreeCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeCreateModal();
    }
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const modalIds = [
    "settingsModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "workspaceCreateModal",
    "shortcutsModal",
  ];
  const modal = modalIds
    .map((id) => el(id))
    .find((m) => m && m.style.display === "grid");
  if (!modal) return;
  const focusable = modal.querySelectorAll(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) {
    e.preventDefault();
    return;
  }
  const filtered = Array.from(focusable).filter(
    (f) => f.offsetParent !== null || f === document.activeElement,
  );
  if (!filtered.length) return;
  const active = document.activeElement;
  const first = filtered[0],
    last = filtered[filtered.length - 1];
  if (e.shiftKey) {
    if (active === first || !modal.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !modal.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
});
el("worktreeOpenRefresh").onclick = async () => {
  await refresh();
  if (el("worktreeDiscoverPath").value.trim()) await discoverWorktrees();
  else {
    syncWorktreePathOptions(validOpenWorktreeRows());
    renderWorktreeOpenList();
  }
};
el("worktreeNewForm").onsubmit = (e) => {
  e.preventDefault();
  createDiscoveredWorktree();
};
el("worktreeNewBase").addEventListener("input", syncBranchNameFromBase);
el("worktreeNewBase").addEventListener("change", syncBranchNameFromBase);
el("worktreeNewBranch").addEventListener("input", () => {
  if (el("worktreeNewBranch").value.trim() !== state.openWorktreeBaseBranchName)
    state.openWorktreeBaseBranchName = "";
  syncWorktreeCheckoutPath();
});
el("worktreeNewBranch").addEventListener("change", syncWorktreeCheckoutPath);
function worktreePathInputChanged() {
  if (state.openWorktreeSuggestionLocked) {
    state.openWorktreeSuggestionLocked = false;
    return;
  }
  const value = el("worktreeDiscoverPath").value.trim();
  const idx = (state.openWorktreeRows || []).findIndex(
    (w) => textValue(w.path) === value && w.is_linked_worktree,
  );
  state.openWorktreeSelected = idx >= 0 ? idx : null;
  scheduleWorktreePathSuggestions();
  scheduleWorktreeAutodiscover();
}
el("worktreeDiscoverPath").addEventListener("input", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("change", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    state.openWorktreeSuggestionLocked = true;
    renderPathOptions("worktreePathOptions", []);
  }
});
function editableEventTarget(e) {
  const t = e.target;
  return (
    t &&
    (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
  );
}
el("copyMenu").onclick = copySelection;
el("pasteMenu").onclick = pasteClipboard;
el("terminalShell").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showClipboardMenu(e.clientX, e.clientY);
});
document.addEventListener("click", (e) => {
  const menu = el("clipboardMenu");
  if (menu && !menu.contains(e.target)) hideClipboardMenu();
});
window.addEventListener("keydown", closeShortcutKeydown, true);
document.addEventListener("keydown", (e) => {
  if (editableEventTarget(e)) return;
  const copyKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "c";
  const pasteKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "v";
  if (copyKey && term && term.getSelection && term.getSelection()) {
    e.preventDefault();
    copySelection();
  } else if (pasteKey) {
    e.preventDefault();
    pasteClipboard();
  }
});
window.onpopstate = refresh;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenTimer = setTimeout(() => {
      if (eventWs) eventWs.close();
      if (termWs) termWs.close();
    }, 1000);
  } else {
    clearTimeout(hiddenTimer);
    loadVersions();
    refresh();
    connectEvents();
    loadNoSleep();
  }
});
window.addEventListener("focus", loadNoSleep);
setInterval(loadNoSleep, 5000);
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
setupSessionChrome();
applyTheme();
applyOptions();
syncNoSleepControls();
loadNoSleep();
loadVersions();
refresh();
connectEvents();
