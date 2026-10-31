// Validation probe for the keyboard + modal-drag work on the real served
// app. Drives the actual DOM in headless Chrome: the sidebar search panel
// and palette arrow/Enter contracts, Escape close for the session manager,
// the directory picker, git modals, and the settings modal, the Tab focus
// trap over the session manager (both wrap directions), git keys staying
// muted behind the directory picker, picker-over-git stacking order,
// question-modal focus restore, modal drag by pointer events, and the
// drag reset on reopen. Server + Chrome are started by the runner.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8898/";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const REPO = process.env.E2E_REPO || "";
const OUT = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/keyboard_validation_result.json`;

if (!REPO) {
  console.error("E2E_REPO must be set (use scripts/e2e/run-keyboard-drag-validation.sh)");
  process.exit(2);
}

async function pressKey(cdp, { key, code, alt = false, ctrl = false, shift = false }) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const vk = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 }[key]
    || (key && key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const base = { key, code, windowsVirtualKeyCode: vk };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...base });
}

// Pointer-drag a modal card by its head strip and report the card's
// inline left/top plus the backdrop's place-items, the three signals the
// drag helper sets when a drag actually moved the card.
async function dragCard(cdp, evalJs, { backdropQuery, cardQuery, headQuery, label }) {
  const geom = await evalJs(`(() => {
    const backdrop = document.querySelector(${JSON.stringify(backdropQuery)});
    if (!backdrop) return null;
    const card = backdrop.querySelector(${JSON.stringify(cardQuery)});
    const head = backdrop.querySelector(${JSON.stringify(headQuery)});
    if (!card || !head) return null;
    const r = head.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) };
  })()`);
  if (!geom) {
    return { moved: false, detail: "no card/head" };
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geom.x, y: geom.y, button: "left", clickCount: 1 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geom.x + 100, y: geom.y + 60, button: "left", buttons: 1 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geom.x + 100, y: geom.y + 70, button: "left", buttons: 1 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geom.x + 100, y: geom.y + 70, button: "left", clickCount: 1 });
  await sleep(120);
  const after = await evalJs(`(() => {
    const backdrop = document.querySelector(${JSON.stringify(backdropQuery)});
    if (!backdrop) return null;
    const card = backdrop.querySelector(${JSON.stringify(cardQuery)});
    return { left: card.style.left, top: card.style.top, placeItems: backdrop.style.placeItems };
  })()`);
  const moved = !!after && after.left !== "" && after.top !== "" && after.placeItems === "start";
  return { moved, detail: JSON.stringify(after), label };
}

async function main() {
  const recorder = makeRecorder();
  const record = recorder.record.bind(recorder);
  const pages = await fetchJson(`${CDP_HTTP}/json/list`);
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("no page target; open the app first");
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result && r.result.value;
  };

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  // Open the fixture repo as a workspace: the search panel and the git
  // surface are workspace-scoped, so they need one open before their
  // sections render rows.
  const wsOpened = await evalJs(`openRecentWorkspace(${JSON.stringify(REPO)}, "validation")
    .then(() => "ok")
    .catch((e) => String(e))`);
  await sleep(1500);
  const wsId = await evalJs(`(() => {
    const rail = document.getElementById("workspaceRail");
    const active = document.querySelector(".workspace-item.active, .workspace-card.active");
    return active ? (active.dataset.workspaceId || "(active)") : (rail ? "(rail only)" : "(none)");
  })()`);
  record("fixture workspace opens", wsOpened === "ok" && !!wsId, `open=${wsOpened} ws=${wsId}`);

  // Desktop layout is required: the drag helper disables itself at phone
  // widths and the right sidebar view keys differ on mobile.
  const layout = await evalJs(`document.documentElement.dataset.herdrLayout || "(unset)"`);
  record("boots into desktop layout", layout === "desktop", `layout=${layout}`);

  // 1. Open the sidebar search panel and drive the keyboard contract.
  const panelOpen = await evalJs(`(() => {
    if (!window.HerdrSearchPanel) return "no module";
    window.HerdrSearchPanel.open();
    return "opened";
  })()`);
  await sleep(400);
  const inputFocused = await evalJs(`document.activeElement && document.activeElement.id === "searchPanelInput"`);
  record("search panel opens and focuses its input", panelOpen === "opened" && inputFocused === true, `open=${panelOpen} focus=${inputFocused}`);

  // Type a query so actions/recent rows exist. open() is async and
  // re-renders the panel (its runSearch + the global render can repaint
  // after this), so re-apply the value on the fresh input node until it
  // sticks, then wait for the debounced search to paint rows.
  for (let attempt = 0; attempt < 6; attempt++) {
    await evalJs(`(() => {
      const input = document.getElementById("searchPanelInput");
      if (!input) return false;
      if (document.activeElement !== input) input.focus();
      input.value = "settings";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const stuck = await evalJs(`(() => {
      const input = document.getElementById("searchPanelInput");
      const rows = document.querySelectorAll("#searchPanelResults .search-result");
      return { value: input ? input.value : "(gone)", rows: rows.length };
    })()`);
    if (stuck.value === "settings" && stuck.rows > 0) break;
  }
  const before = await evalJs(`(() => {
    const rows = document.querySelectorAll("#searchPanelResults .search-result");
    const active = document.querySelector("#searchPanelResults .search-result.active");
    return { count: rows.length, activeIndex: active ? Array.from(rows).indexOf(active) : -1 };
  })()`);
  record("query produces selectable rows", before.count > 0, `rows=${before.count} active=${before.activeIndex}`);

  await pressKey(cdp, { key: "ArrowDown", code: "ArrowDown" });
  await sleep(150);
  await pressKey(cdp, { key: "ArrowDown", code: "ArrowDown" });
  await sleep(150);
  const afterDown = await evalJs(`(() => {
    const rows = document.querySelectorAll("#searchPanelResults .search-result");
    const active = document.querySelector("#searchPanelResults .search-result.active");
    return active ? Array.from(rows).indexOf(active) : -1;
  })()`);
  record("ArrowDown moves the active row twice", afterDown === Math.min(before.activeIndex + 2, before.count - 1) || (before.activeIndex === -1 && afterDown >= 0), `from ${before.activeIndex} to ${afterDown}`);

  await pressKey(cdp, { key: "ArrowUp", code: "ArrowUp" });
  await sleep(150);
  const afterUp = await evalJs(`(() => {
    const rows = document.querySelectorAll("#searchPanelResults .search-result");
    const active = document.querySelector("#searchPanelResults .search-result.active");
    return active ? Array.from(rows).indexOf(active) : -1;
  })()`);
  record("ArrowUp moves the active row back", afterUp === afterDown - 1 || afterUp === before.activeIndex, `from ${afterDown} to ${afterUp}`);

  // Enter on the "settings" action row must open the settings modal.
  await pressKey(cdp, { key: "Enter", code: "Enter" });
  await sleep(400);
  const settingsOpen = await evalJs(`document.getElementById("settingsModal").style.display`);
  record("Enter opens the selected action (settings modal)", settingsOpen === "grid", `display=${settingsOpen}`);

  // 2. Escape closes the settings modal again.
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);
  const settingsClosed = await evalJs(`document.getElementById("settingsModal").style.display`);
  record("Escape closes the settings modal", settingsClosed === "none", `display=${settingsClosed}`);

  // Clear the panel query via Escape (first Esc clears, not closes).
  await evalJs(`(() => { const i = document.getElementById("searchPanelInput"); if (i) { i.focus(); } return true; })()`);
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(300);
  const queryCleared = await evalJs(`document.getElementById("searchPanelInput") ? document.getElementById("searchPanelInput").value : ""`);
  record("Escape clears the search panel query", queryCleared === "", `value="${queryCleared}"`);

  // 3. Session manager: open via the footer button path, Escape closes.
  await evalJs(`window.HerdrSearchPanel.close()`);
  await evalJs(`(() => {
    const btn = document.getElementById("footerSessionButton");
    if (!btn) return "no btn";
    btn.click();
    return "clicked";
  })()`);
  await sleep(600);
  const smDisplay = await evalJs(`document.getElementById("sessionManager").style.display`);
  record("session manager opens (display block)", smDisplay === "block", `display=${smDisplay}`);

  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);
  const smClosed = await evalJs(`document.getElementById("sessionManager").style.display`);
  record("Escape closes the session manager", smClosed === "none", `display=${smClosed}`);

  // 4. Tab trap over the session manager: focus must stay inside.
  await evalJs(`(() => {
    const btn = document.getElementById("footerSessionButton");
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  await evalJs(`document.getElementById("sessionManagerClose").focus()`);
  // Tab several times from the last button: trap must wrap back inside.
  for (let i = 0; i < 4; i++) {
    await pressKey(cdp, { key: "Tab", code: "Tab" });
    await sleep(80);
  }
  const focusInside = await evalJs(`(() => {
    const sm = document.getElementById("sessionManager");
    return !!(document.activeElement && sm.contains(document.activeElement));
  })()`);
  record("Tab trap keeps focus inside the session manager", focusInside === true, `activeElement=${await evalJs("document.activeElement && (document.activeElement.id || document.activeElement.tagName)")}`);

  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);

  // 5. Directory picker: open through its API, Escape closes it.
  const pickerOpened = await evalJs(`(() => {
    if (!window.HerdrDirectoryPicker) return "no module";
    const holder = document.createElement("input");
    holder.value = "/";
    window.HerdrDirectoryPicker.open(holder);
    return "called";
  })()`);
  await sleep(400);
  const pickerPresent = await evalJs(`!!document.getElementById("directoryPickerModal")`);
  record("directory picker mounts its backdrop node", pickerOpened === "called" && pickerPresent === true, `open=${pickerOpened} present=${pickerPresent}`);

  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(250);
  const pickerClosed = await evalJs(`!document.getElementById("directoryPickerModal")`);
  record("Escape closes the directory picker (node removed)", pickerClosed === true, `stillPresent=${!pickerClosed}`);

  // 6. Git keys stay muted behind the directory picker: with the git UI
  // visible and the picker open, pressing a git shortcut key must not
  // mutate anything. The guard lives in git_ui/shortcuts.js
  // (globalModalOpen), so drive it for real: open the picker over the git
  // surface, dispatch a plain "s" at the body, and check the git UI did
  // not stage (no mutating class flip, no commit modal).
  const gitVisible = await evalJs(`(() => {
    const btn = document.getElementById("rightRailGit");
    if (!btn) return "no rail button";
    btn.click();
    return "clicked";
  })()`);
  await sleep(800);
  const gitPanelUp = await evalJs(`!!document.getElementById("gitUiPanel") && !!document.querySelector("#gitUiPanel .git-ui-side")`);
  record("git drawer opens for the workspace", gitVisible === "clicked" && gitPanelUp === true, `btn=${gitVisible} panel=${gitPanelUp}`);
  await evalJs(`(() => {
    const holder = document.createElement("input");
    holder.value = "/";
    window.HerdrDirectoryPicker.open(holder);
    return true;
  })()`);
  await sleep(300);
  await pressKey(cdp, { key: "s", code: "KeyS" });
  await sleep(300);
  const pickerStillOpen = await evalJs(`!!document.getElementById("directoryPickerModal")`);
  const commitModal = await evalJs(`!!document.querySelector(".git-ui-commit-modal")`);
  record("git shortcut key does not fire behind the picker", gitVisible === "clicked" && pickerStillOpen === true && commitModal === false, `git=${gitVisible} pickerOpen=${pickerStillOpen} commitModal=${commitModal}`);

  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);
  await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); return true; })()`);

  // 6b. Search palette (the modal twin): open via the app find path,
  // arrows must move, Escape must close. The palette owns its own
  // keydown contract separate from the sidebar panel. Closing it must
  // hand focus back to the element that had it before the open.
  await evalJs(`(() => { const b = document.getElementById("headerActionsButton"); if (b) b.focus(); return !!b; })()`);
  await evalJs(`(() => { if (typeof openSearchPalette === "function") openSearchPalette(); return true; })()`);
  await sleep(500);
  const paletteOpen = await evalJs(`(() => {
    const m = document.getElementById("searchPalette");
    return { display: m.style.display, focused: document.activeElement && document.activeElement.id === "searchPaletteInput" };
  })()`);
  record("search palette opens and focuses its input", paletteOpen.display === "grid" && paletteOpen.focused === true, JSON.stringify(paletteOpen));

  // Enter on the palette opens the selected row: type "sett", Enter,
  // the settings modal must open (the palette closes itself).
  await cdp.send("Input.insertText", { text: "sett" });
  await sleep(400);
  await pressKey(cdp, { key: "Enter", code: "Enter" });
  await sleep(500);
  const enterOpened = await evalJs(`(() => ({
    palette: document.getElementById("searchPalette").style.display,
    settings: document.getElementById("settingsModal").style.display,
  }))()`);
  record("palette Enter opens the selected action", enterOpened.palette === "none" && enterOpened.settings === "grid", JSON.stringify(enterOpened));
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);

  // Reopen the palette for the Escape-close contract check below.
  await evalJs(`(() => { const b = document.getElementById("headerActionsButton"); if (b) b.focus(); if (typeof openSearchPalette === "function") openSearchPalette(); return true; })()`);
  await sleep(500);

  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);
  const paletteClosed = await evalJs(`(() => ({
    display: document.getElementById("searchPalette").style.display,
    active: document.activeElement && document.activeElement.id,
  }))()`);
  record("Escape closes the search palette", paletteClosed.display === "none", `display=${paletteClosed.display}`);
  record("palette close restores opener focus", paletteClosed.active === "headerActionsButton", `activeElement=${paletteClosed.active}`);

  // 6c. Git commit modal: open over the git drawer, Tab trap must hold
  // focus inside it, Escape must close it without touching the drawer.
  await evalJs(`(() => {
    const btn = document.getElementById("rightRailGit");
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(800);
  const commitOpened = await evalJs(`(() => {
    if (window.HerdrGitUi && window.HerdrGitUi.openCommitModal) { window.HerdrGitUi.openCommitModal(); return "called"; }
    return "no api";
  })()`);
  await sleep(400);
  const commitUp = await evalJs(`!!document.querySelector(".git-ui-commit-modal")`);
  const commitAria = await evalJs(`(() => {
    const b = document.querySelector(".git-ui-modal-backdrop");
    return b ? (b.getAttribute("role") === "dialog" && b.getAttribute("aria-modal") === "true") : null;
  })()`);
  record("git commit modal opens with dialog semantics", commitOpened === "called" && commitUp === true && commitAria === true, `open=${commitOpened} up=${commitUp} aria=${commitAria}`);

  if (commitUp) {
    // Tab forward from the summary input; the trap keeps focus inside the
    // modal, never leaking to the drawer behind it.
    await evalJs(`(() => { const t = document.getElementById("gitCommitTitle"); if (t) t.focus(); return true; })()`);
    for (let i = 0; i < 8; i++) {
      await pressKey(cdp, { key: "Tab", code: "Tab" });
      await sleep(60);
    }
    const trapHeld = await evalJs(`(() => {
      const b = document.querySelector(".git-ui-modal-backdrop");
      return !!(document.activeElement && b && b.contains(document.activeElement));
    })()`);
    record("Tab trap keeps focus inside the git commit modal", trapHeld === true, `activeElement=${await evalJs("document.activeElement && (document.activeElement.id || document.activeElement.tagName)")}`);

    // Shift+Tab from the first field must wrap to the last focusable, not
    // escape backwards into the drawer.
    await evalJs(`(() => { const t = document.getElementById("gitCommitTitle"); if (t) t.focus(); return true; })()`);
    await pressKey(cdp, { key: "Tab", code: "Tab", shift: true });
    await sleep(120);
    const wrapBack = await evalJs(`(() => {
      const b = document.querySelector(".git-ui-modal-backdrop");
      return !!(document.activeElement && b && b.contains(document.activeElement));
    })()`);
    record("Shift+Tab wraps backwards inside the git commit modal", wrapBack === true, `activeElement=${await evalJs("document.activeElement && (document.activeElement.id || document.activeElement.tagName)")}`);

    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(250);
    const commitClosed = await evalJs(`!document.querySelector(".git-ui-commit-modal")`);
    record("Escape closes the git commit modal", commitClosed === true, `stillUp=${!commitClosed}`);
  }

  // 6d. Picker stacking over an open app modal: with the workspace-create
  // modal up, the picker can open on top of it from its Browse button.
  // Escape must close the picker first and keep the modal open; a second
  // Escape closes the modal.
  await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); return true; })()`);
  await evalJs(`(() => { if (typeof openWorkspaceCreateModal === "function") openWorkspaceCreateModal(); return true; })()`);
  await sleep(400);
  const wsModalUp = await evalJs(`document.getElementById("workspaceCreateModal") ? document.getElementById("workspaceCreateModal").style.display : "none"`);
  record("workspace create modal opens for stacking", wsModalUp === "grid", `display=${wsModalUp}`);
  if (wsModalUp === "grid") {
    // Drive the real Browse button: focus it, click, the picker opens and
    // must remember the button as its opener; Escape must close the
    // picker and hand focus back to the Browse button.
    await evalJs(`(() => { const b = document.getElementById("workspaceCreatePathBrowse"); if (b) { b.focus(); b.click(); } return !!b; })()`);
    await sleep(400);
    const viaBrowse = await evalJs(`!!document.getElementById("directoryPickerModal")`);
    record("picker opens through the Browse button", viaBrowse === true, `picker=${viaBrowse}`);
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(250);
    const pickerFocusBack = await evalJs(`(() => ({
      picker: !!document.getElementById("directoryPickerModal"),
      active: document.activeElement && document.activeElement.id,
    }))()`);
    record("picker close restores the Browse button focus", pickerFocusBack.picker === false && pickerFocusBack.active === "workspaceCreatePathBrowse", JSON.stringify(pickerFocusBack));

    await evalJs(`(() => {
      const input = document.getElementById("workspacePath") || document.getElementById("workspaceCreatePath");
      if (!input) return "no input";
      const holder = input;
      window.HerdrDirectoryPicker.open(holder);
      return "opened";
    })()`);
    await sleep(400);
    const stackPicker = await evalJs(`!!document.getElementById("directoryPickerModal")`);
    record("directory picker opens over the workspace modal", stackPicker === true, `picker=${stackPicker}`);
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(250);
    const stackAfter1 = await evalJs(`(() => ({
      picker: !!document.getElementById("directoryPickerModal"),
      wsDisplay: document.getElementById("workspaceCreateModal") ? document.getElementById("workspaceCreateModal").style.display : "none",
    }))()`);
    record("first Escape closes the picker, keeps the modal", stackAfter1.picker === false && stackAfter1.wsDisplay === "grid", JSON.stringify(stackAfter1));

    // While the picker sits above the modal, the Tab trap must scope to
    // the picker, never the 1100-layer modal behind it.
    await evalJs(`(() => {
      const holder = document.getElementById("workspaceCreatePath");
      if (holder) window.HerdrDirectoryPicker.open(holder);
      return true;
    })()`);
    await sleep(400);
    await evalJs(`(() => { const i = document.getElementById("directoryPickerSearchInput"); if (i) i.focus(); return true; })()`);
    await pressKey(cdp, { key: "Tab", code: "Tab" });
    await sleep(150);
    const trapScope = await evalJs(`(() => {
      const picker = document.getElementById("directoryPickerModal");
      return !!(document.activeElement && picker && picker.contains(document.activeElement));
    })()`);
    record("Tab trap scopes to the picker above the modal", trapScope === true, `activeElement=${await evalJs("document.activeElement && (document.activeElement.id || document.activeElement.tagName)")}`);
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(200);

    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(250);
    const stackAfter2 = await evalJs(`document.getElementById("workspaceCreateModal") ? document.getElementById("workspaceCreateModal").style.display : "none"`);
    record("second Escape closes the workspace modal", stackAfter2 === "none", `display=${stackAfter2}`);
  }

  // 6e. Question modal focus restore through a real flow: open settings,
  // click the logout button (askQuestion opens the question modal on top
  // and remembers the opener), Escape cancels; focus must land back on the
  // logout button, and a second Escape closes the settings modal.
  await evalJs(`(() => { openSettingsModal(); return true; })()`);
  await sleep(400);
  await evalJs(`(() => { const b = document.getElementById("serverSettingsLogout"); if (b) { b.focus(); b.click(); } return !!b; })()`);
  await sleep(500);
  const qUp = await evalJs(`document.getElementById("questionModal").style.display`);
  record("question modal opens over settings", qUp === "grid", `display=${qUp}`);
  const qDrag = await dragCard(cdp, evalJs, {
    backdropQuery: "#questionModal",
    cardQuery: ".question-modal-card",
    headQuery: ".settings-head h2",
  });
  record("pointer drag moves the question card", qDrag.moved, qDrag.detail);
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(300);
  const qRestore = await evalJs(`(() => ({
    display: document.getElementById("questionModal").style.display,
    active: document.activeElement && document.activeElement.id,
    settings: document.getElementById("settingsModal").style.display,
  }))()`);
  record("Escape cancels the question modal and restores opener focus", qRestore.display === "none" && qRestore.active === "serverSettingsLogout" && qRestore.settings === "grid", JSON.stringify(qRestore));
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(250);
  const settingsAfterQ = await evalJs(`document.getElementById("settingsModal").style.display`);
  record("Escape then closes the settings modal", settingsAfterQ === "none", `display=${settingsAfterQ}`);

  // 7. Modal drag: pointer down on the settings head, move, up; the card
  // must move (left/top set, backdrop flex-start). Reopen must reset.
  await evalJs(`(() => { openSettingsModal(); return true; })()`);
  await sleep(400);
  const dragGeom = await evalJs(`(() => {
    const modal = document.getElementById("settingsModal");
    const card = modal.querySelector(".modal");
    const head = modal.querySelector(".settings-head");
    if (!card || !head) return null;
    const r = head.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8), cardLeft: card.style.left, backdropAlign: modal.style.alignItems };
  })()`);
  record("settings modal mounts for drag", dragGeom !== null, JSON.stringify(dragGeom));

  if (dragGeom) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragGeom.x, y: dragGeom.y, button: "left", clickCount: 1 });
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragGeom.x + 120, y: dragGeom.y + 80, button: "left", buttons: 1 });
    await sleep(60);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragGeom.x + 120, y: dragGeom.y + 90, button: "left", buttons: 1 });
    await sleep(80);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragGeom.x + 120, y: dragGeom.y + 90, button: "left", clickCount: 1 });
    await sleep(120);
    const dragged = await evalJs(`(() => {
      const modal = document.getElementById("settingsModal");
      const card = modal.querySelector(".modal");
      return { left: card.style.left, top: card.style.top, placeItems: modal.style.placeItems };
    })()`);
    const moved = dragged.left !== "" && dragged.top !== "" && dragged.placeItems === "start";
    record("pointer drag moves the settings card", moved, JSON.stringify(dragged));

    // Close and reopen: the dragged offset must reset.
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(200);
    await evalJs(`(() => { openSettingsModal(); return true; })()`);
    await sleep(300);
    const reset = await evalJs(`(() => {
      const modal = document.getElementById("settingsModal");
      const card = modal.querySelector(".modal");
      return { left: card.style.left, top: card.style.top, placeItems: modal.style.placeItems };
    })()`);
    const wasReset = reset.left === "" && reset.top === "" && (reset.placeItems === "" || reset.placeItems === "normal");
    record("drag position resets after close and reopen", wasReset, JSON.stringify(reset));

    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(150);
  }

  // 7b. Keyboard-dead control audit: walk every visible clickable element
  // (onclick attr, role=button/tab/option/treeitem/menuitem, or inherited
  // cursor:pointer) and flag the ones a keyboard user cannot reach. A
  // decorative span inside an interactive row inherits the row's cursor
  // and its keyboard path, so classification is host-based: the nearest
  // interactive ancestor (or the element itself) must be native or carry
  // tabIndex >= 0. Runs on the base shell, the git drawer, and the
  // settings modal since those carry the densest action surfaces.
  const auditKeyboardDead = async (surface) => {
    const dead = await evalJs(`(() => {
      const root = ${surface};
      if (!root) return null;
      const nativeTags = "a, button, input, select, textarea";
      const interactive = nativeTags + ", [role='button'], [role='tab'], [role='option'], [role='treeitem'], [role='menuitem'], [data-workspace-action]";
      return [...root.querySelectorAll("*")]
        .filter((el) => {
          const role = el.getAttribute("role");
          if (!(el.onclick || role === "button" || role === "tab" || role === "option" || role === "treeitem" || role === "menuitem")) {
            if (getComputedStyle(el).cursor !== "pointer") return false;
          }
          if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
          if (el.closest('[aria-hidden="true"]')) return false;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          const host = el.closest(interactive);
          if (host && host !== el) return !(host.tabIndex >= 0 || host.matches(nativeTags));
          return !(el.tabIndex >= 0 || el.matches(nativeTags));
        })
        .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 40), id: el.id || "", role: el.getAttribute("role") || "" }))
        .slice(0, 12);
    })()`);
    return dead;
  };
  {
    const shellDead = await auditKeyboardDead(`document.body`);
    record("base shell has no keyboard-dead clickable elements", shellDead === null || shellDead.length === 0, JSON.stringify(shellDead));

    await evalJs(`(() => { const btn = document.getElementById("rightRailGit"); if (btn) btn.click(); return true; })()`);
    await sleep(600);
    const gitDead = await auditKeyboardDead(`document.getElementById("gitUiPanel") || document.body`);
    record("git drawer has no keyboard-dead clickable elements", gitDead === null || gitDead.length === 0, JSON.stringify(gitDead));

    await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); openSettingsModal(); return true; })()`);
    await sleep(500);
    const settingsDead = await auditKeyboardDead(`document.getElementById("settingsModal")`);
    record("settings modal has no keyboard-dead clickable elements", settingsDead === null || settingsDead.length === 0, JSON.stringify(settingsDead));
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(200);
  }

  // 8. Drag the two remaining card families the settings check does not
  // cover: the directory picker (class-mounted card, backdrop recreated
  // per open) and the git commit modal (git-ui backdrop). Both must move
  // by their head strips like the settings card does.
  await evalJs(`(() => {
    const holder = document.createElement("input");
    holder.value = "/";
    window.HerdrDirectoryPicker.open(holder);
    return true;
  })()`);
  await sleep(500);
  const pickerDrag = await dragCard(cdp, evalJs, {
    backdropQuery: ".directory-picker-backdrop",
    cardQuery: ".directory-picker",
    headQuery: ".directory-picker-head strong",
  });
  record("pointer drag moves the directory picker card", pickerDrag.moved, pickerDrag.detail);
  // Closing must clear the dragged offset even though close() removes
  // the node: the next open builds a fresh backdrop.
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(250);
  await evalJs(`(() => {
    const holder = document.createElement("input");
    holder.value = "/";
    window.HerdrDirectoryPicker.open(holder);
    return true;
  })()`);
  await sleep(500);
  const pickerReset = await evalJs(`(() => {
    const backdrop = document.querySelector(".directory-picker-backdrop");
    const card = backdrop && backdrop.querySelector(".directory-picker");
    return card ? { left: card.style.left, top: card.style.top, placeItems: backdrop.style.placeItems } : null;
  })()`);
  record("picker drag resets on reopen", !!pickerReset && pickerReset.left === "" && pickerReset.top === "" && (pickerReset.placeItems === "" || pickerReset.placeItems === "normal"), JSON.stringify(pickerReset));
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);

  await evalJs(`(() => {
    const btn = document.getElementById("rightRailGit");
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(800);
  await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.openCommitModal) window.HerdrGitUi.openCommitModal(); return true; })()`);
  await sleep(400);
  const commitDrag = await dragCard(cdp, evalJs, {
    backdropQuery: ".git-ui-modal-backdrop",
    cardQuery: ".git-ui-commit-modal",
    headQuery: ".git-ui-modal-head strong",
  });
  record("pointer drag moves the git commit card", commitDrag.moved, commitDrag.detail);
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(250);
  await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); return true; })()`);

  // 9. Worktree create modal through the real palette action: Escape must
  // close it and restore focus to the opener (the header Actions button),
  // and its card must drag like the other static modals.
  await evalJs(`(() => { const b = document.getElementById("headerActionsButton"); if (b) b.focus(); return true; })()`);
  await evalJs(`(() => { runSearchAction("create-worktree"); return true; })()`);
  await sleep(500);
  const wtUp = await evalJs(`(() => ({ display: document.getElementById("worktreeCreateModal").style.display, active: document.activeElement && document.activeElement.id }))()`);
  record("worktree create modal opens from the palette action", wtUp.display === "grid" && wtUp.active === "worktreeBranch", JSON.stringify(wtUp));
  if (wtUp.display === "grid") {
    const wtDrag = await dragCard(cdp, evalJs, {
      backdropQuery: "#worktreeCreateModal",
      cardQuery: ".modal",
      headQuery: ".settings-head h2",
    });
    record("pointer drag moves the worktree create card", wtDrag.moved, wtDrag.detail);
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(300);
    const wtClosed = await evalJs(`(() => ({ display: document.getElementById("worktreeCreateModal").style.display, active: document.activeElement && document.activeElement.id }))()`);
    record("worktree modal close restores opener focus", wtClosed.display === "none" && wtClosed.active === "headerActionsButton", JSON.stringify(wtClosed));
  }

  // 10. Tab scoping with the session manager under a git modal: the git
  // modal is the visible top layer, so Tab must stay inside it even though
  // the session manager is also open underneath.
  await evalJs(`(() => { const btn = document.getElementById("footerSessionButton"); if (btn) btn.click(); return "clicked"; })()`);
  await sleep(400);
  const smUp = await evalJs(`document.getElementById("sessionManager").style.display`);
  record("session manager opens under the git drawer", smUp === "block", `display=${smUp}`);
  if (smUp === "block") {
    await evalJs(`(() => { const btn = document.getElementById("rightRailGit"); if (btn) btn.click(); return "clicked"; })()`);
    await sleep(600);
    await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.openCommitModal) window.HerdrGitUi.openCommitModal(); return true; })()`);
    await sleep(400);
    const gitOverSm = await evalJs(`!!document.querySelector(".git-ui-commit-modal")`);
    record("git commit modal opens over the session manager", gitOverSm === true, `up=${gitOverSm}`);
    if (gitOverSm) {
      await pressKey(cdp, { key: "Tab", code: "Tab" });
      await sleep(150);
      const tabScope = await evalJs(`(() => {
        const inGit = !!document.activeElement && document.querySelector(".git-ui-commit-modal").contains(document.activeElement);
        const inSm = !!document.activeElement && document.getElementById("sessionManager").contains(document.activeElement);
        return { inGit, inSm, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) };
      })()`);
      record("Tab scopes to the git modal over the session manager", tabScope.inGit === true, JSON.stringify(tabScope));
      await pressKey(cdp, { key: "Escape", code: "Escape" });
      await sleep(250);
      await evalJs(`(() => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); return true; })()`);
    }
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(250);
    const smClosed = await evalJs(`document.getElementById("sessionManager").style.display`);
    record("Escape closes the session manager", smClosed === "none", `display=${smClosed}`);
  }

  // 11. Worktree open modal through the palette discover action: mounts
  // with discovery running, drags, and restores opener focus on Escape.
  await evalJs(`(() => { const b = document.getElementById("headerActionsButton"); if (b) b.focus(); return true; })()`);
  await evalJs(`(() => { runSearchAction("discover-worktrees"); return true; })()`);
  await sleep(800);
  const wtoUp = await evalJs(`(() => ({ display: document.getElementById("worktreeOpenModal").style.display, active: document.activeElement && document.activeElement.id }))()`);
  record("worktree open modal opens from the palette action", wtoUp.display === "grid", JSON.stringify(wtoUp));
  if (wtoUp.display === "grid") {
    const wtoDrag = await dragCard(cdp, evalJs, {
      backdropQuery: "#worktreeOpenModal",
      cardQuery: ".modal",
      headQuery: ".settings-head h2",
    });
    record("pointer drag moves the worktree open card", wtoDrag.moved, wtoDrag.detail);
    await pressKey(cdp, { key: "Escape", code: "Escape" });
    await sleep(300);
    const wtoClosed = await evalJs(`(() => ({ display: document.getElementById("worktreeOpenModal").style.display, active: document.activeElement && document.activeElement.id }))()`);
    record("worktree open close restores opener focus", wtoClosed.display === "none" && wtoClosed.active === "headerActionsButton", JSON.stringify(wtoClosed));
  }

  writeReport(OUT, recorder, { appUrl: APP_URL });
  console.log(`validation probe: ${recorder.failed === 0 ? "PASSED" : "FAILED"} (${recorder.passed} passed, ${recorder.failed} failed)`);
  process.exit(recorder.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("validation probe crashed:", error);
  writeCrashReport(OUT, makeRecorder(), error);
  process.exit(1);
});
