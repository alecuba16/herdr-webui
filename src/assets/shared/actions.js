(function (root) {
  const helper = root.HerdrAppHelpers || {};
  const escapeHtml = helper.escapeHtml || ((value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;"));

  const ACTIONS = [
    {
      id: "open-workspace",
      icon: "＋",
      title: "Open workspace or worktree",
      subtitle: "Open a folder, discover worktrees, or create a checkout",
      text: "open workspace folder worktree project plus add create",
      surfaces: ["desktop", "mobile"],
      primary: true,
    },
    {
      id: "discover-worktrees",
      icon: "wt",
      title: "Discover worktrees",
      subtitle: "Find linked Git worktrees from the current or default folder",
      text: "discover find list linked git worktrees",
      surfaces: ["mobile"],
    },
    {
      id: "temp-terminal",
      icon: "T",
      title: "Temporary terminal",
      subtitle: "Start a shell without creating a workspace",
      text: "temporary terminal shell start",
      surfaces: ["desktop", "mobile"],
    },
    {
      id: "sessions",
      icon: "se",
      title: "Manage sessions",
      subtitle: "Switch or launch built-in and Herdr backend sessions",
      text: "session backend manage launch switch",
      surfaces: ["desktop"],
    },
    {
      id: "actions-menu",
      icon: "⌘",
      title: "Actions menu",
      subtitle: "Discover worktrees, start a temporary terminal, manage sessions, or search",
      text: "actions command palette discover temporary terminal sessions search",
      surfaces: ["desktop"],
      menuOnly: true,
    },
    {
      id: "search",
      icon: "⌘",
      title: "Search and actions",
      subtitle: "Find workspaces, files, content, or launch app actions",
      text: "search actions command palette find workspace file content launch",
      surfaces: ["mobile"],
      menuOnly: true,
    },
    {
      id: "settings",
      icon: "⚙",
      title: "Settings",
      subtitle: "Adjust layout, files, alerts, terminal, and worktree defaults",
      text: "settings options preferences",
      surfaces: ["mobile"],
    },
    {
      id: "terminal",
      icon: "term",
      title: "Open Terminal",
      subtitle: "Return to the current terminal",
      text: "terminal current workspace",
      surfaces: ["mobile"],
      requiresWorkspace: true,
    },
    {
      id: "files",
      icon: "fi",
      title: "Open Files",
      subtitle: "Browse files for the current workspace",
      text: "files file browser current workspace",
      surfaces: ["desktop", "mobile"],
      requiresWorkspace: true,
    },
    {
      id: "git",
      icon: "git",
      title: "Open Git",
      subtitle: "Show Git status for the current workspace",
      text: "git status changes current workspace",
      surfaces: ["desktop", "mobile"],
      requiresWorkspace: true,
    },
    {
      id: "create-worktree",
      icon: "wt",
      title: "Create worktree",
      subtitle: "Create a Git worktree from the current workspace",
      text: "create new git worktree branch checkout plus add",
      surfaces: ["desktop", "mobile"],
      requiresWorkspace: true,
    },
  ];

  function actionToRow(action) {
    return {
      ...action,
      action: action.id,
      type: "action",
      searchText: `${action.title} ${action.subtitle} ${action.text}`.toLowerCase(),
    };
  }

  function candidates(query, options = {}) {
    const platform = options.platform || "desktop";
    const hasWorkspace = !!options.hasWorkspace;
    const includeMenuOnly = !!options.includeMenuOnly;
    const includePrimary = options.includePrimary !== false;
    const needle = String(query || "").trim().toLowerCase();
    const rows = ACTIONS
      .filter((action) => (action.surfaces || []).includes(platform))
      .filter((action) => includeMenuOnly || !action.menuOnly)
      .filter((action) => includePrimary || !action.primary)
      .filter((action) => !action.requiresWorkspace || hasWorkspace)
      .map(actionToRow);
    if (!needle) return rows;
    return rows.filter((action) => action.searchText.includes(needle));
  }

  function action(id) {
    return actionToRow(ACTIONS.find((entry) => entry.id === id) || ACTIONS[0]);
  }

  function renderButtons(actions, options = {}) {
    const buttonClass = options.buttonClass || "action-card";
    const run = options.run || "runSearchAction";
    return actions.map((item) => `<button class="${escapeHtml(buttonClass)}" onclick="${escapeHtml(run)}('${escapeHtml(item.action)}')"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.subtitle)}</span></button>`).join("");
  }

  root.HerdrActionRegistry = {
    all: () => ACTIONS.map(actionToRow),
    action,
    candidates,
    renderButtons,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
