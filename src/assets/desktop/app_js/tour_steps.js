// Onboarding tour: spotlight overlay that walks the main WebUI areas,
// naming the shortcut chord each one answers to. Zero dependencies; the
// driver lives in tour.js, the step list here.
//
// Step shape (shared contract with the TUI tour):
//   target  selector for the spotlighted element
//   title   short step name
//   body    what the area does and how it is reached
//   chord   [scope, action] resolved through the configured shortcut
//           maps, so a remapped key or prefix never leaves stale text
//   demo    optional () => boolean; runs the real action when the step
//           is entered, so the tour shows the feature, not a mock
//   showWhen optional () => boolean; step is skipped when false
//   anchor  'start' (default) or 'end'; card placement hint
(function () {
  const PREFIX_OFF = "Ctrl+B";

  function chordLabel(scope, action) {
    try {
      const key = shortcutMapFor(scope)[action];
      const prefix = scope === "webuiShortcuts" ? globalShortcutPrefixLabel() : PREFIX_OFF;
      if (key) return `${prefix} then ${shortcutDisplay(key)}`;
    } catch (_) {}
    return "";
  }

  function steps() {
    return [
      {
        target: "#headerActionsButton",
        title: "Search and actions",
        body:
          "One palette reaches workspaces, worktrees, files, folder names, file contents, and every app action. " +
          "Arrows move, Enter opens, Esc closes.",
        chord: ["webuiShortcuts", "search"],
        demo: () => {
          openSearchPalette();
          return true;
        },
        showWhen: () => !el("searchPalette").style.display || el("searchPalette").style.display === "none",
        anchor: "start",
        hideOnDemo: true,
      },
      {
        target: "#workspaces",
        title: "Workspaces",
        body:
          "Every open root and linked worktree. Click opens, double-click renames, drag the workspace/agents divider to resize. " +
          "Enter opens the focused row.",
        chord: ["webuiShortcuts", "nextWorkspace"],
        demo: () => selectRelativeWorkspace(1),
        showWhen: () => (state.workspaces || []).length > 1,
      },
      {
        target: "#agents",
        title: "Agents",
        body:
          "Status per agent with color badges. Enter opens, Undo/Dismiss answer Enter on a focused row. " +
          "The jump shortcuts cycle agents by status: blocked, done, idle, working.",
        chord: ["webuiShortcuts", "nextAgent"],
        demo: () => selectRelativeAgent(1),
        showWhen: () => (state.agents || []).length > 1,
      },
      {
        target: "#tabs",
        title: "Panels",
        body:
          "Each pane holds a tab strip. Click activates, double-click renames a terminal tab, plus creates a terminal panel, " +
          "and the bracket chords jump between panels.",
        chord: ["webuiShortcuts", "newPanel"],
        demo: () => {
          if (state.ws) newTab();
          return !!state.ws;
        },
        showWhen: () => !!state.ws,
      },
      {
        target: "#terminal",
        title: "Terminal",
        body:
          "Paste, scrollback, and links run through the terminal core. Wheel, trackpad, and PageUp/PageDown scroll; " +
          "the focus chord hands the keyboard back to the terminal.",
        chord: ["webuiShortcuts", "focusTerminal"],
        demo: () => {
          focusTerminal(true);
          return true;
        },
      },
      {
        target: "#rightSidebarRail",
        title: "Workspace views",
        body:
          "Files, Git, Search, and Notes for the open workspace. The cycle chord walks the rail: files, git, search, notes. " +
          "A collapsed rail reopens on Files.",
        chord: ["webuiShortcuts", "rightRail"],
        demo: () => {
          const toggle = el("rightSidebarToggle");
          if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed && window.HerdrRightSidebar.collapsed())
            toggle && toggle.click();
          return true;
        },
      },
      {
        target: "#shortcutsToggle",
        title: "Help and shortcuts",
        body:
          "The ? button opens the functionality map plus the full shortcut reference. Every chord shown in this tour " +
          "is editable in Settings, and the prefix is remappable too.",
        chord: ["webuiShortcuts", "help"],
        demo: () => {
          showShortcutsModal();
          return true;
        },
        anchor: "end",
      },
      {
        target: "body",
        title: "The prefix language",
        body: () =>
          `${globalShortcutPrefixLabel()} arms the prefix; the next key runs a WebUI action instead of reaching the terminal. ` +
          "Esc cancels. Try it now: the overlay in the top-left shows while the prefix is armed.",
        chord: null,
        anchor: "start",
      },
    ];
  }

  window.HerdrTourSteps = { steps, chordLabel };
})();