(function () {
  function createMobileBackend({
    state,
    api,
    confirmFn,
    localStorage,
    refresh,
    getMobileEvents,
  }) {
    let herdrErrorOfferPending = false;

    async function loadServerSettings() {
      try {
        const settings = await api("/api/server-settings");
        state.backendMode = settings.backend_mode || state.backendMode;
        state.defaultFolder = settings.default_folder || state.defaultFolder || "";
        // The server's default backend derives from its configured mode and
        // the enablement flags; record it before syncing so a disabled pin
        // retargets accurately.
        if (settings.backend_mode)
          state.serverDefaultBackend =
            settings.backend_mode === "external" || settings.backend_mode === "external-herdr"
              ? "external-herdr"
              : "builtin";
        // The server's enabled_backends is authoritative: a tab pinned before
        // a backend was disabled mid-session must retarget instead of
        // silently rerouting. Older servers omit the field; unknown never gates.
        if (settings.enabled_backends) {
          state.backendsEnabled = {
            builtin: settings.enabled_backends.builtin !== false,
            "external-herdr": settings.enabled_backends["external-herdr"] !== false,
          };
          syncSessionBackendFromServer();
        }
        // Built-in is the default backend. On first load adopt the server's
        // configured mode so stale localStorage cannot lock the browser into an
        // unexpected backend; afterwards keep the user's explicit choice.
        if (!state.serverBackendConfirmed && state.backendMode) {
          state.sessionBackend =
            state.backendMode === "external" || state.backendMode === "external-herdr"
              ? "external-herdr"
              : state.backendMode === "builtin"
                ? "builtin"
                : state.sessionBackend;
          localStorage.setItem("herdr-session-backend", state.sessionBackend);
        }
        state.serverBackendConfirmed = true;
      } catch (_) {}
      await loadSessions();
    }

    // Fetch the known sessions plus the herdr install/enablement state.
    // Shared by the init flow and the mobile sessions screen so the screen
    // always reflects the server's view.
    async function loadSessions() {
      try {
        const r = await api("/api/sessions");
        state.sessions = r.sessions || [];
        state.sessionsError = "";
        // External herdr sessions are only offered when a compatible herdr
        // install is detected. If it is missing or incompatible, fall back to
        // built-in instead of targeting a guaranteed-failed attach.
        state.herdrAvailable = !!r.herdr_available;
        state.herdrCompatible = !!r.herdr_compatible;
        state.herdrVersion = r.herdr_version || null;
        if (r.default_backend) state.serverDefaultBackend = r.default_backend;
        if (r.enabled_backends) {
          state.backendsEnabled = {
            builtin: r.enabled_backends.builtin !== false,
            "external-herdr": r.enabled_backends["external-herdr"] !== false,
          };
          syncSessionBackendFromServer();
        }
        if (currentSessionBackend() === "external-herdr" && !state.herdrCompatible) {
          state.sessionBackend = "builtin";
          localStorage.setItem("herdr-session-backend", "builtin");
        }
      } catch (e) {
        state.sessions = [
          { name: state.session || "default", backend: currentSessionBackend(), running: false },
        ];
        state.sessionsError = e.message || String(e);
      }
    }

    // Graceful degradation: the external herdr backend could not be attached
    // (protocol mismatch, unreachable...). Close the broken session and offer
    // a built-in session instead of leaving the terminal blocked.
    function handleHerdrErrorFrame(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return false;
      }
      if (!msg || msg.type !== "herdr_error") return false;
      if (herdrErrorOfferPending) return true;
      herdrErrorOfferPending = true;
      (async () => {
        try {
          if (currentSessionBackend() === "external-herdr") {
            try {
              await api("/api/session/close", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ session: state.session || "default", backend: "external-herdr" }),
              });
            } catch (_) {}
          }
          const detail = msg.message ? ` (${msg.message})` : "";
          // The server reroutes disabled backends to the remaining enabled
          // one, so the frame may be about the backend actually serving this
          // browser, not the stale external pin. Say which backend failed.
          const failedBackend = msg.backend || currentSessionBackend();
          const failedLabel = sessionBackendLabel(failedBackend);
          // Only offer built-in when the settings allow it; otherwise fall
          // through to the manager so the user picks an enabled target
          // instead of silently rerouting to a disabled backend.
          const wantsBuiltin =
            backendEnabled("builtin") &&
            confirmFn(
              `The ${failedLabel} backend could not be attached${detail}. ` +
                "It has been disconnected. Start a built-in session instead?",
            );
          if (wantsBuiltin) {
            try {
              await api("/api/session/launch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ session: state.session || "default", backend: "builtin" }),
              });
            } catch (_) {}
            state.sessionBackend = "builtin";
            localStorage.setItem("herdr-session-backend", "builtin");
            refresh();
          }
        } finally {
          herdrErrorOfferPending = false;
        }
      })();
      return true;
    }

    function currentSessionBackend() {
      if (state.sessionBackend === "external") return "external-herdr";
      if (state.sessionBackend === "builtin" || state.sessionBackend === "external-herdr")
        return state.sessionBackend;
      if (state.backendMode === "external" || state.backendMode === "external-herdr")
        return "external-herdr";
      if (state.backendMode === "builtin") return "builtin";
      return "";
    }
    // True when the server settings allow the given backend. Unknown (null,
    // from an older server that omits enabled_backends) never disables anything.
    function backendEnabled(backend) {
      const enabled = state.backendsEnabled && state.backendsEnabled[backend];
      return enabled !== false;
    }
    // Re-validate the pinned backend against the server's enabled backends:
    // a tab that pinned a backend before it was disabled mid-session must
    // retarget instead of silently rerouting every request. Prefer the
    // server's default backend (from /api/versions or the settings-change
    // broadcast) when still enabled, then built-in, then whichever remains
    // enabled (the server enforces at least one enabled backend).
    function syncSessionBackendFromServer() {
      if (!state.sessionBackend) return;
      if (backendEnabled(state.sessionBackend)) return;
      const fallback =
        state.serverDefaultBackend && backendEnabled(state.serverDefaultBackend)
          ? state.serverDefaultBackend
          : backendEnabled("builtin")
            ? "builtin"
            : "external-herdr";
      state.sessionBackend = fallback;
      localStorage.setItem("herdr-session-backend", fallback);
      // The events socket is bound to the disabled backend through its URL
      // query (?backend=...). Cycle it so the reconnect targets the fallback
      // backend instead of polling the dead one until a manual reload.
      const events = getMobileEvents && getMobileEvents();
      if (events) {
        events.closeEventWs();
        events.scheduleEventReconnect();
      }
    }
    function sessionBackendLabel(backend) {
      return backend === "external-herdr" ? "Herdr" : "built-in";
    }
    function sessionBackendClass(backend) {
      return backend === "external-herdr" ? "backend-herdr" : "backend-builtin";
    }

    function handleServerSettingsChanged(msg) {
      const enabled = msg.enabled_backends;
      if (!enabled) return;
      state.backendsEnabled = {
        builtin: enabled.builtin !== false,
        "external-herdr": enabled["external-herdr"] !== false,
      };
      if (msg.default_backend) state.serverDefaultBackend = msg.default_backend;
      syncSessionBackendFromServer();
      refresh();
    }

    return {
      loadServerSettings,
      loadSessions,
      handleHerdrErrorFrame,
      currentSessionBackend,
      backendEnabled,
      syncSessionBackendFromServer,
      sessionBackendLabel,
      sessionBackendClass,
      handleServerSettingsChanged,
    };
  }

  globalThis.HerdrMobileBackendModule = { create: createMobileBackend };
})();