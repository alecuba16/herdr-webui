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
      return `<div class="mobile-terminal-screen">${renderKeyBar()}<div class="mobile-tabs" id="mobileTerminalTabs">${renderTerminalTabsWithAdd()}</div><div class="mobile-terminal-shell" id="terminalShell"><div class="mobile-terminal-loading" id="mobileTerminalLoading"${state.terminalConnecting ? "" : " hidden"}><span>Loading panel</span></div><button class="mobile-terminal-follow-button" id="mobileTerminalFollowButton" type="button" hidden title="Go to latest terminal output and resume follow" aria-label="Go to latest terminal output and resume follow" onclick="HerdrMobile.scrollTerminalToBottom(false)">↓ Tail</button><div class="mobile-terminal" id="terminal"></div></div></div>`;
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
        // First paint of the terminal shell: mount the composer now too.
        // The early return below would otherwise defer it to the next
        // refresh, and a quiet pane may not produce one for a long time.
        syncComposer(screen);
        return;
      }
      const tabs = el("mobileTerminalTabs");
      if (tabs) {
        // Skip the tab-bar innerHTML rewrite when nothing changed: every
        // events-WS refresh lands here, and rewriting drops scroll state on
        // wide tab lists.
        const html = renderTerminalTabsWithAdd();
        if (tabs.__lastTabsHtml !== html) {
          tabs.innerHTML = html;
          tabs.__lastTabsHtml = html;
        }
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

    function replaceNode(existing, html) {
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      const next = wrap.firstElementChild;
      if (next && existing.parentNode) existing.parentNode.replaceChild(next, existing);
      else removeNode(existing);
    }

    function syncComposer(screen) {
      const deps = globalThis.HerdrMobileComposerDeps;
      if (!deps) return;
      const existingBar = el("mobileComposer");
      const wantedBar = deps.renderComposerBar();
      if (existingBar) {
        const next = document.createElement("div");
        next.innerHTML = wantedBar;
        const nextBar = next.firstElementChild;
        if (nextBar && existingBar.innerHTML !== nextBar.innerHTML) {
          const active = document.activeElement === existingBar.querySelector("#mobileComposerInput");
          const value = deps.draftValue();
          if (existingBar.parentNode) existingBar.parentNode.replaceChild(nextBar, existingBar);
          else removeNode(existingBar);
          const input = nextBar.querySelector("#mobileComposerInput");
          if (input) {
            input.value = value;
            if (active) input.focus({ preventScroll: true });
          }
        }
      } else {
        mountAfterTerminal(el("terminalShell"), wantedBar);
      }
      const existingNote = el("mobileComposerNote");
      const wantedNote = deps.renderComposerNote();
      if (!existingNote && wantedNote) {
        mountAfterTerminal(el("terminalShell"), wantedNote);
      } else if (existingNote && wantedNote) {
        const text = wantedNote.replace(/<[^>]*>/g, "");
        if (existingNote.textContent !== text) existingNote.textContent = text;
      } else if (existingNote && !wantedNote) {
        removeNode(existingNote);
      }
      const existingCard = el("mobilePromptCard");
      const wantedCard = deps.renderPromptCard();
      if (existingCard) {
        if (!wantedCard) removeNode(existingCard);
        else if (existingCard.outerHTML !== wantedCard) replaceNode(existingCard, wantedCard);
      } else if (wantedCard) {
        mountAfterTerminal(el("terminalShell"), wantedCard);
      }
    }

    return {
      renderPanels,
      renderTerminal,
      renderKeyBar,
      renderTerminalTabsWithAdd,
      renderTerminalTabs,
      renderTerminalScreen,
      syncComposer,
      setBrowserFaviconError,
    };
  }

  globalThis.HerdrMobilePanelsModule = { create: createMobilePanels };
})();
