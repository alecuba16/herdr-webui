// Real-DOM acceptance for the mobile client side of the terminal-decoupling
// feature (update_windows batch). Same runner as the desktop driver (run-
// terminal-decouple-e2e.sh boots the isolated server + chrome-headless);
// this one forces the MOBILE layout and drives the real mobile bundle with
// real clicks only:
//
//   tm1  the Worktrees screen's recents Open button posts open_terminal
//        from the real option store (default off)
//   tm2  the mobile lands on the zero-tab workspace terminal screen
//        (No terminal selected, workspace stays selected)
//   tm3  the settings Workspaces section renders the Open terminal with
//        workspace checkbox, unchecked by default
//   tm4  New panel in the Panels sheet mints a live panel
//   tm5  Close current panel (custom confirm sheet, real Confirm click)
//        keeps the workspace on screen, back to the no-terminal state
//   tm6  no desktop empty-leaf DOM leaks into the mobile layout
//
// The mobile layout switch lives in app_boot.js: layout preference
// "mobile" in localStorage under "herdr-web-layout". Mobile state is
// module-scoped (no HerdrMobile.state export), so observations read the
// DOM and the server API instead of internal state.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8898/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/terminal_decouple_mobile_result.json`;

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

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  // Real trusted click at the element center.
  const clickEl = async (expr) => {
    const pt = await evalExpr(expr);
    if (!pt) return "no-point";
    const point = typeof pt === "string" ? JSON.parse(pt) : pt;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    return "clicked";
  };
  const rectExpr = (selector) => `(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`;

  // Phone viewport so auto-layout would pick mobile even without the
  // explicit preference; the preference alone is the deterministic part.
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }

  await evalExpr(`localStorage.setItem("herdr-web-layout", "mobile")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(4000);

  const layout = await evalExpr(`document.documentElement.dataset.herdrLayout || "none"`);
  record("mobile layout resolved", layout === "mobile", `got ${layout}`);
  if (layout !== "mobile") throw new Error("mobile layout did not resolve: " + layout);

  const booted = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (window.HerdrMobile && window.HerdrMobile.openRecentWorkspace) { resolve("ready"); return; }
      if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("mobile bundle booted with HerdrMobile exports", booted === "ready", `got ${booted}`);
  if (booted !== "ready") throw new Error("mobile bundle never exposed HerdrMobile.openRecentWorkspace");

  // Fixture: only record the repo in recents. The workspace itself must
  // NOT exist yet, or the recents Open button renders disabled (already
  // open) and the real click cannot create it.
  const rec = await evalExpr(`fetch("/api/recent-workspaces/record", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({path: ${JSON.stringify(REPO)}, label: "td-mobile"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  record("fixture repo recorded in recents (no workspace yet)", !String(rec).startsWith("err"), String(rec).slice(0, 120));

  // Open the More drawer, then the Worktrees drawer item (real clicks).
  let clicked = await clickEl(rectExpr(`document.querySelector('.mobile-nav button[data-screen="more"]')`));
  await sleep(600);
  clicked = await clickEl(rectExpr(`Array.from(document.querySelectorAll('.mobile-drawer-item')).find((b) => /worktrees/i.test(b.textContent || ""))`));
  record("worktrees screen opened via More drawer", clicked === "clicked", `got ${clicked}`);
  await sleep(800);

  // Expand the Recent workspaces disclosure.
  const expanded = await evalExpr(`(() => {
    const details = Array.from(document.querySelectorAll("details.mobile-disclosure")).find((d) => /recent/i.test(d.textContent || ""));
    if (!details) return "no-details";
    details.open = true;
    details.dispatchEvent(new Event("change"));
    return "expanded";
  })()`);
  await sleep(800);
  record("recent workspaces disclosure expanded", expanded === "expanded", `got ${expanded}`);

  // tm1: click the recents Open button and observe the POST body. The real
  // click CREATES the workspace (recents open falls back to workspace
  // create for paths with no live workspace), so this both exercises the
  // click path and asserts the open_terminal flag in the real body.
  const openResult = await evalExpr(`(async () => {
    const seen = [];
    let wsId = null;
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = String(input && input.url ? input.url : input);
      const p = origFetch.apply(this, arguments);
      if (url.includes("/api/recent-workspaces") && init && init.method === "POST" && !url.includes("record") && !url.includes("remove") && !url.includes("clear")) {
        seen.push(init.body || "");
        p.then((r) => r.clone().json()).then((d) => { if (d && d.result && d.result.workspace) wsId = d.result.workspace.workspace_id; }).catch(() => {});
      }
      if (url.includes("/api/workspaces") && init && init.method === "POST") {
        seen.push(init.body || "");
        p.then((r) => r.clone().json()).then((d) => { if (d && d.result && d.result.workspace) wsId = d.result.workspace.workspace_id; }).catch(() => {});
      }
      return p;
    };
    try {
      const row = Array.from(document.querySelectorAll(".mobile-worktree-row")).find((r) => /td-mobile/i.test(r.textContent || ""));
      if (!row) return "no-row";
      const btn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Open");
      if (!btn) return "no-open";
      if (btn.disabled) return "open-disabled";
      btn.click();
      for (let i = 0; i < 25 && !wsId; i++) await new Promise((r) => setTimeout(r, 200));
    } finally {
      window.fetch = origFetch;
    }
    return JSON.stringify({ bodies: seen, wsId });
  })()`);
  let openInfo = null;
  try { openInfo = JSON.parse(openResult); } catch { openInfo = null; }
  const wsId = openInfo && openInfo.wsId;
  const flagOff = !!openInfo && (openInfo.bodies || []).length >= 1 && openInfo.bodies.every((b) => String(b).includes('"open_terminal":false'));
  record("tm1 recents Open posts open_terminal:false (default off)", flagOff, openResult.slice(0, 300));
  record("tm1b the real click created the workspace", !!wsId, `ws=${wsId}`);
  if (!wsId) throw new Error("recents Open did not create a workspace: " + openResult.slice(0, 300));

  // tm2: the app lands on the terminal screen of the zero-tab workspace.
  await sleep(1200);
  const landed = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const body = document.body.textContent || "";
      if (/No terminal selected/i.test(body)) {
        return JSON.stringify({ noTerm: true, ws: (window.location.pathname.match(/workspace\\/([^/]+)/) || [])[1] || "" });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return JSON.stringify({ noTerm: false, ws: (window.location.pathname.match(/workspace\\/([^/]+)/) || [])[1] || "" });
  })()`);
  let landedInfo = null;
  try { landedInfo = JSON.parse(landed); } catch { landedInfo = null; }
  record("tm2 lands on zero-tab workspace, No terminal selected", !!landedInfo && landedInfo.noTerm && landedInfo.ws === wsId, landed.slice(0, 300));

  // tm3: settings Workspaces section checkbox exists, unchecked.
  await clickEl(rectExpr(`document.querySelector('.mobile-nav button[data-screen="more"]')`));
  await sleep(500);
  await clickEl(rectExpr(`Array.from(document.querySelectorAll('.mobile-drawer-item')).find((b) => /settings/i.test(b.textContent || ""))`));
  await sleep(900);
  const settingsInfo = await evalExpr(`(() => {
    const label = document.querySelector('[data-settings-id="workspaceOpenTerminal"]');
    if (!label) return "no-label";
    const box = label.querySelector("input[type=checkbox]");
    if (!box) return "no-box";
    return JSON.stringify({ checked: box.checked });
  })()`);
  let settingsBox = null;
  try { settingsBox = JSON.parse(settingsInfo); } catch { settingsBox = null; }
  record("tm3 settings Open terminal checkbox exists, default off", !!settingsBox && settingsBox.checked === false, settingsInfo.slice(0, 300));

  // Back to terminal, mint a panel through the real Panels sheet.
  await clickEl(rectExpr(`document.querySelector('.mobile-nav button[data-screen="terminal"]')`));
  await sleep(600);
  await clickEl(rectExpr(`document.getElementById("mobilePanelsChip")`));
  await sleep(600);
  const mint = await evalExpr(`(async () => {
    const sheet = document.getElementById("mobileTabsSheet");
    if (!sheet || sheet.hidden) return "no-sheet";
    const btn = Array.from(sheet.querySelectorAll("button")).find((b) => /new panel/i.test(b.textContent || ""));
    if (!btn) return "no-new";
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const chip = (document.getElementById("mobilePanelsChip") || {}).textContent || "";
    return JSON.stringify({ chip: chip.trim() });
  })()`);
  let mintInfo = null;
  try { mintInfo = JSON.parse(mint); } catch { mintInfo = null; }
  record("tm4 New panel mints a live panel (chip counts 1+)", !!mintInfo && /1 panes?/.test(mintInfo.chip || ""), mint.slice(0, 300));

  // tm5: close the last panel via the sheet + real Confirm click, then
  // poll for the no-terminal state (the refresh after close is async).
  // Chain is observable step by step: sheet open, confirm sheet open with
  // the real close message, Confirm click fires the close POST, then the
  // DOM falls back to No terminal selected. Any silent step shows up as a
  // failing check instead of a mystery at the end.
  await clickEl(rectExpr(`document.getElementById("mobilePanelsChip")`));
  await sleep(600);
  const sheetOpen = await evalExpr(`(() => {
    const sheet = document.getElementById("mobileTabsSheet");
    return sheet && !sheet.hidden ? "open" : "closed";
  })()`);
  record("tm5 panels sheet open after chip click", sheetOpen === "open", `got ${sheetOpen}`);
  const closeAsked = await evalExpr(`(() => {
    const sheet = document.getElementById("mobileTabsSheet");
    if (!sheet || sheet.hidden) return "no-sheet";
    const btn = Array.from(sheet.querySelectorAll("button")).find((b) => /close current panel/i.test(b.textContent || ""));
    if (!btn) return "no-close";
    btn.click();
    return "asked";
  })()`);
  record("tm5 Close current panel button found and clicked", closeAsked === "asked", `got ${closeAsked}`);
  await sleep(600);
  const confirmInfo = await evalExpr(`(() => {
    const confirmSheet = document.getElementById("mobileConfirmSheet");
    if (!confirmSheet) return "no-confirm-sheet";
    const ok = document.getElementById("mobileConfirmOk");
    if (!ok) return "no-ok";
    if (confirmSheet.hidden) return "confirm-hidden";
    return JSON.stringify({ msg: document.getElementById("mobileConfirmMessage").textContent });
  })()`);
  let confirmMsg = null;
  try { confirmMsg = JSON.parse(confirmInfo).msg; } catch { confirmMsg = null; }
  record("tm5 confirm sheet shows the close message", !!confirmMsg && /Close panel "Shell"\?/.test(confirmMsg), String(confirmInfo).slice(0, 200));
  const confirmed = await evalExpr(`(() => {
    const confirmSheet = document.getElementById("mobileConfirmSheet");
    if (!confirmSheet || confirmSheet.hidden) return "not-open";
    const ok = document.getElementById("mobileConfirmOk");
    if (!ok) return "no-ok";
    ok.click();
    return "confirmed";
  })()`);
  record("tm5 Confirm clicked while sheet open", confirmed === "confirmed", `got ${confirmed}`);
  const closed = await evalExpr(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      if (/No terminal selected/i.test(document.body.textContent || "")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const noTerm = /No terminal selected/i.test(document.body.textContent || "");
    const chip = (document.getElementById("mobilePanelsChip") || {}).textContent || "";
    const ws = (window.location.pathname.match(/workspace\\/([^/]+)/) || [])[1] || "";
    return JSON.stringify({ noTerm, chip: chip.trim(), wsStillSelected: !!ws });
  })()`);
  let closeInfo = null;
  try { closeInfo = JSON.parse(closed); } catch { closeInfo = null; }
  record("tm5 close last panel returns to No terminal selected", !!closeInfo && closeInfo.noTerm, closed.slice(0, 300));

  // tm5b: server-side truth for the workspace created by the real click.
  // The tabs probe also proves the close hit the right tab (not a stale id).
  const serverState = await evalExpr(`fetch("/api/workspaces").then((r) => r.json()).then((d) => {
    const w = ((d && d.result && d.result.workspaces) || []).find((x) => x.workspace_id === ${JSON.stringify(wsId)});
    return JSON.stringify({ alive: !!w });
  }).catch((e) => "err:" + e)`);
  let serverInfo = null;
  try { serverInfo = JSON.parse(serverState); } catch { serverInfo = null; }
  const tabsProbe = await evalExpr(`fetch("/api/tabs").then((r) => r.json()).then((d) => JSON.stringify(((d && d.result && d.result.tabs) || []).filter((t) => t.workspace_id === ${JSON.stringify(wsId)}))).catch((e) => "err:" + e)`);
  let tabsAfterClose = null;
  try { tabsAfterClose = JSON.parse(tabsProbe); } catch { tabsAfterClose = null; }
  const zeroTabs = Array.isArray(tabsAfterClose) && tabsAfterClose.length === 0;
  record("tm5b server confirms workspace alive with zero tabs", !!serverInfo && serverInfo.alive && zeroTabs, `alive=${serverInfo && serverInfo.alive} tabs=${JSON.stringify(tabsAfterClose)}`);

  // tm6: desktop empty-leaf DOM stays out of the mobile layout.
  const domCheck = await evalExpr(`(() => JSON.stringify({
    emptyLeaf: !!document.getElementById("workspaceEmptyLeaf"),
    desktopPanes: !!document.getElementById("workspacePanes"),
  }))()`);
  let domInfo = null;
  try { domInfo = JSON.parse(domCheck); } catch { domInfo = null; }
  record("tm6 desktop empty-leaf DOM stays out of mobile", !!domInfo && !domInfo.emptyLeaf && !domInfo.desktopPanes, String(domCheck).slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((err) => {
  writeCrashReport(outPath, recorder, err);
  process.exit(1);
});