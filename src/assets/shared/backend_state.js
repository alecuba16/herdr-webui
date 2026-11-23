// Session backend enablement and retargeting.
//
// The desktop bundle (core.js) and the mobile bundle (backend.js) kept two
// copies of this logic. backendEnabled() gates offers and pins against the
// server's enabled_backends map; syncSessionBackendFromServer() retargets a
// pinned-but-disabled backend to the server default (then built-in, then
// whichever remains), persists the choice, and asks the host to cycle the
// events socket so the reconnect stops polling the dead backend.
// Hosts inject their state object, persistence, and their socket-cycle
// callback; the module owns no state and is side-effect-free on load.
(function (root) {
  function backendEnabled(state, backend) {
    const enabled = state.backendsEnabled && state.backendsEnabled[backend];
    return enabled !== false;
  }

  // Returns the retargeted backend, or null when the pin stays valid.
  function retargetDisabledBackend(state) {
    if (!state.sessionBackend) return null;
    if (backendEnabled(state, state.sessionBackend)) return null;
    // Prefer the server's configured default when it is still enabled,
    // then built-in, then whichever remains enabled (the server enforces
    // at least one enabled backend, so a fallback always exists).
    const fallback =
      state.serverDefaultBackend && backendEnabled(state, state.serverDefaultBackend)
        ? state.serverDefaultBackend
        : backendEnabled(state, "builtin")
          ? "builtin"
          : "external-herdr";
    return fallback;
  }

  function createBackendState({ state, writeSessionBackend, onRetarget }) {
    function backendEnabledFor(backend) {
      return backendEnabled(state, backend);
    }

    function syncSessionBackendFromServer() {
      const fallback = retargetDisabledBackend(state);
      if (fallback == null) return;
      state.sessionBackend = fallback;
      if (typeof writeSessionBackend === "function")
        writeSessionBackend(state.session || "default", fallback);
      if (typeof onRetarget === "function") onRetarget(fallback);
    }

    return { backendEnabled: backendEnabledFor, syncSessionBackendFromServer };
  }

  const api = { backendEnabled, retargetDisabledBackend, create: createBackendState };
  root.HerdrBackendState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);