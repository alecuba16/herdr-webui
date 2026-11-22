// Onboarding tour driver: spotlight cutout over the step target plus a
// card with the step copy, progress, and keyboard navigation. The step
// list lives in tour_steps.js; the driving machinery lives in
// shared/tour_driver.js (HerdrTourDriver). This wrapper only supplies the
// desktop layout: DOM markup, element ids, sidebar-toggle fallbacks,
// card placement, chord rendering, and stop-time cleanup.
//
// Keyboard while the tour is active (captured before every other handler,
// see the entry registration in bindings.js):
//   ArrowRight/Enter/Space  next step
//   ArrowLeft                previous step
//   Esc                      quit the tour
// The tour never starts on its own; call window.HerdrOnboardingTour.start().
(function () {
  function el(id) {
    return document.getElementById(id);
  }

  const ids = {
    step: "tourStep",
    skip: "tourSkip",
    prev: "tourPrev",
    next: "tourNext",
    progress: "tourProgress",
    title: "tourTitle",
    card: ".tour-card",
    spot: ".tour-spot",
  };

  function rootMarkup() {
    return (
      '<div class="tour-spot" aria-hidden="true"></div>' +
      '<div class="tour-card" role="dialog" aria-modal="false" aria-labelledby="tourTitle">' +
      '<div class="tour-head"><span class="tour-step" id="tourStep"></span>' +
      '<button type="button" class="mini tour-skip" id="tourSkip" title="Skip tour (Esc)" aria-label="Skip tour">Skip</button></div>' +
      '<h3 id="tourTitle"></h3>' +
      '<p class="tour-body"></p>' +
      '<div class="tour-chord"></div>' +
      '<div class="tour-nav">' +
      '<button type="button" class="btn tour-prev" id="tourPrev">Back</button>' +
      '<button type="button" class="btn tour-next" id="tourNext">Next</button>' +
      "</div>" +
      '<progress class="tour-progress" id="tourProgress"></progress>' +
      "</div>"
    );
  }

  function chordMarkup(step) {
    if (!step.chord) return "";
    const label = window.HerdrTourSteps.chordLabel(step.chord[0], step.chord[1]);
    if (!label) return "";
    const [prefix, key] = label.split(" then ");
    return (
      '<span class="tour-chord-label">Shortcut</span>' +
      '<kbd>' + escapeHtml(prefix) + "</kbd>" +
      '<span class="tour-chord-arrow">then</span>' +
      "<kbd>" + escapeHtml(key) + "</kbd>"
    );
  }

  function targetRect(step) {
    if (step.target === "body") {
      // Full-surface step (prefix explanation): spotlight the top-left
      // region where the prefix overlay appears, card beside it.
      return { x: 16, y: 16, w: 320, h: 140 };
    }
    let node = null;
    try {
      node = document.querySelector(step.target);
    } catch (_) {
      node = null;
    }
    if (!node) return null;
    // Hidden containers (collapsed sidebars) fall back to their toggle
    // button so the step still shows where the feature lives.
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      const toggleId =
        step.target === "#rightSidebarRail" || step.target === "#rightSidebarContent"
          ? "rightSidebarToggle"
          : step.target === "#workspaces" || step.target === "#agents"
            ? "sidebarToggle"
            : null;
      const toggle = toggleId ? el(toggleId) : null;
      if (!toggle) return null;
      const tr = toggle.getBoundingClientRect();
      return { x: tr.x, y: tr.y, w: tr.width, h: tr.height, fallback: true };
    }
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }

  function placeCard(step, card, rect) {
    const cardW = Math.max(180, Math.min(360, window.innerWidth - 24));
    card.style.maxWidth = `${cardW}px`;
    let x;
    const anchor = (step && step.anchor) || "end";
    if (step.target === "body") {
      x = 16 + 336;
    } else if (anchor === "start") {
      x = rect.x + rect.w + 14;
    } else {
      x = rect.x - cardW - 14;
    }
    x = Math.max(12, Math.min(x, window.innerWidth - cardW - 12));
    let y = rect.y;
    y = Math.max(12, Math.min(y, window.innerHeight - card.offsetHeight - 12));
    if (y + card.offsetHeight > window.innerHeight - 12) y = Math.max(12, window.innerHeight - card.offsetHeight - 12);
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
  }

  function onStop() {
    // Demos may have opened a modal or palette; closing them here keeps
    // the app in the pre-tour state.
    try {
      if (searchPaletteOpen()) closeSearchPalette();
    } catch (_) {}
    try {
      // Same close path as the backdrop click in core.js: hide + drag/focus
      // restore; there is no closeSettingsModal global.
      const settings = el("settingsModal");
      if (settings && settings.style.display !== "none") {
        settings.style.display = "none";
        if (window.HerdrModalDrag) window.HerdrModalDrag.resetByBackdrop(settings);
        if (window.HerdrModalFocus) window.HerdrModalFocus.restoreModalOpener("settingsModal");
      }
    } catch (_) {}
  }

  const tour = (globalThis.HerdrTourDriver || { createTour: null }).createTour({
    storageKey: "herdr-web-tour-done",
    ids,
    rootMarkup,
    steps: () => (window.HerdrTourSteps ? window.HerdrTourSteps.steps() : []),
    targetRect,
    nextKeys: (e) => e.key === "ArrowRight" || e.key === "Enter" || e.key === " ",
    focusTarget: () => el("terminal") || document.body,
    onStop,
    chordMarkup,
    afterRender: placeCard,
    focusNextOnRender: true,
  });

  if (tour) window.HerdrOnboardingTour = tour;
})();