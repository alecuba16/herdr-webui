// Shared agent-attention helpers for desktop and mobile layouts.
//
// Owns two concerns that must not drift between layouts:
// 1. Agent sorting: `agentSortMode` ("off" | "attention" |
//    "attention_inverted") plus `agentStatusOrder` group order, with the
//    same normalization and working-first preset as the desktop settings.
// 2. Stuck-working dismissals: localStorage-persisted local overrides that
//    hide a "working" agent until its status changes, its signature
//    changes, or the TTL expires. Desktop and mobile share one storage
//    key so both layouts agree on what is dismissed.
(function () {
  var STORAGE_KEY = "herdr-web-working-dismissals";

  var DEFAULT_AGENT_STATUS_ORDER = ["blocked", "idle", "done", "other", "working"];
  var WORKING_FIRST_AGENT_STATUS_ORDER = ["blocked", "working", "other", "done", "idle"];
  var STATUS_GROUP_KEYS = ["idle", "working", "blocked", "done", "other"];

  function statusClass(status) {
    return status === "done" ? "done" : status || "unknown";
  }

  function normalizeAgentStatusOrder(value) {
    var seen = {};
    var order = [];
    var input = Array.isArray(value) ? value : [];
    for (var i = 0; i < input.length; i++) {
      var key = input[i];
      if (STATUS_GROUP_KEYS.indexOf(key) !== -1 && !seen[key]) {
        seen[key] = true;
        order.push(key);
      }
    }
    for (var j = 0; j < DEFAULT_AGENT_STATUS_ORDER.length; j++) {
      var fallback = DEFAULT_AGENT_STATUS_ORDER[j];
      if (!seen[fallback]) {
        seen[fallback] = true;
        order.push(fallback);
      }
    }
    return order;
  }

  function readOptions() {
    try {
      return globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
    } catch (e) {
      return {};
    }
  }

  function sortConfig() {
    var options = readOptions();
    var mode = options.agentSortMode;
    if (mode !== "attention" && mode !== "attention_inverted") mode = "off";
    var order = normalizeAgentStatusOrder(options.agentStatusOrder);
    if (mode === "attention_inverted" && !hasStoredOrder(options)) {
      order = normalizeAgentStatusOrder(WORKING_FIRST_AGENT_STATUS_ORDER);
    }
    return { mode: mode, order: order };
  }

  function hasStoredOrder(options) {
    return Object.prototype.hasOwnProperty.call(options || {}, "agentStatusOrder");
  }

  function sortAgents(agents, options) {
    var list = Array.isArray(agents) ? agents.slice() : [];
    var config = sortConfig();
    if (config.mode !== "off") {
      return list.sort(function (a, b) {
        return attentionRank(a, config.order) - attentionRank(b, config.order);
      });
    }
    // Default mode still floats agents that need attention (blocked first,
    // then done) above idle/working, matching both layouts' old behavior.
    return list.sort(function (a, b) {
      return fallbackRank(a) - fallbackRank(b);
    });
  }

  function fallbackRank(agent) {
    var status = statusClass(agent && agent.agent_status);
    return { blocked: 0, done: 1, unknown: 2, idle: 3, working: 4 }[status] ?? 2;
  }

  function attentionRank(agent, order) {
    var status = statusClass(agent && agent.agent_status);
    var group = STATUS_GROUP_KEYS.slice(0, 4).indexOf(status) !== -1 ? status : "other";
    var rank = order.indexOf(group);
    return rank >= 0 ? rank : order.length;
  }

  // Stuck-working dismissals --------------------------------------------

  function createDismissals(_ref) {
    var getOptions = _ref.getOptions;
    var storage = _ref.localStorage;
    var onRender = _ref.onRender;
    var cache = null;

    function load() {
      if (!storage) return {};
      try {
        var parsed = JSON.parse(storage.getItem(STORAGE_KEY));
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    function save() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(cache || {}));
      } catch (e) {}
    }

    function enabled() {
      var options = getOptions();
      return options.stuckWorkingEnabled !== false;
    }

    function ttlMs() {
      var options = getOptions();
      var minutes = Math.max(1, Number(options.workingDismissMinutes) || 30);
      return Math.min(1440, minutes) * 60 * 1000;
    }

    function agentKey(agent) {
      return (
        agent.terminal_id ||
        agent.workspace_id + ":" + agent.tab_id + ":" + agent.pane_id
      );
    }

    function agentSignature(agent) {
      return [
        agent.workspace_id,
        agent.tab_id,
        agent.pane_id,
        agent.terminal_id,
        agent.name || agent.display_agent || agent.agent || "",
      ].join("|");
    }

    function isWorkingDismissed(agent) {
      if (!enabled()) return false;
      if (statusClass(agent.agent_status) !== "working") return false;
      if (cache === null) cache = load();
      var entry = cache[agentKey(agent)];
      return !!entry && entry.signature === agentSignature(agent) && Date.now() - entry.dismissedAt <= ttlMs();
    }

    function dismissedRank(agent) {
      return isWorkingDismissed(agent) ? "idle" : statusClass(agent.agent_status);
    }

    function dismiss(agent) {
      if (!agent || statusClass(agent.agent_status) !== "working") return;
      if (cache === null) cache = load();
      cache[agentKey(agent)] = {
        dismissedAt: Date.now(),
        signature: agentSignature(agent),
      };
      save();
      if (onRender) onRender();
    }

    function restore(agent) {
      if (cache === null) cache = load();
      delete cache[agentKey(agent)];
      save();
      if (onRender) onRender();
    }

    function clearForTerminal(terminalId) {
      if (!terminalId) return;
      if (cache === null) cache = load();
      if (!cache[terminalId]) return;
      delete cache[terminalId];
      save();
      if (onRender) onRender();
    }

    function cleanup(agents) {
      if (cache === null) cache = load();
      if (!enabled()) {
        if (Object.keys(cache).length) {
          cache = {};
          save();
        }
        return;
      }
      var now = Date.now();
      var ttl = ttlMs();
      var seen = {};
      var changed = false;
      var list = Array.isArray(agents) ? agents : [];
      for (var i = 0; i < list.length; i++) {
        var agent = list[i];
        var key = agentKey(agent);
        seen[key] = true;
        var entry = cache[key];
        if (!entry) continue;
        if (
          statusClass(agent.agent_status) !== "working" ||
          entry.signature !== agentSignature(agent) ||
          now - entry.dismissedAt > ttl
        ) {
          delete cache[key];
          changed = true;
        }
      }
      for (var k in cache) {
        if (!seen[k]) {
          delete cache[k];
          changed = true;
        }
      }
      if (changed) save();
    }

    return {
      dismiss: dismiss,
      restore: restore,
      clearForTerminal: clearForTerminal,
      cleanup: cleanup,
      enabled: enabled,
      isWorkingDismissed: isWorkingDismissed,
      dismissedRank: dismissedRank,
    };
  }

  globalThis.HerdrAttention = {
    statusClass: statusClass,
    sortAgents: sortAgents,
    normalizeAgentStatusOrder: normalizeAgentStatusOrder,
    createDismissals: createDismissals,
  };
})();