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
    closeEventWs,
    currentSessionBackend,
    backendEnabled,
    sessionBackendLabel,
    sessionBackendClass,
    readSessionBackend,
    readSessionSelection,
    writeSessionBackend,
    forgetSessionState,
    saveSessionSelection,
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
          : `${pill}${status}<span class="mobile-btn danger agent-action" role="button" tabindex="0" ${busy ? "data-disabled=\"1\"" : ""} onclick="event.stopPropagation();HerdrMobile.closeSessionRow(${jsArg(label)},${jsArg(backend)})">Close</span>`;
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
    // Reopening restores the surface the user left: the saved selection
    // (workspace/tab/pane, stored per session+backend by saveSessionSelection)
    // is replayed into the pushed URL so the refresh lands exactly where the
    // user was. A session with no saved selection reopens bare (no
    // auto-open), per the boot-clean rule.
    function switchSession(name, backend) {
      if (backend === "external-herdr" && (!state.herdrCompatible || !backendEnabled("external-herdr")))
        backend = "builtin";
      state.session = name || "default";
      state.sessionBackend = backend || "builtin";
      writeSessionBackend(state.session, state.sessionBackend);
      state.ws = null;
      state.tab = null;
      state.pane = null;
      state.terminalId = null;
      state.workspaces = [];
      state.tabs = [];
      state.allTabs = [];
      state.panes = [];
      destroyTerminal(true);
      closeEventWs();
      const saved = readSessionSelection(state.session, state.sessionBackend);
      if (saved && saved.ws) {
        const path = saved.pane != null && saved.tab != null
          ? `/session/${encodeURIComponent(state.session)}/workspace/${encodeURIComponent(saved.ws)}/tab/${encodeURIComponent(saved.tab)}/pane/${encodeURIComponent(saved.pane)}`
          : saved.tab != null
            ? `/session/${encodeURIComponent(state.session)}/workspace/${encodeURIComponent(saved.ws)}/tab/${encodeURIComponent(saved.tab)}`
            : `/session/${encodeURIComponent(state.session)}/workspace/${encodeURIComponent(saved.ws)}`;
        pushState(null, "", path);
      } else {
        pushState(null, "", sessionPrefix(state.session));
      }
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
    // "Closed" must mean closed with integrity: the POST is sent with the
    // pair captured before any retargeting, an already-stopped target is a
    // success (idempotent close), the per-session pin and saved selections
    // are forgotten so nothing resurrects the closed surface, the terminal
    // and the bound events socket are torn down, and the browser retargets
    // to the server's default backend so the refresh lands on a live target.
    async function closeSession() {
      if (state.sessionBusy) return;
      if (!confirmFn(`Close current ${sessionBackendLabel(currentSessionBackend())} session?`)) return;
      const session = state.session || "default";
      const backend = currentSessionBackend();
      state.sessionBusy = true;
      state.sessionBusyLabel = "Closing session...";
      render();
      try {
        let alreadyStopped = false;
        try {
          await api("/api/session/close", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session, backend }),
          });
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          // already_stopped is the server's idempotent-close marker; the
          // stale-target errors also mean the session is already down. A
          // dead-listener socket (crash without unlink) adds "Connection
          // refused" to that class.
          if (
            /already_stopped|No such file|not running|ENOENT|Connection refused/i.test(
              message,
            )
          ) {
            alreadyStopped = true;
          } else {
            throw e;
          }
        }
        forgetSessionState(session);
        // Retarget so the refresh below lands on a working session (the
        // server auto-starts built-in on demand). The closed session's
        // target is abandoned: retarget the browser to the default session
        // so nothing keeps pointing at the closed surface (staying there
        // would show the offline manager forever). The default session's
        // own stored pin wins when the user had one; only a browser with
        // no pin for it adopts the server's configured default backend.
        const retargetSession = session !== "default" ? "default" : session;
        const retargetBackend =
          readSessionBackend(retargetSession) || state.serverDefaultBackend || "builtin";
        if (session !== "default") {
          state.session = "default";
          history.pushState(null, "", "/session/default");
        }
        state.sessionBackend = retargetBackend;
        writeSessionBackend(state.session || "default", state.sessionBackend);
        state.ws = null;
        state.tab = null;
        state.pane = null;
        destroyTerminal(true);
        closeEventWs();
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

    // Close a row from the sessions list without switching to it first
    // (mobile parity with the desktop closeSessionRow). Closing a different
    // session must not disturb the current target: send the POST for the
    // row's pair, forget the row's stored state, and refresh the list.
    async function closeSessionRow(name, backend) {
      if (state.sessionBusy) return;
      const session = name || "default";
      const rowBackend = backend || "builtin";
      const isCurrent =
        session === (state.session || "default") &&
        rowBackend === currentSessionBackend();
      if (isCurrent) {
        // Closing the current row is exactly closeSession (confirm prompt
        // and full teardown included).
        await closeSession();
        return;
      }
      if (!confirmFn(`Close ${sessionBackendLabel(rowBackend)} session ${session}?`)) return;
      state.sessionBusy = true;
      state.sessionBusyLabel = "Closing session...";
      render();
      try {
        try {
          await api("/api/session/close", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session, backend: rowBackend }),
          });
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          // Dead-listener sockets (backend crashed without unlinking its
          // socket file) surface as "Connection refused"; the session is
          // already down, so closing it is a success like the other stale
          // target errors.
          if (
            !/already_stopped|No such file|not running|ENOENT|Connection refused/i.test(
              message,
            )
          ) {
            throw e;
          }
        }
        forgetSessionState(session);
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
      closeSessionRow,
    };
  }

  globalThis.HerdrMobileSessionsModule = { create: createMobileSessions };
})();