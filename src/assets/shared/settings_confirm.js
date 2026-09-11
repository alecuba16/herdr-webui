// Settings confirm / rollback chrome.
//
// Local settings rows get explicit confirmation affordances:
// - Text-like inputs (text, number, range) only save after Enter or the
//   yellow pencil button. While the on-screen value differs from the saved
//   value, the row shows the pencil (hover hint: "Enter or press to
//   confirm") and a rollback arrow that restores the saved value.
// - Selects and checkboxes still apply immediately through their own change
//   handlers, but the row shows a rollback arrow that restores the value
//   saved when the settings screen was opened (or last confirmed).
//
// The module is layout-agnostic: desktop passes `.option` rows, mobile
// passes label rows. It never performs the save itself; it calls back into
// the host's save and read functions so each layout keeps its own option
// pipeline (HerdrOptions storage, normalize, apply).
(function (root) {
  const PENCIL_CLASS = "settings-confirm-pencil";
  const ROLLBACK_CLASS = "settings-rollback";
  const PENDING_CLASS = "settings-pending";

  function createSettingsConfirm({
    document,
    save,
    read,
    onRollback,
  }) {
    const doc = document;
    const rows = new Map(); // row -> { control, pencil, rollback, savedValue, selectLike }

    function controlValue(control) {
      if (!control) return "";
      if (control.type === "checkbox") return control.checked === true;
      const value = String(control.value == null ? "" : control.value);
      return value.trim();
    }

    function valuesEqual(a, b) {
      return String(a) === String(b);
    }

    function isSelectLike(control) {
      if (!control) return false;
      const tag = String(control.tagName || "").toUpperCase();
      if (tag === "SELECT") return true;
      if (tag !== "INPUT") return false;
      const type = String(control.type || "").toLowerCase();
      // Range sliders apply on release (a discrete gesture, like selects)
      // and expose the rollback arrow instead of pending chrome.
      return type === "checkbox" || type === "range";
    }

    function displayValue(info) {
      // The saved value as it should appear in the control. Hosts whose
      // stored option differs from the control representation (range 0-100
      // vs stored 0-1) map it in their read() callback, so savedValue is
      // always comparable to controlValue().
      return info.savedValue === true
        ? "true"
        : info.savedValue === false
          ? "false"
          : String(info.savedValue == null ? "" : info.savedValue);
    }

    function findRow(control) {
      if (!control) return null;
      if (typeof control.closest === "function") {
        return (
          control.closest(".option") ||
          control.closest(".theme-customizer") ||
          control.closest("label") ||
          control.closest(".mobile-settings-group") ||
          control
        );
      }
      return control;
    }

    function ensurePencil(row, info) {
      let pencil = row.querySelector(`.${PENCIL_CLASS}`);
      if (!pencil) {
        pencil = doc.createElement("button");
        pencil.type = "button";
        pencil.className = PENCIL_CLASS;
        pencil.setAttribute("aria-label", "Enter or press to confirm");
        pencil.title = "Enter or press to confirm";
        pencil.textContent = "✎";
        pencil.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          commit(row, info);
        };
        row.appendChild(pencil);
      }
      return pencil;
    }

    function ensureRollback(row, info) {
      let rollback = row.querySelector(`.${ROLLBACK_CLASS}`);
      if (!rollback) {
        rollback = doc.createElement("button");
        rollback.type = "button";
        rollback.className = ROLLBACK_CLASS;
        rollback.setAttribute("aria-label", "Roll back this change");
        rollback.title = "Roll back this change";
        rollback.textContent = "↺";
        rollback.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          rollbackRow(row, info);
        };
        row.appendChild(rollback);
      }
      return rollback;
    }

    function paint(row, info) {
      const pending = !valuesEqual(controlValue(info.control), displayValue(info));
      row.classList.toggle(PENDING_CLASS, pending);
      if (info.selectLike) {
        // Selects and checkboxes commit immediately; only the rollback
        // affordance appears while the value differs from the baseline.
        if (info.pencil) {
          info.pencil.remove();
          info.pencil = null;
        }
        info.rollback = ensureRollback(row, info);
        info.rollback.style.display = pending ? "" : "none";
      } else {
        info.pencil = ensurePencil(row, info);
        info.rollback = ensureRollback(row, info);
        info.pencil.style.display = pending ? "" : "none";
        info.rollback.style.display = pending ? "" : "none";
      }
    }

    function commit(row, info) {
      save(info.control, controlValue(info.control));
      info.savedValue = read(info.control);
      if (!info.selectLike) {
        // Clamped commits (number inputs, ranges) re-sync the control so
        // the row reflects the value that was actually saved.
        const shown = displayValue(info);
        if (!valuesEqual(controlValue(info.control), shown)) {
          info.control.value =
            info.savedValue === true || info.savedValue === false
              ? String(info.savedValue)
              : shown;
        }
      }
      paint(row, info);
    }

    function rollbackRow(row, info) {
      const target = info.savedValue;
      if (info.control && info.control.type === "checkbox") {
        info.control.checked = target === true;
      } else if (info.control) {
        info.control.value = target === true
          ? "true"
          : target === false
            ? "false"
            : String(target == null ? "" : target);
      }
      const canDispatch =
        info.control &&
        typeof info.control.dispatchEvent === "function" &&
        typeof (root.Event ||
          (doc.defaultView && doc.defaultView.Event)) === "function";
      if (canDispatch && info.selectLike) {
        // Programmatic value changes fire no DOM events; dispatch input
        // then change so hosts bound to either (range sliders use input,
        // selects use change) persist the restored value.
        const EventCtor = root.Event || doc.defaultView.Event;
        info.control.dispatchEvent(new EventCtor("input", { bubbles: true }));
        info.control.dispatchEvent(new EventCtor("change", { bubbles: true }));
      } else if (onRollback) {
        onRollback(info.control, target);
      }
      paint(row, info);
    }

    function wireKeydown(row, info) {
      const control = info.control;
      if (!control || info.keydownWired) return;
      info.keydownWired = true;
      control.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        if (isSelectLike(control)) return;
        event.preventDefault();
        commit(row, info);
      });
    }

    function watch(row, control) {
      if (!row || !control) return;
      let info = rows.get(row);
      if (!info) {
        info = {
          control,
          pencil: null,
          rollback: null,
          savedValue: "",
          selectLike: false,
          wired: false,
        };
        rows.set(row, info);
      }
      info.control = control;
      info.selectLike = isSelectLike(control);
      // Baseline is re-read on every watch call: hosts sync controls from
      // saved options right before watching, so this captures the value
      // saved when the settings screen was opened.
      info.savedValue = read(control);
      if (!info.wired) {
        info.wired = true;
        if (info.selectLike) {
          // Immediate-commit controls keep their baseline; the change
          // listener only repaints, so the rollback arrow stays available
          // until the user rolls back or reopens the settings screen.
          control.addEventListener("change", () => paint(row, info));
        } else {
          control.addEventListener("input", () => paint(row, info));
          wireKeydown(row, info);
        }
      }
      paint(row, info);
    }

    function refreshAll() {
      for (const [row, info] of rows) {
        info.savedValue = read(info.control);
        paint(row, info);
      }
    }

    return {
      watch,
      refreshAll,
      commit(row) {
        const info = rows.get(row);
        if (info) commit(row, info);
      },
      rollback(row) {
        const info = rows.get(row);
        if (info) rollbackRow(row, info);
      },
      refresh(row, control) {
        const info = rows.get(row);
        if (!info) return watch(row, control);
        info.control = control || info.control;
        info.savedValue = read(info.control);
        paint(row, info);
      },
      PENCIL_CLASS,
      ROLLBACK_CLASS,
      PENDING_CLASS,
    };
  }

  const api = { create: createSettingsConfirm };
  root.HerdrSettingsConfirm = api;
  if (typeof module !== "undefined" && module.exports)
    module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);