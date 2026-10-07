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
      // Skeleton (same row shape) while the first refresh fetch is pending.
      if (globalThis.HerdrSkeleton && state.booting)
        return globalThis.HerdrSkeleton.sessions(2);
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

    function renderKeyBar() {
      if (!state.terminalId) return "";
      // One-shot Ctrl: the state lives on the button itself (aria-pressed),
      // so the next control-key tap sends Ctrl+<key> and resets. onmousedown
      // preventDefault keeps wterm's textarea focused: no focus steal.
      return `<div class="mobile-keybar" id="mobileKeyBar" aria-label="Terminal keys" role="toolbar"><button class="mobile-keybar-key" type="button" data-key="esc" aria-label="Esc key" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">Esc</button><button class="mobile-keybar-key" type="button" data-key="tab" aria-label="Tab key" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">Tab</button><button class="mobile-keybar-key" type="button" data-key="ctrl" aria-pressed="false" aria-label="Ctrl modifier, one-shot" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">Ctrl</button><button class="mobile-keybar-key" type="button" data-key="up" aria-label="Up arrow" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">↑</button><button class="mobile-keybar-key" type="button" data-key="down" aria-label="Down arrow" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">↓</button><button class="mobile-keybar-key" type="button" data-key="left" aria-label="Left arrow" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">←</button><button class="mobile-keybar-key" type="button" data-key="right" aria-label="Right arrow" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">→</button><button class="mobile-keybar-key mobile-keybar-danger" type="button" data-key="ctrl-c" aria-label="Ctrl C, interrupt" onmousedown="event.preventDefault()" onclick="HerdrMobile.keyBarKey(event, this)">^C</button></div>`;
    }

    function renderTerminal() {
      if (!state.terminalId)
        return '<div class="mobile-loading">No terminal selected</div>';
      // Key toolbar and tabs strip no longer live inside the terminal
      // screen: the toolbar renders into #mobileToolbar above the nav bar
      // (app.js syncToolbar) and the tabs moved to the header dropdown
      // (app.js openTabsSheet / renderTabsSheet).
      return `<div class="mobile-terminal-screen"><div class="mobile-terminal-shell" id="terminalShell"><div class="mobile-terminal-loading" id="mobileTerminalLoading"${state.terminalConnecting ? "" : " hidden"}><span>Loading panel</span></div><button class="mobile-terminal-follow-button" id="mobileTerminalFollowButton" type="button" hidden title="Go to latest terminal output and resume follow" aria-label="Go to latest terminal output and resume follow" onclick="HerdrMobile.scrollTerminalToBottom(false)">↓ Tail</button><div class="mobile-terminal" id="terminal"></div></div></div>`;
    }

    // Dropdown list for the header panels button: every tab as a row plus
    // new/close actions. Same markup shape as the panels screen rows so the
    // existing row CSS applies.
    function renderTabsSheetList() {
      const rows = state.tabs.length
        ? state.tabs
            .map(
              (tab) =>
                `<button class="mobile-row${tab.tab_id === state.tab ? " active" : ""}" onclick="HerdrMobile.selectTabFromSheet(${jsArg(tab.tab_id)})"><strong>${escapeHtml(tabTitle(tab))}${tab.tab_id === state.tab ? " · current" : ""}</strong><span>${escapeHtml((state.panes || []).filter((pane) => pane.tab_id === tab.tab_id).length)} panes</span></button>`,
            )
            .join("")
        : '<div class="mobile-loading">No panels</div>';
      const close = state.tab ? `<button class="mobile-btn danger mobile-wide" onclick="HerdrMobile.closePanelFromSheet(${jsArg(state.tab)})">Close current panel</button>` : "";
      return `<button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.createPanelFromSheet()">New panel</button>${close}${rows}`;
    }

    function renderTerminalScreen(screen) {
      if (!state.terminalId) {
        getMobileTerminal().destroy(true);
        screen.innerHTML = renderTerminal();
        return;
      }
      if (!el("terminal")) {
        screen.innerHTML = renderTerminal();
        // First paint of the terminal shell: mount the composer now too.
        // The early return below would otherwise defer it to the next
        // refresh, and a quiet pane may not produce one for a long time.
        syncComposer(screen);
        return;
      }
      syncComposer(screen);
    }

    // ---- Composer sync helpers ----

    // Test harnesses and very old engines may lack Element.remove(); fall
    // back to parentNode.removeChild so a missing remove never breaks the
    // whole screen render.
    function removeNode(node) {
      if (!node) return;
      if (typeof node.remove === "function") node.remove();
      else if (node.parentNode) node.parentNode.removeChild(node);
    }

    function mountAfterTerminal(shell, html) {
      if (!shell) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      while (wrap.firstElementChild) shell.appendChild(wrap.firstElementChild);
    }

    function syncComposer(screen) {
      const deps = globalThis.HerdrMobileComposerDeps;
      if (!deps) return;
      // Composer bar and note are removed (typing goes into the terminal);
      // keep the removal so an upgrade from an old DOM clears leftovers.
      const existingBar = el("mobileComposer");
      if (existingBar) removeNode(existingBar);
      const existingNote = el("mobileComposerNote");
      if (existingNote) removeNode(existingNote);
      const existingCard = el("mobilePromptCard");
      const wantedCard = deps.renderPromptCard();
      if (existingCard) {
        const backdrop = existingCard.previousElementSibling;
        const hadBackdrop = !!(backdrop && backdrop.classList && backdrop.classList.contains("mobile-prompt-backdrop"));
        const currentPair = (hadBackdrop ? backdrop.outerHTML : "") + existingCard.outerHTML;
        if (!wantedCard) {
          if (hadBackdrop) removeNode(backdrop);
          removeNode(existingCard);
        } else if (currentPair !== wantedCard) {
          // wantedCard is backdrop + sheet; replace both nodes together so
          // they can never desync (stale backdrop over a fresh sheet).
          const wrap = document.createElement("div");
          wrap.innerHTML = wantedCard;
          if (hadBackdrop) removeNode(backdrop);
          const parent = existingCard.parentNode;
          while (wrap.firstElementChild) parent.insertBefore(wrap.firstElementChild, existingCard);
          removeNode(existingCard);
        }
      } else if (wantedCard) {
        mountAfterTerminal(el("terminalShell"), wantedCard);
      }
    }

    return {
      renderPanels,
      renderTerminal,
      renderKeyBar,
      renderTabsSheetList,
      renderTerminalScreen,
      syncComposer,
      setBrowserFaviconError,
    };
  }

  globalThis.HerdrMobilePanelsModule = { create: createMobilePanels };
})();
