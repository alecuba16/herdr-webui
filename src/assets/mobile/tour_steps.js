// Onboarding tour steps for the mobile layout. Same story and order as the
// desktop tour (docs/onboarding-tour.md parity table), but the targets are
// the mobile shell: header title, nav bar, and screens instead of the
// sidebar/right-rail.
//
// Step shape (shared contract with the desktop step table):
//   target  selector for the spotlighted element
//   title   short step name
//   body    what the area does and how it is reached
//   demo    optional () => boolean; runs the real action when the step
//           is entered, so the tour shows the feature, not a mock
//   showWhen optional () => boolean; step is skipped when false
(function () {
  function steps() {
    const mobile = globalThis.HerdrMobile;
    return [
      {
        target: '.mobile-nav button[data-screen="search"]',
        title: "Search",
        body:
          "One search reaches workspaces, agents, files, folder names, and file contents. " +
          "Type to search, tap a row to open it.",
        demo: () => {
          mobile && mobile.showScreen && mobile.showScreen("search");
          return true;
        },
        showWhen: () => {
          try {
            const options = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
            return options.headerSearchEnabled !== false;
          } catch (_) {
            return true;
          }
        },
      },
      {
        target: "#mobileTitle",
        title: "Workspaces",
        body:
          "Tap the title to switch workspaces. Each workspace holds its own panels; " +
          "the sheet lists every open root and linked worktree.",
        demo: () => {
          mobile && mobile.openWorkspacesSheet && mobile.openWorkspacesSheet();
          return true;
        },
        hideOnDemo: true,
      },
      {
        target: '.mobile-nav button[data-screen="home"]',
        title: "Home",
        body:
          "Continue where you left off, open a workspace or worktree, and see the " +
          "agents that need attention, with blocked and done first.",
        demo: () => {
          mobile && mobile.showScreen && mobile.showScreen("home");
          return true;
        },
      },
      {
        target: '.mobile-nav button[data-screen="terminal"]',
        title: "Terminal",
        body:
          "Live terminal for the selected panel. The Keys button toggles the " +
          "toolbar with Esc, arrows, and Ctrl keys a touch keyboard cannot type.",
        demo: () => {
          mobile && mobile.showScreen && mobile.showScreen("terminal");
          return true;
        },
      },
      {
        target: '.mobile-nav button[data-screen="git"]',
        title: "Git",
        body:
          "Status per file with stage, unstage, and discard, staged commits, branch " +
          "list with switch, and read-only diffs.",
        demo: () => {
          mobile && mobile.showScreen && mobile.showScreen("git");
          return true;
        },
      },
      {
        target: '.mobile-nav button[data-screen="files"]',
        title: "Files",
        body:
          "Browse the workspace, preview text files, edit with save, rename, delete, " +
          "and create new files. Search filters by name or content.",
        demo: () => {
          mobile && mobile.showScreen && mobile.showScreen("files");
          return true;
        },
      },
      {
        target: '.mobile-nav button[data-screen="more"]',
        title: "More",
        body:
          "Agents, panels, worktrees, sessions, notes, and Settings live in the " +
          "drawer. Swipe from the left edge or tap More.",
        demo: () => {
          mobile && mobile.openDrawer && mobile.openDrawer();
          return true;
        },
        hideOnDemo: true,
      },
      {
        target: "body",
        title: "Replay any time",
        body:
          "Settings, at the bottom, replays this tour. Chords are a desktop and TUI " +
          "concept; every action here has a button or a tap instead.",
        demo: null,
      },
    ];
  }

  globalThis.HerdrMobileTourSteps = { steps };
})();