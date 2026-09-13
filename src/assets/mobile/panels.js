(function () {
  function createMobilePanels({
    state,
    el,
    escapeHtml,
    jsArg,
    tabTitle,
    getMobileTerminal,
    getBrowserFaviconError,
    setBrowserFaviconError,
  }) {
    function renderPanels() {
      if (!state.ws)
        return '<div class="mobile-loading">Select workspace first</div>';
      const close = state.tab ? `<button class="mobile-btn danger mobile-wide" onclick="HerdrMobile.closeCurrentPanel()">Close current panel</button>` : "";
      const rows = state.tabs.length
        ? state.tabs
            .map(
              (tab) =>
                `<button class="mobile-row${tab.tab_id === state.tab ? " active" : ""}" onclick="HerdrMobile.selectTab(${jsArg(tab.tab_id)})"><strong>${escapeHtml(tabTitle(tab))}${tab.tab_id === state.tab ? " · current" : ""}</strong><span>${escapeHtml((state.panes || []).filter((pane) => pane.tab_id === tab.tab_id).length)} panes · ${escapeHtml(tab.tab_id)}</span></button>`,
            )
            .join("")
        : '<div class="mobile-loading">No panels</div>';
      return `<section class="mobile-section"><h2>Panels</h2><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.createPanel()">New panel</button>${close}${rows}</section>`;
    }

    function renderTerminal() {
      if (!state.terminalId)
        return '<div class="mobile-loading">No terminal selected</div>';
      return `<div class="mobile-terminal-screen"><div class="mobile-tabs" id="mobileTerminalTabs">${renderTerminalTabsWithAdd()}</div><div class="mobile-terminal-shell" id="terminalShell"><button class="mobile-terminal-follow-button" id="mobileTerminalFollowButton" type="button" hidden title="Go to latest terminal output and resume follow" aria-label="Go to latest terminal output and resume follow" onclick="HerdrMobile.scrollTerminalToBottom()">↓ Tail</button><div class="mobile-terminal" id="terminal"></div></div></div>`;
    }

    function renderTerminalTabsWithAdd() {
      const close = state.tab ? `<button class="mobile-tab mobile-tab-close" title="Close current panel" onclick="HerdrMobile.closeCurrentPanel()">✕</button>` : "";
      return `${renderTerminalTabs()}<button class="mobile-tab mobile-tab-add" title="New panel" onclick="HerdrMobile.createPanel()">+</button>${close}`;
    }

    function renderTerminalTabs() {
      return state.tabs
        .map(
          (tab) =>
            `<button class="mobile-tab${tab.tab_id === state.tab ? " active" : ""}" onclick="HerdrMobile.selectTab(${jsArg(tab.tab_id)})">${escapeHtml(tabTitle(tab))}</button>`,
        )
        .join("");
    }

    function renderTerminalScreen(screen) {
      if (!state.terminalId) {
        getMobileTerminal().destroy(true);
        screen.innerHTML = renderTerminal();
        return;
      }
      if (!el("terminal")) {
        screen.innerHTML = renderTerminal();
        return;
      }
      const tabs = el("mobileTerminalTabs");
      if (tabs) tabs.innerHTML = renderTerminalTabsWithAdd();
    }

    return {
      renderPanels,
      renderTerminal,
      renderTerminalTabsWithAdd,
      renderTerminalTabs,
      renderTerminalScreen,
      setBrowserFaviconError,
    };
  }

  globalThis.HerdrMobilePanelsModule = { create: createMobilePanels };
})();