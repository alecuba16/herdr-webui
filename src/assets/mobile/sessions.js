(function () {
  function createMobileSessions({
    state,
    api,
    render,
    escapeHtml,
    jsArg,
    localStorage,
    confirmFn,
    loadSessions,
    refresh,
    connectEvents,
    destroyTerminal,
    sessionPrefix,
    pushState,
    syncBackendBadge,
    getEventWs,
    setEventWs,
    currentSessionBackend,
    backendEnabled,
    sessionBackendLabel,
    sessionBackendClass,
  }) {
    function renderSessions() {
      const busy = !!state.sessionBusy;
      const loading = busy ? `<div class="mobile-loading">${escapeHtml(state.sessionBusyLabel || "Working...")}</div>` : "";
      const error = state.sessionsError ? `<div class="mobile-error">${escapeHtml(state.sessionsError)}</div>` : "";
      const current = `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`;
      const rows = (state.sessions || []).map((row) => {
        const backend = row.backend || (backendEnabled("external-herdr") ? "external-herdr" : "builtin");
        const active =
          row.name === state.session && backend === currentSessionBackend();
        const label = row.name || "default";
        const pill = `<span class="mobile-chip ${sessionBackendClass(backend)}">${escapeHtml(row.backend_label || sessionBackendLabel(backend))}</span>`;
        const status = row.running
          ? '<span class="mobile-chip">running</span>'
          : '<span class="mobile-chip">offline</span>';
        const controls = active
          ? `${pill}<span class="mobile-btn agent-action" role="button" tabindex="0" ${busy ? "data-disabled=\"1\"" : ""} onclick="event.stopPropagation();HerdrMobile.refreshSessions()">Retry</span><span class="mobile-btn danger agent-action" role="button" tabindex="0" ${busy ? "data-disabled=\"1\"" : ""} onclick="event.stopPropagation();HerdrMobile.closeSession()">Close</span>`
          : `${pill}${status}`;
        return `<button class="mobile-row${active ? " active" : ""}" onclick="HerdrMobile.selectSession(${jsArg(label)},${jsArg(backend)})"><strong>${escapeHtml(label)}${active ? " · current" : ""}</strong><span>${controls}</span></button>`;
      }).join("");
      const herdrUsable = state.herdrCompatible && backendEnabled("external-herdr");
      return `<section class="mobile-section mobile-form"><h2>Sessions</h2><p class="mobile-help">Current target: ${escapeHtml(current)}. Tap a session to switch, or create a new one.</p><div class="mobile-settings-group"><h3>Known sessions</h3>${rows ? rows : '<div class="mobile-loading">No sessions found yet</div>'}${loading}${error}</div><details class="mobile-settings-group mobile-disclosure" ${state.sessionCreateExpanded ? "open" : ""} onchange="HerdrMobile.setSessionCreateExpanded(this.open)"><summary>Create new session</summary><label><span>Session name</span><input value="${escapeHtml(state.sessionNameInput)}" oninput="HerdrMobile.updateSessionField('sessionNameInput', this.value)" placeholder="revolut"></label><div class="mobile-session-actions"><button class="mobile-btn primary" ${busy ? "disabled" : ""} onclick="HerdrMobile.newSession('builtin')">New built-in</button>${herdrUsable ? `<button class="mobile-btn" ${busy ? "disabled" : ""} onclick="HerdrMobile.newSession('external-herdr')">New Herdr</button>` : ""}</div></details></section>`;
    }

    async function refreshSessions() {
      if (state.sessionBusy) return;
      state.sessionBusy = true;
      state.sessionBusyLabel = "Loading sessions...";
      render();
      try {
        await loadSessions();
      } finally {
        state.sessionBusy = false;
        state.sessionBusyLabel = "";
        render();
      }
    }

    function updateSessionField(field, value) {
      state[field] = value;
    }

    function setSessionCreateExpanded(open) {
      state.sessionCreateExpanded = !!open;
    }

    // Launch a new session on the chosen backend and switch the browser to
    // it (mobile parity with the desktop newSessionTarget flow).
    async function newSession(backend) {
      const name = (state.sessionNameInput || "").trim();
      if (!name) {
        state.sessionsError = "Session name is required.";
        render();
        return;
      }
      if (backend === "external-herdr" && !backendEnabled("external-herdr")) {
        state.sessionsError = "External Herdr sessions are disabled in server settings.";
        render();
        return;
      }
      if (backend === "external-herdr" && !state.herdrCompatible) {
        state.sessionsError = state.herdrAvailable
          ? `Detected herdr ${state.herdrVersion || ""} is not compatible with this WebUI build. Upgrade herdr or use a built-in session.`
          : "No compatible herdr install detected. Install herdr to use external Herdr sessions.";
        render();
        return;
      }
      state.sessionBusy = true;
      state.sessionBusyLabel = "Launching session...";
      render();
      try {
        const r = await api("/api/session/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: name, backend }),
        });
        if (!r.ok) throw Error(r.error || "Launch failed");
        await switchSession(name, backend);
        state.sessionNameInput = "";
        state.sessionCreateExpanded = false;
      } catch (e) {
        state.sessionsError = e.message || String(e);
      } finally {
        state.sessionBusy = false;
        state.sessionBusyLabel = "";
        render();
        setTimeout(refreshSessions, 400);
      }
    }

    // Switch the browser target to a session (mobile parity with the desktop
    // goSession flow: route, terminal, events socket, and list refresh).
    function switchSession(name, backend) {
      if (backend === "external-herdr" && (!state.herdrCompatible || !backendEnabled("external-herdr")))
        backend = "builtin";
      state.session = name || "default";
      state.sessionBackend = backend || "builtin";
      localStorage.setItem("herdr-session-backend", state.sessionBackend);
      state.ws = null;
      state.tab = null;
      state.pane = null;
      state.terminalId = null;
      state.workspaces = [];
      state.tabs = [];
      state.allTabs = [];
      state.panes = [];
      destroyTerminal(true);
      const ws = getEventWs();
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch (e) {}
        setEventWs(null);
      }
      pushState(null, "", sessionPrefix(state.session));
      syncBackendBadge();
      refresh();
      connectEvents();
    }

    async function selectSession(name, backend) {
      if (name === state.session && backend === currentSessionBackend()) {
        // Tapping the current row just refreshes the list.
        refreshSessions();
        return;
      }
      switchSession(name, backend);
    }

    // Close the active session (mobile parity with closeCurrentSession).
    async function closeSession() {
      if (state.sessionBusy) return;
      if (!confirmFn(`Close current ${sessionBackendLabel(currentSessionBackend())} session?`)) return;
      state.sessionBusy = true;
      state.sessionBusyLabel = "Closing session...";
      render();
      try {
        await api("/api/session/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: state.session || "default", backend: currentSessionBackend() }),
        });
        // Retarget the server's default backend so the refresh below lands
        // on a working session (the server auto-starts built-in on demand).
        state.sessionBackend = state.serverDefaultBackend || "builtin";
        localStorage.setItem("herdr-session-backend", state.sessionBackend);
        state.ws = null;
        state.tab = null;
        state.pane = null;
        destroyTerminal(true);
        const ws = getEventWs();
        if (ws) {
          ws.onclose = null;
          try {
            ws.close();
          } catch (e) {}
          setEventWs(null);
        }
        refresh();
        connectEvents();
      } catch (e) {
        state.sessionsError = e.message || String(e);
      } finally {
        state.sessionBusy = false;
        state.sessionBusyLabel = "";
        render();
        setTimeout(refreshSessions, 400);
      }
    }

    return {
      renderSessions,
      refreshSessions,
      updateSessionField,
      setSessionCreateExpanded,
      newSession,
      selectSession,
      closeSession,
    };
  }

  globalThis.HerdrMobileSessionsModule = { create: createMobileSessions };
})();