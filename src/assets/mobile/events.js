(function () {
  function createMobileEvents({
    document,
    globalThisWebSocket,
    wsUrl,
    refresh,
    handleServerSettingsChanged,
    getTempTerminal,
  }) {
    let eventWs = null;
    let eventRefreshTimer = null;
    let eventReconnectTimer = null;
    let eventStateListeners = [];

    function notifyEventState(connected) {
      for (const listener of eventStateListeners) {
        try { listener(!!connected); } catch (_) {}
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
      notifyEventState(true);
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
          const evt = msg && msg.event;
          kind = evt && (evt.event || evt.type);
          const data = (evt && evt.data) || {};
          if (kind === "pane.exited") {
            const tempTerminal = getTempTerminal();
            if (tempTerminal && tempTerminal.handlePaneExited)
              tempTerminal.handlePaneExited(data.pane_id);
          }
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
      try {
        eventWs.close();
      } catch (e) {}
      eventWs = null;
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