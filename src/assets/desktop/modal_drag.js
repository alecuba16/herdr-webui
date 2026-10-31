// Shared modal drag (desktop only). Every centered card the app shows can
// be moved with the pointer by its head: grab the title row, drag, the
// card follows and stays where it lands while open. Position resets when
// the modal reopens (backdrop click or a close/reopen cycle), so no stale
// off-screen state persists.
//
// The helper never moves a modal at phone widths: modals.css turns every
// backdrop into a bottom sheet there and a dragged card would fight the
// sheet geometry.
(function () {
  const DRAG_THRESHOLD_PX = 4;
  const PHONE_MAX_WIDTH_PX = 640;
  const wired = new WeakSet();

  function phoneLayout() {
    return window.matchMedia
      ? window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH_PX}px)`).matches
      : window.innerWidth <= PHONE_MAX_WIDTH_PX;
  }

  // The drag handle is the head strip: .settings-head (settings, question,
  // worktree create/open, workspace create), .search-head (search palette),
  // .directory-picker-head, .git-ui-modal-head, .prompt-card-head. Buttons
  // inside the head (close, toggles) keep their clicks: pointerdown on them
  // never arms a drag.
  const HEAD_SELECTOR = [
    ".settings-head",
    ".search-head",
    ".directory-picker-head",
    ".git-ui-modal-head",
    ".prompt-card-head",
    ".session-hero",
  ].join(", ");

  function draggableCard(head) {
    return head.parentElement || null;
  }

  // .session-hero holds the card title and close button, but the hero is
  // a grandchild inside .session-card's header row; the card itself is
  // the drag target.
  function sessionHeroCard(head) {
    return head.closest(".session-card") || null;
  }

  function armedTargets(event) {
    const target = event.target;
    if (!target || !target.closest) return null;
    if (target.closest("button, input, select, textarea, a[href], [contenteditable='true']")) return null;
    return target.closest(HEAD_SELECTOR);
  }

  function backdropOf(card) {
    const parent = card && card.parentElement;
    // Git modals and the directory picker nest the card inside the
    // backdrop; the session manager card sits inside its overlay host.
    return parent && parent.classList ? parent : null;
  }

  function clampBox(backdrop, cardRect) {
    const backdropRect = backdrop
      ? backdrop.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const maxX = backdropRect.width - cardRect.width;
    const maxY = backdropRect.height - cardRect.height;
    return {
      backdropRect,
      originLeft: cardRect.left - backdropRect.left,
      originTop: cardRect.top - backdropRect.top,
      clampLeft: (px) => Math.max(0, Math.min(maxX, px)),
      clampTop: (px) => Math.max(0, Math.min(maxY, px)),
    };
  }

  function applyCardPos(card, backdrop, x, y) {
    card.style.position = "relative";
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.margin = "0";
    if (backdrop) {
      // place-items/flex centering still owns the axis the drag has not
      // moved; switching the backdrop to top-start keeps the card where
      // the user put it without a translate dance.
      backdrop.style.alignItems = "flex-start";
      backdrop.style.justifyContent = "flex-start";
      backdrop.style.placeItems = "start";
    }
  }

  function resetCardPos(card, backdrop) {
    card.style.position = "";
    card.style.left = "";
    card.style.top = "";
    card.style.margin = "";
    if (backdrop) {
      backdrop.style.alignItems = "";
      backdrop.style.justifyContent = "";
      backdrop.style.placeItems = "";
    }
  }

  function stopDrag(state) {
    document.removeEventListener("pointermove", state.move);
    document.removeEventListener("pointerup", state.stop);
    document.removeEventListener("pointercancel", state.stop);
    if (state.card) state.card.classList.remove("modal-dragging");
  }

  function wireDrag(head) {
    if (wired.has(head)) return;
    wired.add(head);
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || phoneLayout()) return;
      const headNode = armedTargets(event);
      if (!headNode) return;
      const card = sessionHeroCard(headNode) || draggableCard(headNode);
      const backdrop = backdropOf(card);
      if (!card) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      const state = { card, move: null, stop: null };
      state.move = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (
          !dragging &&
          Math.abs(dx) < DRAG_THRESHOLD_PX &&
          Math.abs(dy) < DRAG_THRESHOLD_PX
        )
          return;
        if (!dragging) {
          dragging = true;
          card.classList.add("modal-dragging");
          const cardRect = card.getBoundingClientRect();
          Object.assign(state, clampBox(backdrop, cardRect));
        }
        applyCardPos(card, backdrop, state.clampLeft(state.originLeft + dx), state.clampTop(state.originTop + dy));
      };
      state.stop = () => {
        stopDrag(state);
      };
      document.addEventListener("pointermove", state.move);
      document.addEventListener("pointerup", state.stop);
      document.addEventListener("pointercancel", state.stop);
    });
  }

  function wireAll() {
    document.querySelectorAll(HEAD_SELECTOR).forEach(wireDrag);
  }

  // Modals mount lazily (core.js injects them once, git UI re-renders its
  // modal innerHTML per open), so a mutation observer picks every new head
  // up without each call site knowing about drag.
  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => wireAll());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.HerdrModalDrag = {
    wire: wireDrag,
    wireAll,
    // Reset hook: close paths call this so a reopened modal starts
    // centered again instead of keeping the dragged offset.
    reset(card) {
      if (!card) return;
      resetCardPos(card, backdropOf(card));
    },
    resetByBackdrop(backdrop) {
      if (!backdrop) return;
      const card = backdrop.firstElementChild;
      if (card) resetCardPos(card, backdrop);
    },
  };

  if (document.readyState !== "loading") wireAll();
  else document.addEventListener("DOMContentLoaded", wireAll, { once: true });
})();