document.addEventListener("click", (e) => {
  const workspaceAction = e.target && e.target.closest && e.target.closest("[data-workspace-action]");
  if (workspaceAction) {
    e.preventDefault();
    e.stopPropagation();
    runWorkspaceContextAction(workspaceAction.dataset.workspaceAction, workspaceAction);
    return;
  }
  const option = e.target && e.target.closest && e.target.closest(".no-sleep-menu [data-mode]");
  if (option) {
    closeNoSleepMenus();
    // Focus returns to the toggle after picking a mode: the option
    // button is about to be hidden, which would strand keyboard focus.
    const wrap = option.closest(".no-sleep-wrap");
    const control = wrap && wrap.querySelector(".no-sleep-control");
    if (control && typeof control.focus === "function") control.focus();
    setNoSleepMode(option.dataset.mode || "off", wrap || option);
    return;
  }
  const control = e.target && e.target.closest && e.target.closest(".no-sleep-control");
  if (control) {
    const wrap = control.closest(".no-sleep-wrap");
    const menu = wrap && wrap.querySelector(".no-sleep-menu");
    if (menu) {
      const nextHidden = !menu.hidden;
      closeNoSleepMenus(menu);
      menu.hidden = nextHidden;
      // aria-expanded mirrors the open state for screen readers; when
      // opening, the first option takes focus so the menu is keyboard-
      // reachable (arrow keys then move through native button focus).
      // nextHidden is "the menu ends up hidden", the inverse of expanded.
      control.setAttribute("aria-expanded", nextHidden ? "false" : "true");
      if (!nextHidden) {
        const first = menu.querySelector("[data-mode]");
        if (first && typeof first.focus === "function") first.focus();
      }
    }
    return;
  }
  if (!e.target || !e.target.closest || !e.target.closest(".no-sleep-wrap")) closeNoSleepMenus();
});
// Keyboard twin of the click delegation above: Enter/Space on a focused
// span role=button (workspace close/remove actions, pane-tab ✕, agent
// Undo/Dismiss, session lines) triggers its native click path. Native
// <button>/<a> elements are excluded: they already synthesize a click on
// these keys. Git stash entries and log rows carry their own inline
// keydown with stopPropagation, so they never reach this fallback.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  const target = e.target;
  if (!target || !target.closest) return;
  if (target.tagName === "BUTTON" || target.tagName === "A") return;
  const spanButton =
    target.closest('[role="button"][tabindex="0"]') ||
    target.closest("[data-workspace-action]") ||
    target.closest(".pane-tab-close");
  if (spanButton) {
    // Elements with their own Enter semantics (sidebar rows, pane tab
    // close buttons) keep them; the welcome-Enter branch below must
    // never hijack a press aimed at one of them.
    if (spanButton.tagName !== "BUTTON") {
      e.preventDefault();
      e.stopPropagation();
      spanButton.click();
    }
    return;
  }
  // Zero-tab workspace body: Enter creates the first terminal panel,
  // same as the card's "New terminal" button. The pane column scope
  // (#workspacePanes) covers every real flow: a click on the empty
  // workspace body, the leaf card once the open-workspace modal closes,
  // and the body-level focus left after the last tab closes.
  // state.ws && !state.tab mirrors syncWorkspaceEmptyLeaf's show
  // condition in render.js: the leaf is on screen exactly then.
  if (
    e.key === "Enter" &&
    state.ws &&
    !state.tab &&
    !modalOpen() &&
    !target.closest("input, select, textarea, [contenteditable='true']") &&
    (target === document.body ||
      target === document.documentElement ||
      !!target.closest("#workspacePanes"))
  ) {
    e.preventDefault();
    e.stopPropagation();
    newTab();
    return;
  }
});
if (window.matchMedia) {
  try {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (media.addEventListener)
      media.addEventListener("change", () => {
        if (themeMode === "auto") applyTheme();
      });
    else if (media.addListener)
      media.addListener(() => {
        if (themeMode === "auto") applyTheme();
      });
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  syncBrowserFavicon();
});
let settingsBackdropDown = false;
el("settingsToggle").onclick = () => {
  showShortcutHintToast("webuiShortcuts", "settings");
  openSettingsModal();
};
el("shortcutsToggle").onclick = () => {
  showShortcutHintToast("webuiShortcuts", "help");
  const sections = window.HerdrSettingsSections;
  if (sections) sections.openSettingsModalAt(sections.HELP_SECTION_SELECTOR);
  else openSettingsModal();
};
el("settingsClose").onclick = () => {
  const m = el("settingsModal");
  m.style.display = "none";
  if (window.HerdrModalDrag) window.HerdrModalDrag.resetByBackdrop(m);
};
const settingsModalScrollSync = () => {
  const sections = window.HerdrSettingsSections;
  if (sections) sections.updateSettingsNavCurrent();
};
// The merged-modal module owns the scroll sync (it knows the real scroll
// container: the settings shell, not the .modal card). No fallback here:
// without the module there is no rail to sync.
el("settingsModal").addEventListener("pointerdown", (e) => {
  settingsBackdropDown = e.target === el("settingsModal");
});
el("settingsModal").addEventListener("click", (e) => {
  if (settingsBackdropDown && e.target === el("settingsModal")) {
    const m = el("settingsModal");
    m.style.display = "none";
    if (window.HerdrModalDrag) window.HerdrModalDrag.resetByBackdrop(m);
  }
  settingsBackdropDown = false;
});
el("searchPaletteClose").onclick = closeSearchPalette;
el("searchPaletteInput").oninput = scheduleSearch;
el("searchPaletteInput").onkeydown = searchPaletteKeydown;
el("searchPalette").addEventListener("click", (e) => {
  if (e.target === el("searchPalette")) closeSearchPalette();
});
el("settingsModal").addEventListener("click", (e) => {
  const record = e.target && e.target.closest && e.target.closest("[data-shortcut-record]");
  if (record) {
    e.preventDefault();
    const [scope, action] = record.dataset.shortcutRecord.split(":");
    recordShortcut(scope, action, record);
    settingsBackdropDown = false;
    return;
  }
  const reset = e.target && e.target.closest && e.target.closest("[data-shortcut-reset]");
  if (reset) {
    e.preventDefault();
    const [scope, action] = reset.dataset.shortcutReset.split(":");
    resetShortcut(scope, action);
    settingsBackdropDown = false;
  }
});
el("optTheme").onchange = () => {
  themeMode = normalizeThemeMode(el("optTheme").value);
  applyTheme();
  // Theme mode persists via applyTheme() -> localStorage, not saveOptions,
  // so it needs its own confirmation badge.
  if (typeof flashSettingsApplied === "function")
    flashSettingsApplied(el("optTheme"));
};
el("optDensity").onchange = () => {
  // applyDensity() applies the [data-density] attribute live (no reload);
  // saveOptions persists it in the shared options store.
  options.density = normalizeDensity(el("optDensity").value);
  applyDensity();
  saveOptions();
};
el("themeColorsApply").onclick = applyThemeColorsFromSettings;
el("themeColorsReset").onclick = () => applyThemeColorProfile("default");
el("themeColorsApplyProfile").onclick = () => {
  applyThemeColorProfile(el("themeColorProfile").value);
};
el("serverSettingsLoad").onclick = loadServerSettings;
el("serverSettingsApply").onclick = applyServerSettings;
el("serverSettingsLogout").onclick = logoutFromServer;
el("optOverflow").onchange = () => {
  options.overflow = el("optOverflow").checked;
  options.terminalOverflowOptIn = true;
  saveOptions();
  applyOptions();
  const refitTerminal = () => {
    if (typeof fitTerminalShell === "function") fitTerminalShell();
    if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(refitTerminal);
  else refitTerminal();
};
el("optFit").onchange = () => {
  options.fitToBrowser = el("optFit").checked;
  saveOptions();
  applyOptions();
};
el("optShiftEnterNewline").onchange = () => {
  options.shiftEnterNewline = el("optShiftEnterNewline").checked;
  saveOptions();
  applyOptions();
};
el("optCloseShortcut").onchange = saveCloseShortcutOption;
el("optGlobalShortcutsEnabled").onchange = () => {
  options.globalShortcutsEnabled = el("optGlobalShortcutsEnabled").checked;
  saveOptions();
  applyOptions();
};
el("optShortcutHintToasts").onchange = () => {
  options.shortcutHintToasts = el("optShortcutHintToasts").checked;
  saveOptions();
  applyOptions();
};
el("optGlobalShortcutPrefixCapture").onclick = () => {
  const button = el("optGlobalShortcutPrefixCapture"),
    input = el("optGlobalShortcutPrefix");
  button.textContent = "Press keys...";
  if (input) input.value = "Press keys...";
  const capture = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const prefix = shortcutPrefixFromEvent(e);
    if (prefix) {
      options.globalShortcutPrefix = prefix;
      saveOptions();
    }
    button.textContent = "Record";
    applyOptions();
  };
  window.addEventListener("keydown", capture, { once: true, capture: true });
};
// Text-like settings commit through the settings_confirm chrome: Enter,
// the pencil button, or the idle auto-commit after typing stops. Number
// inputs never save per keystroke; range sliders save on release.
function commitTerminalFontFamily() {
  options.terminalFontFamily = el("optTerminalFontFamily").value;
  saveOptions();
  applyTerminalFont();
  fitTerminalShell();
}
registerSettingsCommit("optTerminalFontFamily", commitTerminalFontFamily, () => options.terminalFontFamily || "");
el("optTerminalFontSize").oninput = () => {
  options.terminalFontSize = Math.max(10, Math.min(22, Math.round(Number(el("optTerminalFontSize").value) || 14)));
  saveOptions();
  applyTerminalFont();
  fitTerminalShell();
};
registerSettingsCommit("optTerminalFontSize", () => {
  options.terminalFontSize = Math.max(10, Math.min(22, Math.round(Number(el("optTerminalFontSize").value) || 14)));
  saveOptions();
  applyTerminalFont();
  fitTerminalShell();
}, () => options.terminalFontSize);
const optTerminalCore = el("optTerminalCore");
if (optTerminalCore)
  optTerminalCore.onchange = () => {
    options.terminalCore = HerdrAppHelpers.resolveTerminalCore(optTerminalCore.value);
    options.terminalCoreGhosttyMigrated = true;
    saveOptions();
    resetTerminalConnection(true);
    connectTerminal();
  };
