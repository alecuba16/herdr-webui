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
      id: "sessions",
      icon: "se",
      title: "Manage sessions",
      subtitle: "Switch or launch built-in and Herdr backend sessions",
      text: "session backend manage launch switch",
      surfaces: ["desktop", "mobile"],
    },
    {
      id: "actions-menu",
      icon: "⌘",
      title: "Actions menu",
      subtitle: "Discover worktrees, manage sessions, or search",
      text: "actions command palette discover sessions search",
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
    {
      id: "toggle-sidebar",
      icon: "◧",
      title: "Toggle sidebar",
      subtitle: "Show or hide the workspace navigation sidebar",
      text: "toggle hide show collapse expand sidebar navigation",
      surfaces: ["desktop"],
      // Chord is resolved at render time from the live options map, so a
      // user-rebound or rebound-prefix chord never shows stale text. The
      // shortcutId pairs with the webuiShortcuts map entry "sidebar".
      shortcutId: "sidebar",
    },
    {
      id: "toggle-theme",
      icon: "☾",
      title: "Toggle theme",
      subtitle: "Cycle auto, dark, and light color modes",
      text: "toggle theme dark light auto color mode appearance",
      surfaces: ["desktop", "mobile"],
    },
    {
      id: "settings",
      icon: "⚙",
      title: "Settings",
      subtitle: "Adjust layout, files, alerts, terminal, and worktree defaults",
      text: "settings options preferences",
      surfaces: ["desktop", "mobile"],
      // Chord is resolved at render time from the live options map, so a
      // user-rebound chord or prefix never shows stale text here. Pairs
      // with the webuiShortcuts map entry "settings".
      shortcutId: "settings",
    },
  ];

  let recentCache = { at: 0, rows: [] };

  async function loadRecent() {
    const now = Date.now();
    if (recentCache.rows.length && now - recentCache.at < 10000) return recentCache.rows;
    try {
      const res = await fetch("/api/recent-workspaces");
      const data = await res.json();
      recentCache = { at: now, rows: Array.isArray(data.recent) ? data.recent : [] };
    } catch (_) {
      recentCache = { at: now, rows: [] };
    }
    return recentCache.rows;
  }

  function invalidateRecent() {
    recentCache = { at: 0, rows: [] };
  }

  function actionToRow(action) {
    return {
      ...action,
      action: action.id,
      type: "action",
      searchText: `${action.title} ${action.subtitle} ${action.text}`.toLowerCase(),
    };
  }

  // kbdHint renders the chord for a palette action row. Actions carry a
  // shortcutId (webuiShortcuts key) instead of a hardcoded chord: the host
  // registers a chord resolver on HerdrActionRegistry so rebound keys or a
  // rebound prefix never leak a stale "g s"-style hint into the palette.
  let chordResolver = null;

  function kbdHint(action, options = {}) {
    if (options.kbd === false) return "";
    const chord = chordFor(action);
    if (!chord) return "";
    return `<span class="kbd" aria-hidden="true">${escapeHtml(chord)}</span>`;
  }

  // hasHint lets callers filter rows without knowing how a chord is
  // sourced (resolver, static kbd, or none).
  function hasHint(action) {
    return !!chordFor(action);
  }

  function chordFor(action) {
    return (
      (chordResolver && action && action.shortcutId && chordResolver(action.shortcutId)) ||
      (action && action.kbd) ||
      ""
    );
  }

  function setChordResolver(fn) {
    chordResolver = typeof fn === "function" ? fn : null;
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
    if (needle.startsWith(">")) {
      const actionNeedle = needle.slice(1).trim();
      if (!actionNeedle) return rows;
      return rows.filter((action) => action.searchText.includes(actionNeedle));
    }
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
    kbdHint,
    hasHint,
    setChordResolver,
    renderButtons,
    loadRecent,
    invalidateRecent,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
