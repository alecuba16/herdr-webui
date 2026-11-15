// Onboarding tour driver for the mobile layout: dim layer with a cutout
// around the step target plus a bottom card. Touch-first: navigation runs
// on Back/Next buttons (44px targets), Esc closes for keyboard users, and
// the demo actions call the real HerdrMobile functions.
//
// Persistence mirrors the desktop tour: localStorage "herdr-mobile-tour-done"
// holds "done" or "skipped" once the tour ends, and both values suppress
// the boot auto-start. Only the explicit replay paths start it again.
(function () {
  const STORAGE_KEY = "herdr-mobile-tour-done";
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
    try {
      return !!(window.matchMedia && window.matchMedia(REDUCED_MOTION).matches);
    } catch (_) {
      return false;
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function ensureDom() {
    if (root && root.isConnected) return;
    root = document.createElement("div");
    root.className = "tour-root";
    root.innerHTML =
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
      "</div>";
    document.body.appendChild(root);
    hole = root.querySelector(".tour-spot");
    card = root.querySelector(".tour-card");
    el("mobileTourSkip").addEventListener("click", () => stop(false));
    el("mobileTourPrev").addEventListener("click", () => move(-1));
    el("mobileTourNext").addEventListener("click", () => move(1));
    // Taps on the dim layer quit, like Skip; taps inside the card keep the
    // tour running. The cutout area is the spot layer too, so taps on the
    // spotlighted target land on it and close the tour: the target stays
    // visible but is covered by the dim layer while the card explains it.
    root.addEventListener("click", (event) => {
      if (event.target === root || event.target === hole) stop(false);
    });
  }

  function steps() {
    return globalThis.HerdrMobileTourSteps ? globalThis.HerdrMobileTourSteps.steps() : [];
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

  const PAD = 6;

  function paintSpot(rect, instant) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Four dim bands around the cutout; the hole stays undimmed so the
    // target stays visible under the explanation.
    const x = Math.max(0, rect.x - PAD);
    const y = Math.max(0, rect.y - PAD);
    const w = rect.w + PAD * 2;
    const h = rect.h + PAD * 2;
    const xl = ((x / vw) * 100).toFixed(4);
    const xr = (Math.min(100, ((x + w) / vw) * 100)).toFixed(4);
    const yt = ((y / vh) * 100).toFixed(4);
    const yb = (Math.min(100, ((y + h) / vh) * 100)).toFixed(4);
    hole.style.clipPath =
      "polygon(" +
      `0% 0%, 100% 0%, 100% ${yt}%, ${xr}% ${yt}%, ${xr}% ${yb}%, 100% ${yb}%, ` +
      `100% 100%, 0% 100%, 0% ${yb}%, ${xl}% ${yb}%, ${xl}% ${yt}%, 0% ${yt}%` +
      ")";
    hole.style.transition = instant || reducedMotion() ? "none" : "clip-path 180ms ease-out";
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
    el("mobileTourTitle").textContent = step.title;
    const bodyNode = card.querySelector(".tour-body");
    if (bodyNode) bodyNode.textContent = typeof step.body === "function" ? step.body() : step.body;
    el("mobileTourStep").textContent = `${stepIndex + 1} / ${visibleSteps.length}`;
    el("mobileTourPrev").disabled = stepIndex === 0;
    el("mobileTourNext").textContent = stepIndex === visibleSteps.length - 1 ? "Finish" : "Next";
    el("mobileTourProgress").max = visibleSteps.length;
    el("mobileTourProgress").value = stepIndex + 1;
    paintSpot(rect, instant);
    card.setAttribute("aria-hidden", "false");
  }

  function runDemo(step) {
    if (!step.demo) return;
    try {
      const ok = step.demo();
      if (ok === false) return;
      // The demo may have opened a sheet/drawer or swapped the screen; a
      // repaint re-fits the cutout to the same target without re-running
      // the demo (renderCurrent never calls runDemo).
      setTimeout(() => renderCurrent(true), 0);
    } catch (_) {}
  }

  function enterStep(instant) {
    renderCurrent(instant);
    const step = visibleSteps[stepIndex];
    if (step) runDemo(step);
  }

  function move(delta) {
    const next = stepIndex + delta;
    if (next >= visibleSteps.length) {
      stop(true);
      return;
    }
    if (next < 0) return;
    stepIndex = next;
    enterStep(false);
  }

  function onKey(event) {
    if (!active) return;
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop(false);
    }
  }

  function onResize() {
    if (active) renderCurrent(true);
  }

  function ensureBindings() {
    if (!boundKeys) {
      document.addEventListener("keydown", onKey, true);
      boundKeys = true;
    }
    if (!boundResize) {
      window.addEventListener("resize", onResize);
      boundResize = true;
    }
  }

  function markDone(finished) {
    try {
      localStorage.setItem(STORAGE_KEY, finished ? "done" : "skipped");
    } catch (_) {}
  }

  function start() {
    if (active) return;
    if (!globalThis.HerdrMobileTourSteps) return;
    ensureDom();
    // A DOM that cannot resolve the card/spot nodes (stripped embedders,
    // stub harnesses) cannot run the tour; a silent no-op beats a crash
    // on every boot timer.
    if (!card || !hole) return;
    ensureBindings();
    active = true;
    stepIndex = 0;
    buildVisibleSteps();
    root.hidden = false;
    root.style.display = "block";
    enterStep(true);
    try {
      el("mobileTourNext").focus({ preventScroll: true });
    } catch (_) {}
  }

  function stop(finished) {
    if (!active) return;
    active = false;
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
    root.hidden = true;
    root.style.display = "none";
    markDone(finished);
    try {
      const focusTarget = document.querySelector(".mobile-nav button:not([hidden])") || document.body;
      focusTarget.focus && focusTarget.focus({ preventScroll: true });
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

  globalThis.HerdrMobileTour = { start, stop, isActive, isDone, reset };
})();