el("optTerminalLinks").onchange = () => {
  options.terminalLinks = el("optTerminalLinks").checked;
  saveOptions();
  applyTerminalLinks();
};
el("optTerminalMouseReporting").onchange = () => {
  options.terminalMouseReporting = el("optTerminalMouseReporting").checked;
  saveOptions();
};
el("optAgentSortMode").onchange = () => {
  options.agentSortMode = el("optAgentSortMode").value;
  if (options.agentSortMode === "attention_inverted")
    options.agentStatusOrder = normalizeAgentStatusOrder(workingFirstAgentStatusOrder);
  saveOptions();
  applyOptions();
  render();
};
const optSidebarWorkspacePercent = el("optSidebarWorkspacePercent");
registerSettingsCommit("optSidebarWorkspacePercent", () => {
  setSidebarWorkspacePercent(el("optSidebarWorkspacePercent").value);
}, () => options.sidebarWorkspacePercent);
const sidebarSplitHandle = el("sidebarSplitHandle");
if (sidebarSplitHandle) {
  let pendingSidebarWorkspacePercent = null;
  // The split's rect is read per pointermove and its layout never changes
  // mid-drag (the percent var stretches the two child panels only), so
  // cache it once on pointerdown to avoid a layout read per move event.
  let sidebarSplitRect = null;
  const resizeFromClientY = (clientY) => {
    if (!sidebarSplitRect) {
      const split = sidebarSplitHandle.parentElement;
      if (!split) return;
      sidebarSplitRect = split.getBoundingClientRect();
    }
    if (!sidebarSplitRect.height) return;
    const percent = ((clientY - sidebarSplitRect.top) / sidebarSplitRect.height) * 100;
    pendingSidebarWorkspacePercent = previewSidebarWorkspacePercent(percent);
  };
  sidebarSplitHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sidebarSplitHandle.setPointerCapture(e.pointerId);
    sidebarSplitHandle.classList.add("dragging");
    sidebarSplitRect = null;
    resizeFromClientY(e.clientY);
  });
  sidebarSplitHandle.addEventListener("pointermove", (e) => {
    if (!sidebarSplitHandle.hasPointerCapture(e.pointerId)) return;
    resizeFromClientY(e.clientY);
  });
  const stopResize = (e) => {
    if (sidebarSplitHandle.hasPointerCapture(e.pointerId))
      sidebarSplitHandle.releasePointerCapture(e.pointerId);
    sidebarSplitHandle.classList.remove("dragging");
    sidebarSplitRect = null;
    if (pendingSidebarWorkspacePercent !== null) {
      setSidebarWorkspacePercent(pendingSidebarWorkspacePercent);
      pendingSidebarWorkspacePercent = null;
    }
  };
  sidebarSplitHandle.addEventListener("pointerup", stopResize);
  sidebarSplitHandle.addEventListener("pointercancel", stopResize);
  sidebarSplitHandle.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    setSidebarWorkspacePercent(
      (options.sidebarWorkspacePercent || 68) + (e.key === "ArrowDown" ? 2 : -2),
    );
  });
}

