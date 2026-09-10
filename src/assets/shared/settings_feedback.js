// Settings "applied" confirmation feedback.
//
// Local settings (terminal, theme, agents, editor, module options) persist to
// browser storage on every change, and server settings save through the
// Apply button. Before this module there was no visual confirmation anywhere:
// users could not tell whether a change actually took effect. This helper
// gives every settings row a short-lived green "Applied" badge (or a red
// error message) with a screen-reader live region, and clears itself after a
// timeout. It is layout-agnostic: desktop passes the `.option` row ancestor,
// mobile passes the label/control container.
(function (root) {
  const APPLIED_MS = 2500;
  const APPLIED_CLASS = "settings-applied";
  const ERROR_CLASS = "settings-error-flash";
  const BADGE_ID_PREFIX = "settings-applied-badge-";

  function createSettingsFeedback({ document, setTimeout, clearTimeout }) {
    const doc = document;
    const timers = new Map();

    function clearTimer(key) {
      const timer = timers.get(key);
      if (timer) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }

    function scheduleClear(key, badge) {
      clearTimer(key);
      const timer = setTimeout(() => {
        timers.delete(key);
        if (badge && badge.parentNode) badge.remove();
      }, APPLIED_MS);
      timers.set(key, timer);
    }

    function findRow(control) {
      if (!control) return null;
      if (typeof control.closest === "function") {
        return (
          control.closest(".option") ||
          control.closest(".theme-customizer") ||
          control.closest(".mobile-settings-group") ||
          control.closest("label") ||
          control
        );
      }
      return control;
    }

    function ensureBadge(row, kind) {
      const key = String(row.id || row.dataset.settingsRow || "");
      const wantedClass = kind === "error" ? ERROR_CLASS : APPLIED_CLASS;
      // A row shows at most one badge; reuse it across ok/error kinds so a
      // save failure followed by a successful save swaps in place.
      let badge = row.querySelector(`.${APPLIED_CLASS}, .${ERROR_CLASS}`);
      const wanted = kind === "error" ? "settings-applied-error" : "settings-applied-ok";
      if (!badge) {
        badge = doc.createElement("span");
        badge.className = wantedClass;
        badge.setAttribute("aria-live", "polite");
        badge.dataset.state = wanted;
        if (key) badge.id = BADGE_ID_PREFIX + key;
        row.appendChild(badge);
      } else {
        badge.className = wantedClass;
        badge.dataset.state = wanted;
      }
      return badge;
    }

    function show(row, kind, message) {
      if (!row) return null;
      const badge = ensureBadge(row, kind);
      badge.textContent = message;
      // Re-append so the badge lands after any content the row re-rendered.
      if (badge.parentNode !== row) row.appendChild(badge);
      scheduleClear(row, badge);
      return badge;
    }

    return {
      flashApplied(control, label = "Applied") {
        return show(findRow(control), "ok", `✓ ${label}`);
      },
      flashAppliedRow(row, label = "Applied") {
        return show(row, "ok", `✓ ${label}`);
      },
      flashError(control, message) {
        return show(findRow(control), "error", message);
      },
      flashErrorRow(row, message) {
        return show(row, "error", message);
      },
      clear(control) {
        const row = findRow(control);
        if (!row) return;
        clearTimer(row);
        const badge = row.querySelector(`.${APPLIED_CLASS}, .${ERROR_CLASS}`);
        if (badge) badge.remove();
      },
      APPLIED_MS,
    };
  }

  const api = { create: createSettingsFeedback, APPLIED_MS };
  root.HerdrSettingsFeedback = api;
  if (typeof module !== "undefined" && module.exports)
    module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);