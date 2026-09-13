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

    function scheduleEventRefresh() {
      if (eventRefreshTimer || document.hidden) return;
      eventRefreshTimer = setTimeout(() => {
        eventRefreshTimer = null;
        if (document.hidden) return;
        return refresh();
      }, 120);
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
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === "server_settings_changed") {
            handleServerSettingsChanged(msg);
          }
          const evt = msg && msg.event;
          const kind = evt && (evt.event || evt.type);
          const data = (evt && evt.data) || {};
          if (kind === "pane.exited") {
            const tempTerminal = getTempTerminal();
            if (tempTerminal && tempTerminal.handlePaneExited)
              tempTerminal.handlePaneExited(data.pane_id);
          }
        } catch (_) {}
        scheduleEventRefresh();
      };
      ws.onclose = () => {
        if (eventWs === ws) eventWs = null;
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
    };
  }

  globalThis.HerdrMobileEventsModule = { create: createMobileEvents };
})();