// Both toggle strips double as width drag handles: click toggles the
// sidebar, a horizontal move past the threshold resizes it instead. The
// drag never touches the grid mid-gesture: a ghost column (the preview
// overlay) shows where the sidebar would land, and the width commits only
// on release. A release below the stock minimum snaps to whichever edge is
// closer to the pointer: the minimum itself, or fully collapsed. The
// browser fires click after pointerup even for a real drag, so the drag
// arms a capture-phase suppressor on the strip itself.
const SIDEBAR_DRAG_THRESHOLD_PX = 4;
const SIDEBAR_PREVIEW_FADE_MS = 140;
const SIDEBAR_RESIZING_MS = 180;
function wireSidebarWidthDrag(
  strip,
  readWidth,
  previewWidth,
  commitWidth,
  hooks,
) {
  if (!strip) return;
  let startX = 0;
  let pendingWidth = null;
  let pendingCollapse = false;
  let startCollapsed = false;
  let dragging = false;
  let suppressedClick = false;
  let armed = false;
  let capturedPointer = null;
  let previewNodeCache = null;
  let fadeTimer = null;
  let commitTimer = null;
  let windowListeners = false;
  const direction = strip.id === "rightSidebarToggle" ? -1 : 1;
  const expand = hooks && hooks.expand;
  const collapse = hooks && hooks.collapse;
  const isCollapsed = hooks && hooks.isCollapsed;
  const minimum = (hooks && hooks.minimum) || 0;
  const previewNode = () => {
    if (!previewNodeCache) previewNodeCache = el("sidebarPreview");
    return previewNodeCache;
  };
  const clearFadeTimer = () => {
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  };
  const clearCommitTimer = () => {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
  };
  // showPreview clears the closing hint so a re-entry from the collapse
  // zone restores the full ghost.
  const showPreview = () => {
    const ghost = previewNode();
    if (!ghost) return;
    hideClosingHint();
    clearFadeTimer();
    ghost.classList.remove("fading");
    ghost.classList.toggle("right", direction === -1);
    ghost.style.setProperty("width", `${pendingWidth}px`);
    ghost.hidden = false;
  };
  // The fade rides the same 120ms ease the commit transition uses, then a
  // timer drops the ghost out of layout. transitionend alone would strand
  // the ghost if the tab backgrounds mid-fade; the timer always lands.
  const hidePreview = () => {
    const ghost = previewNode();
    if (!ghost || ghost.hidden) return;
    ghost.classList.add("fading");
    clearFadeTimer();
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      ghost.hidden = true;
      ghost.classList.remove("fading");
    }, SIDEBAR_PREVIEW_FADE_MS);
  };
  // Crossing into the collapse zone swaps the ghost for a strip the width
  // of the collapsed bar, so the release state still reads: release inside
  // closes, moving back out of the zone restores the full ghost (and the
  // collapse stays reversible while the button is held).
  const showClosingHint = () => {
    const ghost = previewNode();
    if (!ghost) return;
    clearFadeTimer();
    ghost.classList.remove("fading");
    ghost.classList.add("closing");
    ghost.style.setProperty("width", "28px");
    ghost.hidden = false;
  };
  const hideClosingHint = () => {
    const ghost = previewNode();
    if (!ghost) return;
    ghost.classList.remove("closing");
  };
  // The commit transition runs on the real columns only while this class
  // rides #app: click toggles and keyboard steps keep snapping instantly.
  const armCommitTransition = () => {
    const app = el("app");
    if (!app) return;
    clearCommitTimer();
    app.classList.add("sidebar-resizing");
    commitTimer = setTimeout(() => {
      commitTimer = null;
      app.classList.remove("sidebar-resizing");
    }, SIDEBAR_RESIZING_MS);
  };
  const previewFromClientX = (clientX) => {
    const base = readWidth();
    const delta = direction * (clientX - startX);
    if (startCollapsed) {
      // Out of a collapsed bar only outward drags mean anything; the drag
      // distance alone sizes the reopened column. Pulling further closed is
      // a no-op (nothing to preview, nothing to commit).
      if (delta <= 0) {
        pendingCollapse = false;
        pendingWidth = null;
        hidePreview();
        return;
      }
      // Below the minimum the commit snaps the column open at the stock
      // minimum (never back closed: the user just pulled it open), and the
      // ghost floors with it so it shows where the release lands.
      pendingCollapse = false;
      pendingWidth = previewWidth(delta);
      showPreview();
      return;
    }
    // One px of pointer travel is one px of width, so the snap distances
    // below are cursor distances from the release point to each edge.
    const next = base + delta;
    if (next < minimum && collapse) {
      // The release would land below the stock minimum, so the commit
      // snaps to whichever edge is closer to the pointer: the minimum
      // itself, or fully collapsed (width 0). pendingCollapse holds the
      // winner; the ghost hides for the collapse so the snap reads as
      // intentional.
      const distanceToMinimum = minimum - next;
      const distanceToCollapsed = Math.abs(next);
      if (distanceToCollapsed < distanceToMinimum) {
        pendingCollapse = true;
        pendingWidth = null;
        showClosingHint();
        return;
      }
    }
    pendingCollapse = false;
    pendingWidth = previewWidth(next);
    hideClosingHint();
    showPreview();
  };
  // Pointer capture is the primary drag pipe, but some environments
  // (headless browsers, embedded webviews) deliver pointermove to whatever
  // sits under the cursor instead of the capturing element. The drag
  // therefore also listens on window while armed (VS Code's sash wires its
  // move/up on the window the same way), and drops those listeners on
  // release. A move with no button held means the release was missed
  // (another window, a system gesture), so it commits the pending width
  // instead of dragging on.
  const onWindowMove = (e) => {
    if (!armed) return;
    if (e.pointerId !== undefined && capturedPointer !== null && e.pointerId !== capturedPointer) return;
    if (e.buttons === 0) {
      // The release happened elsewhere (another window, a system gesture),
      // so no trailing click follows this commit: drop the suppressor so
      // the next real click on the strip still toggles.
      suppressedClick = false;
      stopResize(e);
      return;
    }
    handleMove(e.clientX);
  };
  const onWindowUp = (e) => {
    if (!armed) return;
    if (e.pointerId !== undefined && capturedPointer !== null && e.pointerId !== capturedPointer) return;
    stopResize(e);
  };
  // A cancelled gesture produces no trailing click, so the one-shot
  // suppressor must drop: the next real click (keyboard Enter fires one
  // with no pointerdown to clear it) would otherwise be swallowed once.
  const onWindowCancel = (e) => {
    if (!armed) return;
    if (e.pointerId !== undefined && capturedPointer !== null && e.pointerId !== capturedPointer) return;
    suppressedClick = false;
    stopResize(e);
  };
  const armWindowListeners = () => {
    if (windowListeners) return;
    windowListeners = true;
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowCancel);
  };
  const disarmWindowListeners = () => {
    if (!windowListeners) return;
    windowListeners = false;
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", onWindowUp);
    window.removeEventListener("pointercancel", onWindowCancel);
  };
  const handleMove = (clientX) => {
    if (!armed) return;
    if (!dragging && Math.abs(clientX - startX) < SIDEBAR_DRAG_THRESHOLD_PX)
      return;
    if (!dragging) {
      dragging = true;
      suppressedClick = true;
      strip.classList.add("dragging");
    }
    previewFromClientX(clientX);
  };
  // The strip pipe gates on the captured pointer id like the window
  // pipe: where capture silently fails, a second finger's moves must not
  // feed the width.
  strip.addEventListener("pointermove", (e) => {
    if (e.pointerId !== undefined && capturedPointer !== null && e.pointerId !== capturedPointer) return;
    handleMove(e.clientX);
  });
  strip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    pendingWidth = null;
    pendingCollapse = false;
    startCollapsed = !!(isCollapsed && isCollapsed());
    dragging = false;
    armed = true;
    // Suppression is one-shot per gesture: the previous drag's trailing
    // click has either arrived or landed outside the strip (no capture in
    // some environments), so a fresh press must not inherit it.
    suppressedClick = false;
    armWindowListeners();
    // Capture keeps pointermove flowing when the cursor leaves the 18px
    // strip; synthetic and edge-case pointer ids make it throw, and the
    // drag must not depend on it. The window listeners above are the
    // real guarantee.
    try {
      strip.setPointerCapture(e.pointerId);
      capturedPointer = e.pointerId;
    } catch (_) {}
  });
  const stopResize = (e) => {
    disarmWindowListeners();
    if (capturedPointer !== null) {
      try {
        strip.releasePointerCapture(capturedPointer);
      } catch (_) {}
      capturedPointer = null;
    }
    if (armed) {
      armed = false;
      if (dragging) {
        strip.classList.remove("dragging");
        dragging = false;
        hidePreview();
        hideClosingHint();
        if (pendingCollapse) {
          if (collapse && collapse()) armCommitTransition();
        } else if (pendingWidth !== null) {
          if (startCollapsed && expand) expand();
          commitWidth(pendingWidth);
          armCommitTransition();
        }
      }
    }
    startX = 0;
    pendingWidth = null;
    pendingCollapse = false;
    startCollapsed = false;
  };
  strip.addEventListener("pointerup", stopResize);
  strip.addEventListener("pointercancel", (e) => {
    // Same as the window cancel path: no trailing click follows, so the
    // suppressor must not survive the gesture.
    suppressedClick = false;
    stopResize(e);
  });
  strip.addEventListener("click", (e) => {
    if (!suppressedClick) return;
    suppressedClick = false;
    e.stopImmediatePropagation();
  }, true);
  strip.addEventListener("keydown", (e) => {
    const grow = direction === 1 ? "ArrowRight" : "ArrowLeft";
    const shrink = direction === 1 ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      commitWidth(readWidth() + (e.key === grow ? 8 : -8));
    }
  });
  strip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    commitWidth(null);
  });
}
wireSidebarWidthDrag(
  el("sidebarToggle"),
  () => options.sidebarWidth ?? 330,
  (value) => normalizeSidebarWidth(value, 330),
  (value) => setSidebarWidth(value ?? 330),
  {
    expand: () => expandLeftSidebarFromDrag(),
    collapse: () => collapseLeftSidebarFromDrag(),
    isCollapsed: () => sidebarCollapsed,
    minimum: 330,
  },
);
wireSidebarWidthDrag(
  el("rightSidebarToggle"),
  () => options.rightSidebarWidth ?? 320,
  (value) => normalizeSidebarWidth(value, 320),
  (value) => setRightSidebarWidth(value ?? 320),
  {
    expand: () => expandRightSidebarFromDrag(),
    collapse: () => collapseRightSidebarFromDrag(),
    isCollapsed: () => rightSidebarCollapsed,
    minimum: 320,
  },
);
el("optParentCloseMode").onchange = () => {
  options.parentCloseMode = el("optParentCloseMode").value;
  saveOptions();
  applyOptions();
};
el("optWorkspaceOpenTerminal").onchange = () => {
  options.workspaceOpenTerminal = el("optWorkspaceOpenTerminal").checked;
  saveOptions();
  if (typeof flashSettingsApplied === "function")
    flashSettingsApplied(el("optWorkspaceOpenTerminal"));
};
el("optCloseWorkspaceOnLastTerminal").onchange = () => {
  options.closeWorkspaceOnLastTerminal = el("optCloseWorkspaceOnLastTerminal").checked !== false;
  saveOptions();
  if (typeof flashSettingsApplied === "function")
    flashSettingsApplied(el("optCloseWorkspaceOnLastTerminal"));
};
el("optStuckWorkingEnabled").onchange = () => {
  options.stuckWorkingEnabled = el("optStuckWorkingEnabled").checked;
  saveOptions();
  applyOptions();
  render();
};
el("optPromptCardsEnabled").onchange = () => {
  options.promptCardsEnabled = el("optPromptCardsEnabled").checked;
  saveOptions();
  if (typeof flashSettingsApplied === "function")
    flashSettingsApplied(el("optPromptCardsEnabled"));
  if (typeof HerdrPromptCards !== "undefined" && HerdrPromptCards.evaluate)
    HerdrPromptCards.evaluate();
};
function commitWorkingDismissMinutes() {
  options.workingDismissMinutes = Math.max(
    1,
    Math.min(1440, Number(el("optWorkingDismissMinutes").value) || 30),
  );
  saveOptions();
  applyOptions();
  render();
}
registerSettingsCommit("optWorkingDismissMinutes", commitWorkingDismissMinutes, () => options.workingDismissMinutes);
el("optWorkspaceSort").onchange = () => {
  options.workspaceSort = el("optWorkspaceSort").value;
  saveOptions();
  applyOptions();
  render();
};
el("optSoundScope").onchange = () => {
  options.soundScope = el("optSoundScope").value;
  saveOptions();
  applyOptions();
};
const optNotificationVolume = el("optNotificationVolume");
if (optNotificationVolume)
  optNotificationVolume.oninput = () => {
    options.notificationVolume = Math.max(
      0,
      Math.min(100, Number(optNotificationVolume.value) || 0),
    ) / 100;
    saveOptions();
    applyOptions();
  };
