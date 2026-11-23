// Shared onboarding tour driver skeleton.
//
// desktop/app_js/tour.js and mobile/tour.js kept two copies of the same
// driving machinery: visible-step filtering, spotlight clip-path painting,
// step movement with one-shot demos, keyboard/resize bindings, and
// localStorage done/skipped persistence. The two layouts differ only in
// DOM markup, element ids, storage key, target-rect fallbacks, key set,
// and stop-time cleanup of layout surfaces. createTour(hooks) owns the
// machinery and calls back into the layout for those differences.
//
// hooks:
//   storageKey     localStorage key for done/skipped persistence
//   ids            { step, skip, prev, next, progress, title, card, spot }
//                  element ids and .tour-* class hooks the driver drives
//   rootMarkup()   innerHTML for the tour root (layout classes/ids)
//   steps()        filtered or raw step list (layout step provider)
//   targetRect(step)  {x,y,w,h} for the spotlight, or null to skip step
//   paintExtras(rect, step) optional; layout may clamp the spot further
//   nextKeys(event)  true when the key event advances (Space is
//                    desktop-only; mobile lacks the spacebar key)
//   focusTarget()  node to focus after stop (or null for body)
//   onStop()       layout cleanup: close modals/sheets the demos opened
//   afterRender(step, card) optional; card placement is layout-specific
(function (root) {
  function createTour(hooks) {
    const {
      storageKey,
      ids,
      rootMarkup,
      steps,
      targetRect,
      nextKeys,
      focusTarget,
      onStop,
      paintExtras,
      afterRender,
    } = hooks;

    let root = null;
    let hole = null;
    let card = null;
    let active = false;
    let stepIndex = 0;
    let visibleSteps = [];
    let boundKeys = false;
    let boundResize = false;
    let renderedOnce = false;

    const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
    const PAD = 6;

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
      root.innerHTML = rootMarkup();
      document.body.appendChild(root);
      hole = root.querySelector(ids.spot);
      card = root.querySelector(ids.card);
      el(ids.skip).addEventListener("click", () => stop(false));
      el(ids.prev).addEventListener("click", () => move(-1));
      el(ids.next).addEventListener("click", () => move(1));
      // Clicks/taps on the dim backdrop quit, like Skip; clicks inside
      // the card or the spotlight hole keep the tour running.
      root.addEventListener("click", (e) => {
        if (e.target === root || (ids.tapHoleQuit && e.target === hole)) stop(false);
      });
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
      const raw = steps();
      visibleSteps = raw.filter(stepAllowed);
      if (!visibleSteps.length) visibleSteps = raw;
    }

    // Four dim bands around the cutout (top/right/bottom/left); the hole
    // itself stays undimmed so the user can see and use the target.
    function paintSpot(rect, instant) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
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
      hole.style.transition =
        instant || reducedMotion() ? "none" : "clip-path 180ms ease-out";
      if (paintExtras) paintExtras(rect, instant);
    }

    function runDemo(step) {
      if (!step.demo) return;
      try {
        const ok = step.demo();
        if (ok === false) return;
        // The demo may have opened a modal/palette/sheet or swapped the
        // screen; a repaint re-fits the cutout to the same target without
        // re-running the demo (renderCurrent never calls runDemo).
        setTimeout(() => renderCurrent(true), 0);
      } catch (_) {}
    }

    function enterStep(instant) {
      renderCurrent(instant);
      // Demo runs exactly once per step entry; repaints (resize, demo
      // reveal) go through renderCurrent and never re-run it.
      const step = visibleSteps[stepIndex];
      if (step) runDemo(step);
    }

    function renderCurrent(instant) {
      const step = visibleSteps[stepIndex];
      if (!step) {
        stop(renderedOnce);
        return;
      }
      const rect = targetRect(step);
      if (!rect) {
        move(1);
        return;
      }
      renderedOnce = true;
      el(ids.title).textContent = step.title;
      const bodyNode = card.querySelector(".tour-body");
      if (bodyNode) bodyNode.textContent = typeof step.body === "function" ? step.body() : step.body;
      const chordNode = card.querySelector(".tour-chord");
      if (chordNode) chordNode.innerHTML = hooks.chordMarkup ? hooks.chordMarkup(step) : "";
      el(ids.step).textContent = `${stepIndex + 1} / ${visibleSteps.length}`;
      el(ids.prev).disabled = stepIndex === 0;
      el(ids.next).textContent = stepIndex === visibleSteps.length - 1 ? "Finish" : "Next";
      el(ids.progress).max = visibleSteps.length;
      el(ids.progress).value = stepIndex + 1;
      paintSpot(rect, instant);
      if (afterRender) afterRender(step, card, rect);
      card.setAttribute("aria-hidden", "false");
      if (hooks.focusNextOnRender) {
        try {
          el(ids.next).focus({ preventScroll: true });
        } catch (_) {}
      }
    }

    function move(delta) {
      const next = stepIndex + delta;
      if (next >= visibleSteps.length) {
        stop(renderedOnce);
        return;
      }
      if (next < 0) return;
      stepIndex = next;
      enterStep(false);
    }

    function onKey(event) {
      if (!active) return;
      if (nextKeys(event)) {
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
        // Capture phase so tour keys never reach the terminal or the
        // prefix system; global-shortcut handlers also check isActive()
        // as a backstop.
        document.addEventListener("keydown", onKey, true);
        boundKeys = true;
      }
      if (!boundResize) {
        window.addEventListener("resize", onResize);
        boundResize = true;
      }
    }

    function start() {
      if (active) return;
      ensureDom();
      buildVisibleSteps();
      if (!visibleSteps.length) {
        // Empty step table: nothing to show, but mark the tour finished so
        // the boot auto-start does not fire again on the next load.
        markDone(true);
        return;
      }
      if (!steps().length) return;
      // A DOM that cannot resolve the card/spot nodes (stripped embedders,
      // stub harnesses) cannot run the tour; a silent no-op beats a crash
      // on every boot timer.
      if (!card || !hole) return;
      ensureBindings();
      active = true;
      stepIndex = 0;
      renderedOnce = false;
      buildVisibleSteps();
      root.hidden = false;
      root.style.display = "block";
      enterStep(true);
      if (hooks.focusNextOnStart !== false) {
        try {
          el(ids.next).focus({ preventScroll: true });
        } catch (_) {}
      }
    }

    function stop(finished) {
      if (!active) return;
      active = false;
      // Demos may have opened layout surfaces; closing them here keeps
      // the app in the pre-tour state.
      if (onStop) {
        try {
          onStop();
        } catch (_) {}
      }
      root.hidden = true;
      root.style.display = "none";
      if (boundResize) {
        try {
          window.removeEventListener("resize", onResize);
          boundResize = false;
        } catch (_) {}
      }
      markDone(finished);
      try {
        const target = (focusTarget && focusTarget()) || document.body;
        target.focus && target.focus({ preventScroll: true });
      } catch (_) {}
    }

    function markDone(finished) {
      try {
        localStorage.setItem(storageKey, finished ? "done" : "skipped");
      } catch (_) {}
    }

    function isDone() {
      try {
        return !!localStorage.getItem(storageKey);
      } catch (_) {
        return false;
      }
    }

    function reset() {
      try {
        localStorage.removeItem(storageKey);
      } catch (_) {}
    }

    function isActive() {
      return active;
    }

    return { start, stop, isActive, isDone, reset };
  }

  root.HerdrTourDriver = { createTour };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTourDriver;
})(typeof globalThis !== "undefined" ? globalThis : window);