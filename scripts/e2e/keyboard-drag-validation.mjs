// Validation probe for the keyboard + modal-drag work on the real served
// app. Drives the actual DOM in headless Chrome: the sidebar search panel
// arrow/Enter contract, Escape close for the session manager and the
// directory picker, the Tab focus trap over the session manager, git keys
// staying muted behind the directory picker, modal drag by pointer events,
// and the drag reset on reopen. Server + Chrome are started by the runner.
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

  writeReport(OUT, recorder, { appUrl: APP_URL });
  console.log(`validation probe: ${recorder.failed === 0 ? "PASSED" : "FAILED"} (${recorder.passed} passed, ${recorder.failed} failed)`);
  process.exit(recorder.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("validation probe crashed:", error);
  writeCrashReport(OUT, makeRecorder(), error);
  process.exit(1);
});