el("optScrollLines").oninput = () => {
  options.scrollLines = Math.max(1, Math.min(20, Number(el("optScrollLines").value) || 3));
  saveOptions();
  applyOptions();
};
function commitPaneTabMaxChars() {
  options.paneTabMaxChars = Math.max(4, Math.min(60, Math.round(Number(el("optPaneTabMaxChars").value) || 20)));
  saveOptions();
  applyOptions();
}
registerSettingsCommit("optPaneTabMaxChars", commitPaneTabMaxChars, () => options.paneTabMaxChars);
registerSettingsCommit("optScrollLines", () => {
  options.scrollLines = Math.max(1, Math.min(20, Number(el("optScrollLines").value) || 3));
  saveOptions();
  applyOptions();
}, () => options.scrollLines);
function commitTreeIndentPx() {
  options.treeIndentPx = Math.max(0, Math.min(40, Number(el("optTreeIndentPx").value) || 0));
  saveOptions();
  applyOptions();
  render();
}
registerSettingsCommit("optTreeIndentPx", commitTreeIndentPx, () => options.treeIndentPx);
el("optFileBrowserGitStatus").onchange = () => {
  options.fileBrowserGitStatus = el("optFileBrowserGitStatus").checked;
  saveOptions();
};
el("optFileBrowserLineNumbers").onchange = () => {
  options.fileBrowserLineNumbers = el("optFileBrowserLineNumbers").checked;
  saveOptions();
};
el("optEditorFindShortcutEnabled").onchange = () => {
  options.editorFindShortcutEnabled = el("optEditorFindShortcutEnabled").checked;
  saveOptions();
};
for (const [id, key] of [["optEditorEnabled", "editorEnabled"], ["optEditorWordWrap", "editorWordWrap"], ["optEditorBracketMatching", "editorBracketMatching"], ["optEditorFolding", "editorFolding"], ["optEditorActiveLine", "editorActiveLine"], ["optEditorWhitespace", "editorWhitespace"]]) {
  el(id).onchange = () => {
    options[key] = el(id).checked;
    saveOptions();
    if (typeof render === "function") render();
  };
}
registerSettingsCommit("optEditorTabSize", () => {
  options.editorTabSize = Math.max(1, Math.min(8, Number(el("optEditorTabSize").value) || 2));
  saveOptions();
  if (typeof render === "function") render();
}, () => options.editorTabSize);
el("optHeaderSearchEnabled").onchange = () => {
  options.headerSearchEnabled = el("optHeaderSearchEnabled").checked;
  saveOptions();
  applyOptions();
};
function commitFileBrowserSearchPageSize() {
  options.fileBrowserSearchPageSize = Math.max(10, Math.min(500, Number(el("optFileBrowserSearchPageSize").value) || 100));
  saveOptions();
}
registerSettingsCommit("optFileBrowserSearchPageSize", commitFileBrowserSearchPageSize, () => options.fileBrowserSearchPageSize);
function commitFileContentSearchMinChars() {
  options.fileContentSearchMinChars = Math.max(1, Math.min(20, Number(el("optFileContentSearchMinChars").value) || 3));
  saveOptions();
}
registerSettingsCommit("optFileContentSearchMinChars", commitFileContentSearchMinChars, () => options.fileContentSearchMinChars);
function commitFileContentSearchPageSize() {
  options.fileContentSearchPageSize = Math.max(10, Math.min(500, Number(el("optFileContentSearchPageSize").value) || 50));
  saveOptions();
}
registerSettingsCommit("optFileContentSearchPageSize", commitFileContentSearchPageSize, () => options.fileContentSearchPageSize);
function commitFileContentSearchContextLines() {
  const value = Number(el("optFileContentSearchContextLines").value);
  options.fileContentSearchContextLines = Math.max(0, Math.min(20, Number.isFinite(value) ? value : 2));
  saveOptions();
}
registerSettingsCommit("optFileContentSearchContextLines", commitFileContentSearchContextLines, () => options.fileContentSearchContextLines);
function commitFileContentSearchAutoCollapseFiles() {
  options.fileContentSearchAutoCollapseFiles = Math.max(0, Math.min(200, Number(el("optFileContentSearchAutoCollapseFiles").value) || 0));
  saveOptions();
}
registerSettingsCommit("optFileContentSearchAutoCollapseFiles", commitFileContentSearchAutoCollapseFiles, () => options.fileContentSearchAutoCollapseFiles);
el("optFileContentSearchDefaultExpanded").onchange = () => {
  options.fileContentSearchDefaultExpanded = el("optFileContentSearchDefaultExpanded").checked;
  saveOptions();
};
function commitFileContentSearchMatchesPerFile() {
  options.fileContentSearchMatchesPerFile = Math.max(1, Math.min(50, Number(el("optFileContentSearchMatchesPerFile").value) || 5));
  saveOptions();
}
registerSettingsCommit("optFileContentSearchMatchesPerFile", commitFileContentSearchMatchesPerFile, () => options.fileContentSearchMatchesPerFile);
el("optFileContentSearchMatchCase").onchange = () => {
  options.fileContentSearchMatchCase = el("optFileContentSearchMatchCase").checked;
  saveOptions();
};
el("optFileContentSearchRegex").onchange = () => {
  options.fileContentSearchRegex = el("optFileContentSearchRegex").checked;
  saveOptions();
};
function commitWorktreeAutoDiscover() {
  options.worktreeAutoDiscoverSeconds = Math.max(
    0,
    Math.min(30, Number(el("optWorktreeAutoDiscover").value) || 0),
  );
  saveOptions();
  applyOptions();
  scheduleWorktreeAutodiscover();
}
registerSettingsCommit("optWorktreeAutoDiscover", commitWorktreeAutoDiscover, () => options.worktreeAutoDiscoverSeconds);
el("optGenerateWorktreeNames").onchange = () => {
  options.generateWorktreeNames = el("optGenerateWorktreeNames").checked;
  saveOptions();
  applyOptions();
};
function commitWorktreeDefaultDirectory() {
  options.worktreeDefaultDirectory = el("optWorktreeDefaultDirectory").value.trim();
  saveOptions();
  syncWorktreeCheckoutPath();
}
registerSettingsCommit("optWorktreeDefaultDirectory", commitWorktreeDefaultDirectory, () => (options.worktreeDefaultDirectory || ""));
function commitExplorationDefaultDirectory() {
  options.explorationDefaultDirectory = el("optExplorationDefaultDirectory").value.trim();
  saveOptions();
}
registerSettingsCommit("optExplorationDefaultDirectory", commitExplorationDefaultDirectory, () => (options.explorationDefaultDirectory || ""));
el("optSound").onchange = () => {
  options.sound = el("optSound").checked;
  saveOptions();
  applyOptions();
};
el("optBrowserNotifications").onchange = () => {
  setBrowserNotifications(el("optBrowserNotifications").checked);
};
for (const module of settingsModules) {
  bindSettingsModule(module);
}
el("worktreeCreateClose").onclick = closeWorktreeCreateModal;
el("worktreeCreateCancel").onclick = closeWorktreeCreateModal;
el("worktreeCreateSource").oninput = () => {
  scheduleCreateWorktreeAutodiscover();
};
el("worktreeCreateSource").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearCreateWorktreeSuggestions();
    discoverCreateWorktreeSource();
  }
});
el("worktreeBranch").addEventListener("input", syncCreateWorktreeCheckoutPath);
el("worktreeBranch").addEventListener("change", syncCreateWorktreeCheckoutPath);
el("worktreeCreateForm").onsubmit = async (e) => {
  e.preventDefault();
  const source = resolveWorktreeSource({
    workspaceId: state.createWorktreeWorkspace,
    sourcePath: el("worktreeCreateSource").value,
    originalSource: state.createWorktreeOriginalSource,
  });
  const pullBase = el("worktreePullBase").checked;
  if (pullBase && el("worktreeCreateSource").value.trim()) {
    source.workspace_id = null;
    source.cwd = el("worktreeCreateSource").value.trim();
  }
  await submitWorktreeCreate({
    errEl: el("worktreeCreateError"),
    submitEl: el("worktreeCreateSubmit"),
    closeFn: closeWorktreeCreateModal,
    source,
    branch: el("worktreeBranch").value,
    base: el("worktreeBase").value,
    label: el("worktreeLabel").value,
    path: el("worktreePath").value,
    pullBase,
  });
};
el("worktreeOpenClose").onclick = closeWorktreeOpenModal;
// The directory picker root mounts with the .directory-picker-backdrop
// class and no inline display, and close() removes the node. Presence
// plus the class means open; the class check keeps stub documents that
// answer any id query honest.
function pickerBackdropOpen() {
  const node = document.getElementById("directoryPickerModal");
  return !!(node && node.classList && node.classList.contains("directory-picker-backdrop"));
}
// Git modals render per open inside .git-ui-modal-backdrop roots that no
// static id list can name; find any live one. querySelector on a stub
// document returns a bare element without classes, so require the
// backdrop class before treating it as a trap scope.
function gitModalScope() {
  const node = document.querySelector(".git-ui-modal-backdrop");
  return node && node.classList && node.classList.contains("git-ui-modal-backdrop") ? node : null;
}
// The session manager opens with display:block (terminal.css), not grid
// like the .modal-backdrop cards, so it needs its own visibility check.
function sessionManagerOpen() {
  const node = document.getElementById("sessionManager");
  return !!(node && node.style.display === "block");
}
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    // Any open no-sleep menu closes first, before the modal cascade:
    // it is a popover, not a modal, and its options are real buttons
    // that keep keyboard focus inside the menu.
    const openNoSleep = document.querySelector(".no-sleep-menu:not([hidden])");
    if (openNoSleep) {
      e.preventDefault();
      e.stopPropagation();
      openNoSleep.hidden = true;
      const wrap = openNoSleep.closest && openNoSleep.closest(".no-sleep-wrap");
      const control = wrap && wrap.querySelector && wrap.querySelector(".no-sleep-control");
      if (control) {
        control.setAttribute("aria-expanded", "false");
        if (typeof control.focus === "function") control.focus();
      }
      return;
    }
    if (document.getElementById("paneMenu")) {
      e.preventDefault();
      e.stopPropagation();
      closePaneMenu();
    } else if (pickerBackdropOpen()) {
      // The picker owns its own DOM (removed on close), so it is not in
      // the static-modal list below; close it through its API so focus
      // and any dragged position reset the same way the Close button
      // does. The class check keeps stub documents that answer any id
      // query honest.
      e.preventDefault();
      e.stopPropagation();
      window.HerdrDirectoryPicker.close();
    } else if (el("sessionManager").style.display === "block") {
      e.preventDefault();
      e.stopPropagation();
      hideSessionManager();
    } else if (el("questionModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeQuestion(false);
    } else if (el("workspaceCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceCreateModal();
    } else if (el("worktreeOpenModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeOpenModal();
    } else if (el("worktreeCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeCreateModal();
    } else if (el("searchPalette").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPalette();
    } else if (el("settingsModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      const m = el("settingsModal");
      m.style.display = "none";
      if (window.HerdrModalDrag) window.HerdrModalDrag.resetByBackdrop(m);
    }
  },
  true,
);
// Phase 5 pane menu: a click outside [⋮]'s menu (or on its button,
// which toggles on its own) closes it. Capture phase so the click never
// reaches a tab or strip control under an open menu.
document.addEventListener(
  "mousedown",
  (e) => {
    const menu = document.getElementById("paneMenu");
    if (!menu) return;
    if (menu.contains && menu.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest(".pane-menu-button")) return;
    closePaneMenu();
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const modalIds = [
    "settingsModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "workspaceCreateModal",
    "searchPalette",
  ];
  // Scope priority must follow the visual stacking, not this list order:
  // the directory picker floats above every .modal-backdrop and git modal
  // (z-index 1200 vs 1100, directory_picker.css), the question modal
  // renders after the other static modals in the DOM so it sits on top
  // among them, and git modals cover the session manager. When several
  // are open at once Tab must cycle inside the one the user actually
  // sees on top. The picker test doubles as its open check (close()
  // removes the node).
  const scope =
    (pickerBackdropOpen() ? document.getElementById("directoryPickerModal") : null) ||
    (el("questionModal").style.display === "grid" ? el("questionModal") : null) ||
    (gitModalScope()) ||
    (sessionManagerOpen() ? el("sessionManager") : null) ||
    modalIds.map((id) => el(id)).find((m) => m && m.style.display === "grid");
  if (!scope) return;
  const focusable = scope.querySelectorAll(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) {
    e.preventDefault();
    return;
  }
  const filtered = Array.from(focusable).filter(
    (f) => f.offsetParent !== null || f === document.activeElement,
  );
  if (!filtered.length) return;
  const active = document.activeElement;
  const first = filtered[0],
    last = filtered[filtered.length - 1];
  if (e.shiftKey) {
    if (active === first || !scope.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !scope.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
});
el("worktreeOpenRefresh").onclick = async () => {
  await refresh();
  if (el("worktreeDiscoverPath").value.trim()) await discoverWorktrees();
  else {
    syncWorktreePathOptions(validOpenWorktreeRows());
    renderWorktreeOpenList();
  }
};
el("worktreeNewForm").onsubmit = (e) => {
  e.preventDefault();
  createDiscoveredWorktree();
};
el("worktreeWorkspaceSubmit").onclick = createWorkspaceFromSmartModal;
el("worktreeWorkspaceLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createWorkspaceFromSmartModal();
  }
});
el("worktreeNewBase").addEventListener("input", syncBranchNameFromBase);
el("worktreeNewBase").addEventListener("change", syncBranchNameFromBase);
el("worktreeFetchRemotes").onclick = fetchWorktreeRemoteBranches;
el("worktreeNewBranch").addEventListener("input", () => {
  if (el("worktreeNewBranch").value.trim() !== state.openWorktreeBaseBranchName)
    state.openWorktreeBaseBranchName = "";
  syncWorktreeCheckoutPath();
});
el("worktreeNewBranch").addEventListener("change", syncWorktreeCheckoutPath);
function worktreePathInputChanged() {
  if (state.openWorktreeSuggestionLocked) {
    state.openWorktreeSuggestionLocked = false;
    return;
  }
  syncSmartWorkspaceLabel();
  const value = el("worktreeDiscoverPath").value.trim();
  const currentSource = worktreeSourceKey(state.openWorktreeSource);
  if (currentSource && currentSource !== value) {
    state.openWorktreeSource = null;
    state.openWorktreeRows = [];
    state.openWorktreeAllRows = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
  }
  const idx = (state.openWorktreeRows || []).findIndex(
    (w) => textValue(w.path) === value && w.is_linked_worktree,
  );
  state.openWorktreeSelected = idx >= 0 ? idx : null;
  renderWorktreeOpenList();
  scheduleWorktreeAutodiscover();
}
el("worktreeDiscoverPath").addEventListener("input", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("change", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    state.openWorktreeSuggestionLocked = true;
    renderPathOptions("worktreePathOptions", []);
    syncSmartWorkspaceLabel();
    discoverWorktrees();
  }
});
if (window.HerdrDirectoryPicker) {
  [
    "workspaceCreatePath",
    "worktreeDiscoverPath",
    "worktreeCreateSource",
    "worktreePath",
    "worktreeNewPath",
  ].forEach((id) => window.HerdrDirectoryPicker.attach(id));
}
const terminalFollowButton = el("terminalFollowButton");
if (terminalFollowButton) terminalFollowButton.onclick = scrollTerminalToBottom;
function editableEventTarget(e) {
  const t = e.target;
  return (
    t &&
    (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
  );
}

window.addEventListener("keydown", closeShortcutKeydown, true);
window.addEventListener("keydown", handleGlobalShortcut, true);
document.addEventListener("keydown", (e) => {
  if (editableEventTarget(e)) return;
  const copyKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "c";
  const pasteKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "v";
  if (copyKey && term && term.getSelection && term.getSelection()) {
    e.preventDefault();
    copySelection();
  } else if (pasteKey) {
    // The chat lens covers the terminal while open: keystrokes belong to
    // the lens scroller / composer, and its own surfaces own paste. The
    // terminal clipboard read here used to fire mid-chat and paste the
    // clipboard into the hidden pty (focus/paste routing bug).
    if (globalThis.HerdrLens && globalThis.HerdrLens.isActive && globalThis.HerdrLens.isActive())
      return;
    e.preventDefault();
    pasteClipboard();
  }
});
window.onpopstate = handleSessionPopState;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(noSleepPollTimer);
    updateConnectionChip();
    hiddenTimer = setTimeout(() => {
      if (eventWs) eventWs.close();
      if (termWs) termWs.close();
    }, 1000);
  } else {
    clearTimeout(hiddenTimer);
    updateConnectionChip();
    loadVersions();
    refresh();
    connectEvents();
    loadNoSleep();
  }
});
window.addEventListener("focus", loadNoSleep);
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
setupSessionChrome();
setupRightSidebarRail();
applyTheme();
applyDensity();
applyOptions();
if (globalThis.HerdrLens && globalThis.HerdrLens.insertLensSwitch)
  HerdrLens.insertLensSwitch();
