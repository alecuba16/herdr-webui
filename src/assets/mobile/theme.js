(function () {
  function createMobileTheme({
    state,
    documentRef,
    windowRef,
    localStorage,
    getMobileAttention,
    getMobileTerminal,
    browserFavicon,
    getBrowserFaviconError,
    applyThemeToBody,
  }) {
    let largestVisualViewportHeight = 0,
      terminalResizeTimer = null;

    function updateMobileViewport() {
      const viewport = windowRef.visualViewport;
      const height = Math.max(
        240,
        Math.floor(
          (viewport && viewport.height) ||
            windowRef.innerHeight ||
            (documentRef.documentElement && documentRef.documentElement.clientHeight) ||
            0,
        ),
      );
      largestVisualViewportHeight = Math.max(largestVisualViewportHeight, height);
      // Runs on every render; skip the style/class writes when unchanged so
      // steady-state refreshes stop dirtying body style.
      const vh = `${height}px`;
      if (
        typeof documentRef.body.style.getPropertyValue !== "function" ||
        documentRef.body.style.getPropertyValue("--herdr-mobile-viewport-height") !== vh
      )
        documentRef.body.style.setProperty("--herdr-mobile-viewport-height", vh);
      const keyboardOpen =
        state.screen === "terminal" && largestVisualViewportHeight - height > 120;
      if (
        typeof documentRef.body.classList.contains === "function"
          ? documentRef.body.classList.contains("mobile-keyboard-open") !== keyboardOpen
          : true
      )
        documentRef.body.classList.toggle("mobile-keyboard-open", keyboardOpen);
    }

    function scheduleTerminalResize() {
      updateMobileViewport();
      if (terminalResizeTimer) clearTimeout(terminalResizeTimer);
      terminalResizeTimer = setTimeout(() => {
        terminalResizeTimer = null;
        if (state.screen === "terminal" && getMobileTerminal()) getMobileTerminal().connect();
      }, 80);
    }

    function applyTreeIndent() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        const value = Math.max(0, Math.min(40, Number(parsed.treeIndentPx) || 14));
        const indent = `${value}px`;
        // Runs on every render; only write when the setting actually moved.
        if (
          typeof documentRef.body.style.getPropertyValue !== "function" ||
          documentRef.body.style.getPropertyValue("--herdr-tree-indent") !== indent
        )
          documentRef.body.style.setProperty("--herdr-tree-indent", indent);
      } catch (_) {}
    }

    function syncBrowserFavicon() {
      if (getBrowserFaviconError()) {
        browserFavicon.set("error");
        return;
      }
      const attention = state.agents.some((agent) => {
        const status = getMobileAttention().statusClass(agent.agent_status);
        return status === "blocked" || status === "done";
      });
      browserFavicon.set(documentRef.hidden && attention ? "attention" : "normal");
    }

    function applyTheme() {
      const mode = localStorage.getItem("herdr-web-theme") || "auto";
      const light =
        mode === "light" ||
        (mode === "auto" &&
          windowRef.matchMedia &&
          !windowRef.matchMedia("(prefers-color-scheme: dark)").matches);
      documentRef.body.classList.toggle("light", light);
      documentRef.documentElement.dataset.herdrTheme = light ? "light" : "dark";
      if (applyThemeToBody) applyThemeToBody(light);
    }

    return {
      updateMobileViewport,
      scheduleTerminalResize,
      applyTreeIndent,
      syncBrowserFavicon,
      applyTheme,
    };
  }

  globalThis.HerdrMobileThemeModule = { create: createMobileTheme };
})();