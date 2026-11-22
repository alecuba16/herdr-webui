// Onboarding tour for the mobile layout: dim layer with a cutout around
// the step target plus a bottom card. Touch-first: navigation runs on
// Back/Next buttons (44px targets), Esc closes for keyboard users, and
// the demo actions call the real HerdrMobile functions. The driving
// machinery lives in shared/tour_driver.js (HerdrTourDriver); this
// wrapper supplies mobile markup, ids, target-rect rules, and stop-time
// sheet/drawer cleanup.
//
// Persistence mirrors the desktop tour: localStorage "herdr-mobile-tour-done"
// holds "done" or "skipped" once the tour ends, and both values suppress
// the boot auto-start. Only the explicit replay paths start it again.
(function () {
  const ids = {
    step: "mobileTourStep",
    skip: "mobileTourSkip",
    prev: "mobileTourPrev",
    next: "mobileTourNext",
    progress: "mobileTourProgress",
    title: "mobileTourTitle",
    card: ".tour-card",
    spot: ".tour-spot",
    tapHoleQuit: true,
  };

  function rootMarkup() {
    return (
      '<div class="tour-spot" aria-hidden="true"></div>' +
      '<div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="mobileTourTitle">' +
      '<div class="tour-head"><span class="tour-step" id="mobileTourStep"></span>' +
      '<button type="button" class="mobile-btn mini tour-skip" id="mobileTourSkip" aria-label="Skip tour">Skip</button></div>' +
      '<h3 id="mobileTourTitle"></h3>' +
      '<p class="tour-body"></p>' +
      '<div class="tour-nav">' +
      '<button type="button" class="mobile-btn tour-prev" id="mobileTourPrev">Back</button>' +
      '<button type="button" class="mobile-btn primary tour-next" id="mobileTourNext">Next</button>' +
      "</div>" +
      '<progress class="tour-progress" id="mobileTourProgress" aria-label="Tour progress"></progress>' +
      "</div>"
    );
  }

  function targetRect(step) {
    if (step.target === "body") {
      // Full-surface step (replay hint): spotlight the nav bar area the
      // user just learned, card rides above it.
      const nav = document.querySelector(".mobile-nav");
      if (nav) {
        const rect = nav.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }
      return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    }
    let node = null;
    try {
      node = document.querySelector(step.target);
    } catch (_) {
      node = null;
    }
    if (!node || node.hidden) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }

  function onStop() {
    // Demos may have opened the search sheet, the workspaces sheet, or
    // the drawer; close them so the app returns to the pre-tour state.
    // showScreen("search") opens the search sheet without changing the
    // screen, so no later demo step closes it; stop() must do it itself.
    const mobile = globalThis.HerdrMobile;
    try {
      if (mobile && mobile.closeSearch) mobile.closeSearch();
    } catch (_) {}
    try {
      if (mobile && mobile.closeWorkspacesSheet) mobile.closeWorkspacesSheet();
    } catch (_) {}
    try {
      if (mobile && mobile.closeDrawer) mobile.closeDrawer();
    } catch (_) {}
  }

  const tour = (globalThis.HerdrTourDriver || { createTour: null }).createTour({
    storageKey: "herdr-mobile-tour-done",
    ids,
    rootMarkup,
    steps: () =>
      globalThis.HerdrMobileTourSteps ? globalThis.HerdrMobileTourSteps.steps() : [],
    targetRect,
    // No Space on mobile keyboards; Enter alone advances.
    nextKeys: (event) => event.key === "ArrowRight" || event.key === "Enter",
    focusTarget: () =>
      document.querySelector(".mobile-nav button:not([hidden])") || document.body,
    onStop,
    focusNextOnStart: true,
  });

  if (tour) globalThis.HerdrMobileTour = tour;
})();