syncNoSleepControls();
loadNoSleep();
// Deep-URL boots land straight on a routed session (/session/work/...).
// Parse the route now so the boot-time backend bookkeeping (first-load
// adoption in loadVersions, enabled-backends re-validation) reads and
// writes the routed session's pin instead of the default session's, and
// re-pin that session's stored backend. A fresh boot on "/" keeps the
// default session's pin. Nothing auto-opens either way (the boot-clean
// rule): refresh() only restores what the URL itself describes.
parseRoute();
state.sessionBackend = readSessionBackend(state.session || "default");
// Paint skeleton placeholders (same shape as the real rows) into the
// sections that wait on connectivity at boot: the versions line (/api/versions),
// the workspace list and agents list (first refresh), and the terminal
// surface (websocket attach). The caches are seeded with the skeleton HTML
// so the first real render() overwrites them ("" !== skeleton).
(function paintBootSkeletons() {
  const skeleton = window.HerdrSkeleton;
  const versionsEl = el("versions");
  if (versionsEl && skeleton) versionsEl.innerHTML = skeleton.banner();
  if (skeleton) {
    workspaces.innerHTML = skeleton.workspaces(3);
    lastWorkspacesHtml = skeleton.workspaces(3);
    agents.innerHTML = skeleton.agents(2);
    lastAgentsHtml = skeleton.agents(2);
  }
  setTerminalLoading(true);
})();
loadVersions();
loadServerSettings();
refresh();
connectEvents();
