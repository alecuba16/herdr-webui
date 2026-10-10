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
//
// window.confirm is auto-accepted for the tab close (Page.setBypassCSP is
// not needed; the app overrides confirm with confirmCloseTab semantics
// wired through Page.javascriptDialogOpening auto-accept).
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

  // td1: workspace.create with open_terminal:false must answer zero tabs.
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
          text: (card.textContent || "").slice(0, 200),
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "no-leaf";
  })()`);
  let leaf = null;
  try { leaf = JSON.parse(leafInfo); } catch { /* handled below */ }
  record("td2 empty-leaf body renders for the zero-tab workspace", !!leaf && leaf.visible && leaf.hasButton, leafInfo.slice(0, 300));

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
      if (!pt || pt === "no-strip" || pt === "no-close" || pt === "zero-rect") return pt || "no-point";
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

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((err) => {
  writeCrashReport(outPath, recorder, err);
  process.exit(1);
});