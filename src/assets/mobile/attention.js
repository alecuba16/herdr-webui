(function () {
  function createMobileAttention({ localStorage, state, window }) {
    let audioCtx = null,
      audioUnlocked = false,
      knownAttention = null,
      lastAttentionSound = 0;

    function statusClass(status) {
      return status === "done" ? "done" : status || "unknown";
    }

    function rank(agent) {
      const status = statusClass(agent && agent.agent_status);
      return (
        { blocked: 0, done: 1, unknown: 2, idle: 3, working: 4 }[status] ?? 2
      );
    }

    function sortAgents(agents) {
      return (agents || []).slice().sort((a, b) => rank(a) - rank(b));
    }

    function topStatus() {
      if (!state.agents.length) return "";
      let top = state.agents[0];
      for (const agent of state.agents) {
        if (rank(agent) < rank(top)) top = agent;
      }
      return statusClass(top.agent_status);
    }

    function key(agent) {
      return (
        agent.terminal_id ||
        `${agent.workspace_id}:${agent.tab_id}:${agent.pane_id}`
      );
    }

    function needsAttention(agent) {
      const status = statusClass(agent && agent.agent_status);
      return status === "blocked" || status === "done";
    }

    function options() {
      try {
        const parsed = JSON.parse(
          localStorage.getItem("herdr-web-options") || "{}",
        );
        return {
          sound: parsed.sound !== false,
          browserNotifications: parsed.browserNotifications === true,
          soundScope: parsed.soundScope === "all" ? "all" : "current",
        };
      } catch (_) {
        return { sound: true, browserNotifications: false, soundScope: "current" };
      }
    }

    function shouldPlay(agents) {
      const currentOptions = options();
      if (!currentOptions.sound) return false;
      if (currentOptions.soundScope === "all") return true;
      return agents.some(
        (agent) =>
          agent.workspace_id === state.ws &&
          agent.tab_id === state.tab &&
          agent.pane_id === state.pane,
      );
    }

    function handleSound() {
      const attentionAgents = state.agents.filter(needsAttention);
      const current = new Set(attentionAgents.map(key));
      if (knownAttention === null) {
        knownAttention = current;
        return;
      }
      const newlyAttentioned = attentionAgents.filter(
        (agent) => !knownAttention.has(key(agent)),
      );
      knownAttention = current;
      if (newlyAttentioned.length && shouldPlay(newlyAttentioned)) play();
      if (newlyAttentioned.length) notify(newlyAttentioned);
    }

    function notify(agents) {
      const currentOptions = options();
      if (!currentOptions.browserNotifications || !("Notification" in window)) return;
      if (window.Notification.permission !== "granted") return;
      for (const agent of agents.slice(0, 3)) {
        try {
          new window.Notification(notificationTitle(agent), {
            body: notificationBody(agent),
            icon: "/favicon-attention.svg",
            tag: key(agent),
          });
        } catch (_) {}
      }
    }

    function notificationTitle(agent) {
      return statusClass(agent.agent_status) === "blocked" ? "Agent blocked" : "Agent done";
    }

    function notificationBody(agent) {
      return agent.name || agent.display_agent || agent.agent || agent.terminal_id || "Agent needs attention";
    }

    function unlockAudio() {
      if (audioUnlocked) return;
      try {
        audioCtx =
          audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        audioUnlocked = true;
      } catch (_) {}
    }

    function play() {
      if (!audioUnlocked) return;
      const now = Date.now();
      if (now - lastAttentionSound < 1500) return;
      lastAttentionSound = now;
      if (!audioCtx || audioCtx.state !== "running") return;
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
      oscillator.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        audioCtx.currentTime + 0.22,
      );
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.24);
    }

    return { handleSound, sortAgents, statusClass, topStatus, unlockAudio };
  }

  globalThis.HerdrMobileAttention = { create: createMobileAttention };
})();
