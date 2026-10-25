(function () {
  function createMobileEvents({
    document,
    globalThisWebSocket,
    wsUrl,
    refresh,
    handleServerSettingsChanged,
    handleNotesChanged,
    handleAgentStatusChanged,
  }) {
    let eventWs = null;
    let eventRefreshTimer = null;
    let eventReconnectTimer = null;
    let eventStateListeners = [];
    // closeEventWs is the only intentional disconnect (session switch,
    // backend retarget). Listeners use the flag to skip outage UX (the
    // offline banner) that only belongs to real drops: an intentional
    // close always has a reconnect already scheduled.
    let eventCloseIntentional = false;

    function notifyEventState(connected) {
      for (const listener of eventStateListeners) {
        try { listener(!!connected, { intentional: !connected && eventCloseIntentional }); } catch (_) {}
      }
    }

    function onEventState(listener) {
      if (typeof listener === "function") eventStateListeners.push(listener);
      return () => {
        eventStateListeners = eventStateListeners.filter((item) => item !== listener);
      };
    }

    // Same distinction the desktop makes: structure-changing events get a
    // fast refresh so close/open transitions feel immediate, everything
    // else coalesces into the slower refresh.
    const FAST_REFRESH_EVENTS = new Set([
      "pane.closed",
      "pane.exited",
      "tab.closed",
      "workspace.closed",
      "worktree.created",
      "worktree.opened",
      "worktree.removed",
    ]);

    function scheduleEventRefresh(kind) {
      if (eventRefreshTimer || document.hidden) return;
      const delay = kind && FAST_REFRESH_EVENTS.has(kind) ? 50 : 500;
      eventRefreshTimer = setTimeout(() => {
        eventRefreshTimer = null;
        if (document.hidden) return;
        return refresh();
      }, delay);
    }

    function scheduleEventReconnect() {
      if (eventReconnectTimer || document.hidden) return;
      eventReconnectTimer = setTimeout(() => {
        eventReconnectTimer = null;
        if (document.hidden) return;
        connectEvents();
      }, 1500);
    }

    function connectEvents() {
      if (eventWs || !globalThisWebSocket || document.hidden) return;
      const ws = new globalThisWebSocket(wsUrl("/ws/events"));
      eventWs = ws;
      // Optimistic connect: a fresh WebSocket object exists but the
      // handshake has not run yet, so "connected" would be a lie during
      // an outage (a dead server accepts nothing: onopen never fires and
      // onclose arrives only after the browser's own connect timeout,
      // tens of seconds on some platforms). The dot stays "connecting"
      // until onopen proves the stream is live; listeners below fire on
      // the true state transitions only.
      ws.onopen = () => {
        if (eventWs === ws) notifyEventState(true);
      };
      // Tell the shared lsp.js module a page-level events socket exists;
      // while frames keep arriving it will not open its own private one.
      const LspRegister = globalThis.HerdrLsp;
      if (LspRegister && LspRegister.registerEventsBus) {
        try { LspRegister.registerEventsBus(); } catch (_) {}
      }
      ws.onmessage = (event) => {
        // Feed every frame to the LSP diagnostics bus; the shared lsp.js
        // module filters lsp.diagnostics and skips its own private
        // socket while this feed stays fresh.
        const Lsp = globalThis.HerdrLsp;
        if (Lsp && Lsp.feedEventsFrame) {
          try { Lsp.feedEventsFrame(event.data); } catch (_) {}
        }
        let kind = null;
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === "server_settings_changed") {
            handleServerSettingsChanged(msg);
          }
          if (msg && msg.type === "notes_changed" && handleNotesChanged) {
            // Notes snapshots are panel-local: adopt them without the
            // global refresh a generic event would schedule.
            try { handleNotesChanged(msg); } catch (_) {}
          }
          const evt = msg && msg.event;
          // Per-pane agent status: the mobile lens caches these to gate
          // the working indicator and the decision chooser fresher than
          // the coalesced refresh would allow. The refresh still runs;
          // the lens renders from its own cache.
          if (
            evt && evt.event === "pane.agent_status_changed" &&
            typeof handleAgentStatusChanged === "function"
          ) {
            try { handleAgentStatusChanged(evt.data || evt); } catch (_) {}
          }
          kind = evt && (evt.event || evt.type);
        } catch (_) {}
        scheduleEventRefresh(kind);
      };
      ws.onclose = () => {
        if (eventWs === ws) eventWs = null;
        notifyEventState(false);
        scheduleEventReconnect();
      };
    }

    function closeEventWs() {
      if (!eventWs) return;
      eventWs.onclose = null;
      eventCloseIntentional = true;
      try {
        eventWs.close();
      } catch (e) {}
      eventWs = null;
      // Intentional close (session switch, backend retarget) must not
      // leave listeners believing the stream is live: the reconnect that
      // follows re-notifies on its own onopen.
      notifyEventState(false);
      eventCloseIntentional = false;
    }

    return {
      scheduleEventRefresh,
      scheduleEventReconnect,
      connectEvents,
      closeEventWs,
      onEventState,
    };
  }

  globalThis.HerdrMobileEventsModule = { create: createMobileEvents };
})();