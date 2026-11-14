// Onboarding tour driver: spotlight cutout over the step target plus a
// card with the step copy, progress, and keyboard navigation. The step
// list lives in tour_steps.js; this module only renders and drives.
//
// Keyboard while the tour is active (captured before every other handler,
// see the entry registration in bindings.js):
//   ArrowRight/Enter/Space  next step
//   ArrowLeft                previous step
//   Esc                      quit the tour
// The tour never starts on its own; call window.HerdrOnboardingTour.start().
(function () {
  const STORAGE_KEY = "herdr-web-tour-done";
  const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

  let root = null;
  let hole = null;
  let card = null;
  let active = false;
  let stepIndex = 0;
  let visibleSteps = [];
  let boundKeys = false;
  let boundResize = false;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia(REDUCED_MOTION).matches);
  }

  function ensureDom() {
    if (root && root.isConnected) return;
    root = document.createElement("div");
    root.className = "tour-root";
    // aria-hidden: the tour is a highlight layer; the card itself is the
    // live content and carries its own dialog semantics.
    root.innerHTML =
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
      "</div>";
    document.body.appendChild(root);
    hole = root.querySelector(".tour-spot");
    card = root.querySelector(".tour-card");
    el("tourSkip").addEventListener("click", () => stop(false));
    el("tourPrev").addEventListener("click", () => move(-1));
    el("tourNext").addEventListener("click", () => move(1));
    root.addEventListener("click", (e) => {
      // Clicks on the dimmed backdrop quit, like Esc; clicks inside the
      // card or the spotlight hole keep the tour running.
      if (e.target === root) stop(false);
    });
  }

  function steps() {
    return window.HerdrTourSteps ? window.HerdrTourSteps.steps() : [];
  }

  function stepAllowed(step) {
    if (step.showWhen) {
      try {
        if (!step.showWhen()) return false;
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  function buildVisibleSteps() {
    visibleSteps = steps().filter(stepAllowed);
    if (!visibleSteps.length) visibleSteps = steps();
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

  const PAD = 6;
  const RADIUS = 12;

  function paintSpot(rect, instant) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Four dim panes around the cutout; the hole stays interactive so the
    // user can see the highlighted control beneath.
    const x = rect.x - PAD;
    const y = rect.y - PAD;
    const w = rect.w + PAD * 2;
    const h = rect.h + PAD * 2;
    hole.style.clipPath =
      "polygon(" +
      `0% 0%, 100% 0%, 100% ${((y / vh) * 100).toFixed(4)}%, ` +
      `0% ${((y / vh) * 100).toFixed(4)}%, ` +
      `0% ${(((y + h) / vh) * 100).toFixed(4)}%, ` +
      `100% ${(((y + h) / vh) * 100).toFixed(4)}%, ` +
      `100% 100%, 0% 100%` +
      ")";
    // The clip is a percentage polygon (resize-safe); the spotlight
    // outline is a rounded rect drawn on a border-box shadow.
    hole.style.boxShadow = "none";
    if (!instant && !reducedMotion()) {
      hole.style.transition = "clip-path 180ms ease-out";
    } else {
      hole.style.transition = "none";
    }
    hole.dataset.rect = JSON.stringify({ x, y, w, h });
  }

  function placeCard(rect, step) {
    const cardW = Math.min(360, window.innerWidth - 24);
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

  function runDemo(step) {
    if (!step.demo) return;
    try {
      const ok = step.demo();
      if (ok === false) return;
      if (step.hideOnDemo) {
        // The demo opened a modal/palette over the spotlight; repaint so
        // the new surface is visible while the card keeps explaining.
        setTimeout(() => renderCurrent(true), 0);
      }
    } catch (_) {}
  }

  function renderCurrent(instant) {
    const step = visibleSteps[stepIndex];
    if (!step) {
      stop(true);
      return;
    }
    const rect = targetRect(step);
    if (!rect) {
      move(1);
      return;
    }
    el("tourTitle").textContent = step.title;
    const bodyNode = card.querySelector(".tour-body");
    if (bodyNode) bodyNode.textContent = typeof step.body === "function" ? step.body() : step.body;
    const chordNode = card.querySelector(".tour-chord");
    if (chordNode) chordNode.innerHTML = chordMarkup(step);
    el("tourStep").textContent = `${stepIndex + 1} / ${visibleSteps.length}`;
    el("tourPrev").disabled = stepIndex === 0;
    el("tourNext").textContent = stepIndex === visibleSteps.length - 1 ? "Finish" : "Next";
    el("tourProgress").max = visibleSteps.length;
    el("tourProgress").value = stepIndex + 1;
    paintSpot(rect, instant);
    placeCard(rect, step);
    card.setAttribute("aria-hidden", "false");
    runDemo(step);
    el("tourNext").focus({ preventScroll: true });
  }

  function move(delta) {
    const next = stepIndex + delta;
    if (next >= visibleSteps.length) {
      stop(true);
      return;
    }
    if (next < 0) return;
    stepIndex = next;
    renderCurrent(false);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      move(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      move(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stop(false);
    }
  }

  function onResize() {
    if (active) renderCurrent(true);
  }

  function ensureBindings() {
    if (boundKeys) return;
    // Capture phase, registered after the app's own capture handlers run
    // only while the tour is active: the tour keys must not reach the
    // terminal or the prefix system. handleGlobalShortcut checks
    // window.HerdrOnboardingTour first, so ordering stays safe either way.
    document.addEventListener("keydown", onKey, true);
    boundKeys = true;
    if (!boundResize) {
      window.addEventListener("resize", onResize);
      boundResize = true;
    }
  }

  function start() {
    if (active) return;
    if (!window.HerdrTourSteps) return;
    ensureDom();
    ensureBindings();
    active = true;
    stepIndex = 0;
    buildVisibleSteps();
    root.hidden = false;
    root.style.display = "block";
    renderCurrent(true);
  }

  function stop(finished) {
    if (!active) return;
    active = false;
    // Demos may have opened a modal or palette; closing them here keeps
    // the app in the pre-tour state.
    try {
      if (searchPaletteOpen()) closeSearchPalette();
    } catch (_) {}
    try {
      const settings = el("settingsModal");
      if (settings && settings.style.display !== "none" && typeof closeSettingsModal === "function") closeSettingsModal();
    } catch (_) {}
    root.hidden = true;
    root.style.display = "none";
    markDone(finished);
    const focusTarget = el("terminal") || document.body;
    try {
      focusTarget.focus && focusTarget.focus({ preventScroll: true });
    } catch (_) {}
  }

  function markDone(finished) {
    try {
      localStorage.setItem(STORAGE_KEY, finished ? "done" : "skipped");
    } catch (_) {}
  }

  function isDone() {
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return false;
    }
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function isActive() {
    return active;
  }

  start.markDone = markDone;
  window.HerdrOnboardingTour = { start, stop, isActive, isDone, reset };
})();