// Real-DOM acceptance for the terminal-decoupling feature (update_windows
// batch). Boots an isolated server + chrome-headless (run-terminal-decouple-
// e2e.sh), then drives the real served bundle through CDP:
//
//   td1  workspace.create with open_terminal:false answers zero tabs
//   td2  the desktop app renders the empty-leaf body (hint + New terminal)
//   td3  the New terminal button mints a live Shell tab
//   td4  closing the last tab keeps the workspace alive (no auto-close)
//   td5  the workspace still renders its empty-leaf body after the close
//   td6  worktree.open with open_terminal:false mints no tab either
//   td7  settings exposes workspaceOpenTerminal and the checkbox persists
//   td8  with closeWorkspaceOnLastTerminal on, closing the last tab asks; Escape cancels the close, Confirm proceeds
//   td9  the selection falls back to another open workspace after the confirmed auto-close
//   td10 the zero-tab body answers Enter with a minted Shell tab (CDP key event)
//
// window.confirm is auto-accepted for the tab close (Page.setBypassCSP is
// not needed; the app overrides confirm with confirmCloseTab semantics
// wired through Page.javascriptDialogOpening auto-accept). The workspace
// auto-close asks through the in-app question modal: td8 drives a real
// Escape (cancel) round and a real Confirm click (proceed) round.
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8898/";
const REPO = process.env.REPO;
const REPO2 = process.env.REPO2 || `${REPO}-second`;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/terminal_decouple_e2e_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-terminal-decouple-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  // The tab close path goes through window.confirm; auto-accept every
  // javascript dialog so the close POST always proceeds.
  cdp.on("Page.javascriptDialogOpening", () => {
    cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  await reload();

  // The fixture must opt out of the default-on closeWorkspaceOnLastTerminal:
  // td4/td5 assert the workspace survives a last-tab close. td8 flips the
  // option on through the real checkbox to cover the auto-close path.
  await evalExpr(`(() => {
    const raw = localStorage.getItem("herdr-web-options");
    const blob = raw ? JSON.parse(raw) : {};
    blob.closeWorkspaceOnLastTerminal = false;
    localStorage.setItem("herdr-web-options", JSON.stringify(blob));
    return "seeded";
  })()`);
  await reload();
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "td-e2e", open_terminal: false})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  const tabId0 = made && made.result && made.result.tab ? made.result.tab.tab_id : null;
  record("td1 create with open_terminal:false answers no tab", !!wsId && !tabId0, `ws=${wsId} tab=${tabId0}`);
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  await reload(`${APP_URL}session/default/workspace/${wsId}`);

  const loaded = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state && state.workspaces && state.workspaces.length) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("app loaded the workspace list", loaded === "loaded", `got ${loaded}`);
  if (loaded !== "loaded") throw new Error("app never loaded the workspace list");

  // td2: the desktop app renders the empty-leaf body for the zero-tab ws.
  // The section carries .workspace-empty-leaf; visibility is the hidden
  // attribute (emptyLeaf.hidden = !show), not offset box.
  const leafInfo = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const card = document.getElementById("workspaceEmptyLeaf");
      if (card && !card.hidden && card.querySelector(".workspace-empty-leaf-card")) {
        return JSON.stringify({
          visible: !card.hidden,
          name: (card.querySelector("h1") || {}).textContent || "",
          hasButton: !!card.querySelector("button.workspace-empty-leaf-new"),
          hasHint: !!card.querySelector(".workspace-empty-leaf-hint"),
          hasKbd: !!card.querySelector(".workspace-empty-leaf-hint kbd"),
          text: (card.textContent || "").slice(0, 200),
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-leaf";
  })()`);
  let leaf = null;
  try { leaf = JSON.parse(leafInfo); } catch { /* handled below */ }
  record("td2 empty-leaf body renders for the zero-tab workspace", !!leaf && leaf.visible && leaf.hasButton && leaf.hasHint && leaf.hasKbd, leafInfo.slice(0, 300));

  // td3: the New terminal button mints a live Shell tab.
  const minted = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const card = document.getElementById("workspaceEmptyLeaf");
      const btn = card && card.querySelector("button.workspace-empty-leaf-new");
      if (btn) {
        btn.click();
        await new Promise((r) => setTimeout(r, 2000));
        return JSON.stringify({ ws: state.ws, tab: state.tab, pane: state.pane, terminalId: state.terminalId });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-button";
  })()`);
  let mintInfo = null;
  try { mintInfo = JSON.parse(minted); } catch { mintInfo = null; }
  record("td3 New terminal button mints a Shell tab", !!mintInfo && !!mintInfo.tab && !!mintInfo.pane && !!mintInfo.terminalId, minted.slice(0, 300));
  if (!mintInfo || !mintInfo.tab) throw new Error("New terminal did not mint a tab: " + minted.slice(0, 300));

  // td4: closing the last tab keeps the workspace alive. The real UI path
  // is the pane tab strip close control: a span[role=button].pane-tab-close
  // with aria-label "Close panel"; drive it as a trusted click. The click
  // can race a re-render of the strip, so retry until the tab count drops.
  const closeInfo = await (async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pt = await evalExpr(`(() => {
        const strip = document.getElementById("workspacePanes");
        if (!strip) return "no-strip";
        const ctrl = strip.querySelector(".pane-tab-close[aria-label='Close panel']");
        if (!ctrl) return "no-close";
        const r = ctrl.getBoundingClientRect();
        if (!r.width || !r.height) return "zero-rect";
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`);
      // A missing or zero-sized control is a transient render state, not a
      // verdict: the strip repaints on poll ticks, so retry inside the loop.
      if (!pt || pt === "no-strip" || pt === "no-close" || pt === "zero-rect") {
        await sleep(400);
        continue;
      }
      const point = JSON.parse(pt);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
      await sleep(150);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      // Wait for the close to land; retry the click if the tab survives.
      const outcome = await evalExpr(`(async () => {
        const started = Date.now();
        while (Date.now() - started < 4000) {
          const tabs = (state.tabs || []).filter((t) => t.workspace_id === state.ws);
          if (tabs.length === 0) return "closed";
          await new Promise((r) => setTimeout(r, 300));
        }
        return "still-open";
      })()`);
      if (outcome === "closed") break;
    }
    return await evalExpr(`(() => {
      const tabs = (state.tabs || []).filter((t) => t.workspace_id === state.ws);
      return JSON.stringify({ ws: state.ws, tab: state.tab, pane: state.pane, terminalId: state.terminalId, wsAlive: !!(state.workspaces || []).some((x) => x.workspace_id === state.ws), tabsLen: tabs.length });
    })()`);
  })();
  let closedInfo = null;
  try { closedInfo = JSON.parse(closeInfo); } catch { closedInfo = null; }
  record("td4 closing the last tab keeps the workspace alive", !!closedInfo && closedInfo.wsAlive && closedInfo.tabsLen === 0 && !closedInfo.tab && !closedInfo.pane, closeInfo.slice(0, 300));

  // td5: the workspace renders its empty-leaf body again after the close.
  await sleep(1200);
  const leaf2 = await evalExpr(`(() => {
    const card = document.getElementById("workspaceEmptyLeaf");
    if (!card) return "no-leaf";
    return JSON.stringify({
      visible: !card.hidden,
      hasButton: !!card.querySelector("button.workspace-empty-leaf-new"),
    });
  })()`);
  let leafInfo2 = null;
  try { leafInfo2 = JSON.parse(leaf2); } catch { leafInfo2 = null; }
  record("td5 empty-leaf body renders again after closing the last tab", !!leafInfo2 && leafInfo2.visible && leafInfo2.hasButton, leaf2.slice(0, 300));

  // td6: worktree.open with open_terminal:false mints no tab. A second
  // fixture repo is needed: posting the same path would focus the existing
  // workspace (created in td1) and answer its already-live tab.
  const opened = await evalExpr(`fetch("/api/worktrees/open", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({workspace_id: null, cwd: null, path: ${JSON.stringify(REPO2)}, label: null, branch: null, open_terminal: false})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const openedTab = opened && opened.result && opened.result.tab ? opened.result.tab.tab_id : null;
  record("td6 worktree.open with open_terminal:false answers no tab", !openedTab, `tab=${openedTab}`);

  // td7: settings exposes workspaceOpenTerminal and the checkbox reflects
  // the persisted value. The default is false (off), so the checkbox must
  // start unchecked.
  const settingsInfo = await evalExpr(`(() => {
    const box = document.getElementById("optWorkspaceOpenTerminal");
    if (!box) return "no-checkbox";
    return JSON.stringify({ checked: box.checked, inOptions: typeof options.workspaceOpenTerminal, flag: workspaceOpenTerminalFlag() });
  })()`);
  let settings = null;
  try { settings = JSON.parse(settingsInfo); } catch { settings = null; }
  record("td7 settings checkbox exists, default off, flag follows it", !!settings && settings.checked === false && settings.inOptions === "boolean" && settings.flag === false, settingsInfo.slice(0, 300));

  // td8: flip closeWorkspaceOnLastTerminal on through the real checkbox,
  // then close the last tab on the focused workspace. The auto-close now
  // asks first: Escape must cancel it (workspace survives), a real click
  // on the question's Confirm button must close it. td6 left the app with
  // only the td1 workspace open (zero tabs after td4), so mint one tab
  // first.
  const flipInfo = await evalExpr(`(async () => {
    document.getElementById("settingsToggle").click();
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const box = document.getElementById("optCloseWorkspaceOnLastTerminal");
      if (box) {
        if (!box.checked) box.click();
        await new Promise((r) => setTimeout(r, 400));
        document.getElementById("settingsClose").click();
        return JSON.stringify({ checked: box.checked, inOptions: typeof options.closeWorkspaceOnLastTerminal, flag: closeWorkspaceOnLastTerminalFlag() });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-checkbox";
  })()`);
  let flipped = null;
  try { flipped = JSON.parse(flipInfo); } catch { flipped = null; }
  record("td8a settings checkbox for close-on-last-terminal exists and turns on", !!flipped && flipped.checked === true && flipped.inOptions === "boolean" && flipped.flag === true, flipInfo.slice(0, 300));

  // Focus the zero-tab workspace from td1 so the minted tab belongs to it.
  await reload(`${APP_URL}session/default/workspace/${wsId}`);
  await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state && state.workspaces && state.workspaces.length) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  const mint2 = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const card = document.getElementById("workspaceEmptyLeaf");
      const btn = card && card.querySelector("button.workspace-empty-leaf-new");
      if (btn) {
        btn.click();
        await new Promise((r) => setTimeout(r, 2000));
        return JSON.stringify({ ws: state.ws, tab: state.tab, tabs: (state.tabs || []).filter((t) => t.workspace_id === state.ws).length });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-button";
  })()`);
  let mint2Info = null;
  try { mint2Info = JSON.parse(mint2); } catch { mint2Info = null; }
  record("td8b last-tab fixture mints one tab on the target workspace", !!mint2Info && mint2Info.ws === wsId && mint2Info.tab && mint2Info.tabs === 1, mint2.slice(0, 300));

  // Close the only tab through the real pane-tab close control and wait
  // for the auto-close question modal to appear.
  const clickLastTabClose = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pt = await evalExpr(`(() => {
        const strip = document.getElementById("workspacePanes");
        if (!strip) return "no-strip";
        const ctrl = strip.querySelector(".pane-tab-close[aria-label='Close panel']");
        if (!ctrl) return "no-close";
        const r = ctrl.getBoundingClientRect();
        if (!r.width || !r.height) return "zero-rect";
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`);
      // Same transience rule as td4: retry a missing control inside the
      // loop; only the final state dump below is the verdict.
      if (!pt || pt === "no-strip" || pt === "no-close" || pt === "zero-rect") {
        await sleep(400);
        continue;
      }
      const point = JSON.parse(pt);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
      await sleep(150);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      const asked = await evalExpr(`(async () => {
        const started = Date.now();
        while (Date.now() - started < 6000) {
          const modal = document.getElementById("questionModal");
          if (modal && modal.style.display === "grid") return "asked";
          await new Promise((r) => setTimeout(r, 200));
        }
        return "no-modal";
      })()`);
      if (asked === "asked") return "asked";
    }
    return "no-modal";
  };

  // Round 1: Escape must abort the close entirely; the emptied workspace
  // stays open client-side and server-side.
  const escapeRound = await clickLastTabClose();
  const escapeInfo = escapeRound === "asked"
    ? await evalExpr(`(async () => {
        const modal = document.getElementById("questionModal");
        const title = document.getElementById("questionTitle").textContent;
        const message = document.getElementById("questionMessage").textContent;
        modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
        const list = await fetch("/api/workspaces").then((r) => r.json()).catch(() => null);
        const ids = list && list.result && Array.isArray(list.result.workspaces) ? list.result.workspaces.map((w) => w.workspace_id) : null;
        return JSON.stringify({
          title,
          message,
          modalClosed: modal.style.display !== "grid",
          wsAlive: (state.workspaces || []).some((x) => x.workspace_id === "${wsId}"),
          tabsLen: (state.tabs || []).filter((t) => t.workspace_id === "${wsId}").length,
          serverIds: ids,
        });
      })()`)
    : JSON.stringify({ click: escapeRound });
  let escapeResult = null;
  try { escapeResult = JSON.parse(escapeInfo); } catch { escapeResult = null; }
  record("td8c Escape cancels the auto-close question and the workspace survives",
    !!escapeResult && escapeResult.modalClosed === true && escapeResult.wsAlive === true &&
    escapeResult.tabsLen === 0 && Array.isArray(escapeResult.serverIds) && escapeResult.serverIds.includes(wsId),
    escapeInfo.slice(0, 300));

  // Round 2: the Escape round left the workspace empty, so re-mint its
  // last tab, close it again, and click the question's Confirm button.
  const mint3 = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const card = document.getElementById("workspaceEmptyLeaf");
      const btn = card && card.querySelector("button.workspace-empty-leaf-new");
      if (btn) {
        btn.click();
        await new Promise((r) => setTimeout(r, 2000));
        return JSON.stringify({ tab: state.tab, tabs: (state.tabs || []).filter((t) => t.workspace_id === "${wsId}").length });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-button";
  })()`);
  let mint3Info = null;
  try { mint3Info = JSON.parse(mint3); } catch { mint3Info = null; }
  record("td8d the workspace re-mints a last tab after the Escape round",
    !!mint3Info && mint3Info.tab && mint3Info.tabs === 1, mint3.slice(0, 300));

  const confirmRound = await clickLastTabClose();
  let autoCloseInfo = confirmRound;
  if (confirmRound === "asked") {
    const confirmPt = await evalExpr(`(() => {
      const btn = document.getElementById("questionConfirm");
      if (!btn) return "no-confirm";
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return "zero-rect";
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (confirmPt && confirmPt !== "no-confirm" && confirmPt !== "zero-rect") {
      const point = JSON.parse(confirmPt);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
      await sleep(150);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      autoCloseInfo = await evalExpr(`(async () => {
        const started = Date.now();
        while (Date.now() - started < 8000) {
          const tabs = (state.tabs || []).filter((t) => t.workspace_id === "${wsId}");
          const wsGone = !(state.workspaces || []).some((x) => x.workspace_id === "${wsId}");
          if (tabs.length === 0 && wsGone) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        const list = await fetch("/api/workspaces").then((r) => r.json()).catch(() => null);
        const ids = list && list.result && Array.isArray(list.result.workspaces) ? list.result.workspaces.map((w) => w.workspace_id) : null;
        return JSON.stringify({ wsAlive: (state.workspaces || []).some((x) => x.workspace_id === "${wsId}"), tabsLen: (state.tabs || []).filter((t) => t.workspace_id === "${wsId}").length, serverIds: ids, selected: state.ws });
      })()`);
    } else {
      autoCloseInfo = JSON.stringify({ confirmButton: confirmPt });
    }
  }
  let autoClosed = null;
  try { autoClosed = JSON.parse(autoCloseInfo); } catch { autoClosed = null; }
  record("td8e confirming the auto-close question closes the workspace",
    !!autoClosed && !autoClosed.wsAlive && autoClosed.tabsLen === 0 &&
    Array.isArray(autoClosed.serverIds) && !autoClosed.serverIds.includes(wsId),
    String(autoCloseInfo).slice(0, 300));

  // td9: the selection falls back after the auto-close. td6 opened a second
  // workspace from REPO2 (zero tabs); it should now be the selected one.
  await sleep(1200);
  const selInfo = await evalExpr(`(() => {
    return JSON.stringify({ ws: state.ws, wsCount: (state.workspaces || []).length, fallbackIsOther: !!(state.ws && state.ws !== "${wsId}") });
  })()`);
  let sel = null;
  try { sel = JSON.parse(selInfo); } catch { sel = null; }
  record("td9 selection falls back to a surviving workspace after auto-close", !!sel && sel.fallbackIsOther && sel.wsCount >= 1, selInfo.slice(0, 300));

  // td10: after the auto-close, focus sits at body level on the pane
  // column with zero tabs on the selected workspace. A plain Enter must
  // mint a Shell tab through the global keydown handler, with no button
  // click involved: the post-last-tab-close flow in its purest form.
  await sleep(400);
  const enterInfo = await (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pre = await evalExpr(`(() => {
        const card = document.getElementById("workspaceEmptyLeaf");
        return JSON.stringify({
          ws: state.ws,
          tab: state.tab,
          leafShown: !!(card && !card.hidden && card.querySelector(".workspace-empty-leaf-card")),
          active: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "none",
        });
      })()`);
      let preInfo = null;
      try { preInfo = JSON.parse(pre); } catch { preInfo = null; }
      if (!preInfo || !preInfo.leafShown || !preInfo.ws || preInfo.tab) {
        await sleep(600);
        continue;
      }
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      const outcome = await evalExpr(`(async () => {
        const started = Date.now();
        while (Date.now() - started < 8000) {
          if (state.tab) return JSON.stringify({ ws: state.ws, tab: state.tab });
          await new Promise((r) => setTimeout(r, 300));
        }
        return JSON.stringify({ ws: state.ws, tab: state.tab, active: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "none" });
      })()`);
      return outcome;
    }
    return "no-leaf";
  })();
  let enterMint = null;
  try { enterMint = JSON.parse(enterInfo); } catch { enterMint = null; }
  record("td10 Enter on the zero-tab body mints a Shell tab", !!enterMint && !!enterMint.ws && !!enterMint.tab, enterInfo.slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((err) => {
  writeCrashReport(outPath, recorder, err);
  process.exit(1);
});