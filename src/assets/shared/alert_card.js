// In-app attention alert card ("droplet"), shared by desktop and mobile.
// Shows one card at a time when an agent starts needing attention
// (blocked or done finishing a turn). Tap/click opens the pane, swipe or
// flick up dismisses, auto-dismiss after ~3.6s, reduced-motion fades.
// Styles live in shared/alert_card.css.
(function (root) {
  var AUTO_DISMISS_MS = 3600;
  var SWIPE_MIN_PX = 42;
  var state = { host: null, card: null, timer: 0, queue: [], showing: null };

  function doc() {
    return root.document;
  }

  function reducedMotion() {
    return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ensureHost() {
    var document = doc();
    if (!document) return null;
    if (state.host && document.body && document.body.contains && document.body.contains(state.host)) return state.host;
    if (state.host && (!document.body || !document.body.contains)) return state.host;
    var host = document.createElement("div");
    host.className = "herdr-alert-card-host";
    // Coarse pointers mean phone browsers with notches; keep the card
    // below the status bar but above browser chrome.
    var coarse = root.matchMedia && root.matchMedia("(pointer: coarse)") && root.matchMedia("(pointer: coarse)").matches;
    if (coarse) host.setAttribute("top-offset", "safe-area");
    if (document.body && document.body.appendChild) document.body.appendChild(host);
    state.host = host;
    return host;
  }

  function clearTimer() {
    if (state.timer) {
      root.clearTimeout(state.timer);
      state.timer = 0;
    }
  }

  function hide(afterMs) {
    clearTimer();
    var card = state.card;
    state.card = null;
    state.showing = null;
    if (!card) return;
    card.classList.add("leaving");
    root.setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, afterMs != null ? afterMs : (reducedMotion() ? 170 : 230));
    pump();
  }

  function pump() {
    if (state.card || !state.queue.length) return;
    var alert = state.queue.shift();
    render(alert);
  }

  function render(alert) {
    var host = ensureHost();
    if (!host) return;
    var document = doc();
    var card = document.createElement("div");
    card.className = "herdr-alert-card";
    card.setAttribute("role", "alert");
    card.setAttribute("data-status", alert.status);
    card.innerHTML =
      '<span class="herdr-alert-card-dot" aria-hidden="true"></span>' +
      '<div class="herdr-alert-card-body">' +
      '<div class="herdr-alert-card-title">' + escapeHtml(alert.title) + "</div>" +
      '<div class="herdr-alert-card-subtitle">' + escapeHtml(alert.subtitle || "") + "</div>" +
      "</div>" +
      '<button type="button" class="herdr-alert-card-close" aria-label="Dismiss alert">' + escapeHtml("✕") + "</button>";
    card.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".herdr-alert-card-close")) {
        hide();
        return;
      }
      hide();
      if (alert.onOpen) alert.onOpen();
    });
    // Swipe or flick up dismisses; small vertical drags follow the finger
    // so the card feels attached, release snaps back or away.
    var startY = 0;
    var dragging = false;
    card.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse") return;
      dragging = true;
      startY = event.clientY;
    });
    card.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      var dy = event.clientY - startY;
      if (dy < 0) card.style.transform = "translateY(" + dy + "px)";
    });
    card.addEventListener("pointerup", function (event) {
      if (!dragging) return;
      dragging = false;
      card.style.transform = "";
      if (startY - event.clientY >= SWIPE_MIN_PX) {
        hide();
      }
    });
    card.addEventListener("pointercancel", function () {
      dragging = false;
      card.style.transform = "";
    });
    host.appendChild(card);
    state.card = card;
    state.showing = alert;
    state.timer = root.setTimeout(function () {
      hide();
    }, AUTO_DISMISS_MS);
  }

  function show(alert) {
    if (!alert || !alert.title) return;
    var sameKey = state.showing && state.showing.key && alert.key && state.showing.key === alert.key;
    // One at a time: repeated attention for the same pane replaces the
    // live card; anything else queues behind it.
    if (state.card && sameKey) {
      state.card.setAttribute("data-status", alert.status);
      clearTimer();
      state.timer = root.setTimeout(function () {
        hide();
      }, AUTO_DISMISS_MS);
      return;
    }
    if (state.card) {
      if (state.queue.length && state.queue[state.queue.length - 1].key === alert.key) return;
      state.queue.push(alert);
      return;
    }
    render(alert);
  }

  root.HerdrAlertCard = {
    show: show,
    hide: hide,
    _state: state,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);