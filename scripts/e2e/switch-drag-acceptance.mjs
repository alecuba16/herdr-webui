// Real-DOM acceptance for the draggable Chat|Terminal switch in BOTH
// layouts. Unit tests pin the drag math; this driver runs the actually
// served bundles in headless Chrome and drives the pill with REAL CDP
// input events (mouse press/move/release), so listeners, thresholds,
// click suppression, and persistence run the exact user path.
//
//   mobile
//   m1  switch mounts as a floating pill (absolute, over the shell)
//   m2  the switch row is gone: the terminal screen has ONE grid row
//       and the shell spans the full screen height
//   m3  a real drag moves the pill (threshold honored, transform cleared)
//   m4  the position persists in localStorage after remount
//   m5  a tap on Chat still opens the lens (drag did not eat the toggle)
//   m6  a drag followed by release does NOT toggle the view (click
//       suppression) and a plain tap still does
//
//   desktop
//   d1  switch mounts top-right over the shell, draggable affordance set
//   d2  a real drag moves the pill and persists options.lensSwitchPos
//   d3  reload restores the dragged position
//   d4  double-click resets to the anchored spot and clears the store
//   d5  a tap still toggles Chat/Terminal after a drag
//
// Server + Chrome are started by run-switch-drag-e2e.sh.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9230";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8894/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/switch_drag_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-switch-drag-e2e.sh)");
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

  // Real input events: the drag goes through the browser's own pointer
  // pipeline, not synthetic dispatchEvent, so thresholds, capture, and
  // the trailing click all behave as they do for a user.
  const mouse = async (type, x, y, extra = {}) => {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === "mouseMoved" ? "none" : (extra.button || "left"),
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: extra.clickCount || (type === "mousePressed" || type === "mouseReleased" ? 1 : 0),
      ...extra.params,
    });
    await sleep(60);
  };
  const drag = async (fromX, fromY, toX, toY) => {
    await mouse("mousePressed", fromX, fromY);
    // First hop stays under the threshold so the arm logic is exercised,
    // then a long jump crosses it and the release lands off the pill.
    await mouse("mouseMoved", fromX + 2, fromY + 2);
    await mouse("mouseMoved", toX, toY);
    await mouse("mouseReleased", toX, toY);
  };

  const waitForExpr = async (expr, want, label, timeoutMs = 25000) => {
    const r = await evalExpr(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const v = ${expr};
        if (v === ${JSON.stringify(want)}) { resolve(v); return; }
        if (Date.now() - started > ${timeoutMs}) resolve(v); else setTimeout(check, 400);
      };
      check();
    })`);
    record(label, r === want, `got ${r}`);
    return r;
  };

  // Workspace with a live pane; returns the deep-link pane URL and ids.
  const openWorkspace = async () => {
    const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "switch-drag", open_terminal: true})}).then((r) => r.json()).catch((e) => "err:" + e)`);
    const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
    if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
    await sleep(1500);
    const paneInfo = await evalExpr(`fetch("/api/panes").then((r) => r.json()).then((d) => JSON.stringify(((d && d.result && d.result.panes) || []).map((p) => p.pane_id))).catch((e) => "err:" + e)`);
    let paneId = null;
    try { paneId = JSON.parse(paneInfo)[0] || null; } catch { paneId = null; }
    if (!paneId) throw new Error("open_terminal created no pane: " + paneInfo);
    return { wsId, paneId };
  };

  // ---------- mobile ----------
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }
  await evalExpr(`localStorage.setItem("herdr-web-layout", "mobile")`);
  await evalExpr(`localStorage.setItem("herdr-web-theme", "dark")`);
  await evalExpr(`localStorage.removeItem("herdr-mobile-lens-switch")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3000);
  const { wsId: mWs, paneId: mPane } = await openWorkspace();
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${mWs}/tab/tab_1/pane/${mPane}` });
  await sleep(4000);

  const mobVisible = await waitForExpr(
    `(() => { const n = document.getElementById("mobileLensSwitch"); return n && !n.hidden ? "visible" : "hidden"; })()`,
    "visible",
    "m1 mobile switch mounts as a floating pill",
  );
  if (mobVisible !== "visible") throw new Error("mobile switch never appeared");

  const pillShape = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensSwitch");
    const cs = getComputedStyle(n);
    const screen = n.closest(".mobile-terminal-screen");
    const screenRect = screen ? screen.getBoundingClientRect() : null;
    return JSON.stringify({
      position: cs.position,
      transformSet: !!cs.transform && cs.transform !== "none",
      inScreen: !!screen,
      screenH: screenRect ? Math.round(screenRect.height) : 0,
      screenRows: screen ? getComputedStyle(screen).gridTemplateRows : "",
    });
  })()`);
  const shape = JSON.parse(pillShape);
  record("m1 switch is absolutely positioned over the screen",
    shape.position === "absolute" && shape.inScreen, pillShape);
  record("m2 terminal screen grid is one row",
    !String(shape.screenRows).trim().includes(" "), `rows "${shape.screenRows}"`);

  // Drag the pill: from its current spot to the lower-left of the screen.
  const before = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensSwitch");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: r.left, top: r.top });
  })()`);
  const b = JSON.parse(before);
  const targetX = Math.max(30, b.left - 120);
  const targetY = b.top + 400;
  await drag(b.x, b.y, targetX + 15, targetY + 10);
  const after = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensSwitch");
    const r = n.getBoundingClientRect();
    const saved = localStorage.getItem("herdr-mobile-lens-switch");
    const screen = n.closest(".mobile-terminal-screen");
    const sr = screen.getBoundingClientRect();
    return JSON.stringify({
      movedX: Math.round(r.left),
      movedY: Math.round(r.top),
      transform: getComputedStyle(n).transform,
      saved,
      inScreenX: r.left >= sr.left - 1 && r.right <= sr.right + 1,
      inScreenY: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
    });
  })()`);
  const a = JSON.parse(after);
  const moved = Math.abs(a.movedX - Math.round(b.left)) > 60 || Math.abs(a.movedY - Math.round(b.top)) > 60;
  record("m3 real drag moves the pill", moved, `from ${Math.round(b.left)},${Math.round(b.top)} to ${a.movedX},${a.movedY}`);
  record("m3 dragged pill stays inside the screen", a.inScreenX && a.inScreenY, after);
  record("m3 drag clears the centering transform", a.transform === "none", `transform ${a.transform}`);
  record("m4 drag persists to localStorage", !!a.saved && a.saved.includes('"x"'), `saved ${a.saved}`);

  // Remount: force a pane resync so syncLensSwitchRow re-inserts the
  // pill, then confirm the saved position lands back on the fresh node.
  await evalExpr(`HerdrMobile.showScreen("home")`);
  await sleep(300);
  await evalExpr(`HerdrMobile.showScreen("terminal")`);
  await sleep(600);
  const restored = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensSwitch");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), saved: localStorage.getItem("herdr-mobile-lens-switch") });
  })()`);
  const rr = JSON.parse(restored);
  const back = Math.abs(rr.x - a.movedX) <= 2 && Math.abs(rr.y - a.movedY) <= 2;
  record("m4 remount restores the dragged position", back, `remount ${rr.x},${rr.y} vs saved drag ${a.movedX},${a.movedY}`);

  // A drag whose release lands on the pill must NOT toggle the view;
  // a plain tap on the Chat button still opens the lens.
  const lensState = () => evalExpr(`(() => { const l = document.getElementById("mobileLens"); return l && !l.hidden ? "open" : "closed"; })()`);
  let lens = await lensState();
  // ensure closed
  if (lens === "open") {
    await evalExpr(`document.getElementById("mobileLensTerminalToggle").click()`);
    await sleep(400);
    lens = await lensState();
  }
  const pill = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensSwitch");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  const p = JSON.parse(pill);
  await drag(p.x, p.y, p.x + 80, p.y + 60);
  lens = await lensState();
  record("m6 drag does not toggle the view", lens === "closed", `lens ${lens} after drag`);
  // Plain tap on the Chat button opens the lens through the real path;
  // re-read the button center because the drag above moved the pill.
  const chatAfter = await evalExpr(`(() => {
    const n = document.getElementById("mobileLensChatToggle");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  const pa = JSON.parse(chatAfter);
  await mouse("mousePressed", pa.x, pa.y);
  await mouse("mouseReleased", pa.x, pa.y);
  await sleep(600);
  lens = await lensState();
  record("m5 tap on Chat opens the lens after a drag", lens === "open", `lens ${lens} after tap`);

  // ---------- desktop ----------
  await evalExpr(`localStorage.setItem("herdr-web-layout", "desktop")`);
  await evalExpr(`localStorage.removeItem("herdr-web-options")`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3000);
  const { wsId: dWs, paneId: dPane } = await openWorkspace();
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${dWs}/tab/tab_1/pane/${dPane}` });
  await sleep(4000);

  const dSwitch = await waitForExpr(
    `(() => { const n = document.getElementById("terminalLensSwitch"); return n && !n.hidden ? "visible" : "hidden"; })()`,
    "visible",
    "d1 desktop switch mounts over the shell",
  );
  if (dSwitch !== "visible") throw new Error("desktop switch never appeared");
  const dShape = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    const cs = getComputedStyle(n);
    return JSON.stringify({ position: cs.position, cursor: cs.cursor, touchAction: cs.touchAction, label: n.getAttribute("aria-label") });
  })()`);
  const ds = JSON.parse(dShape);
  record("d1 desktop pill is absolutely positioned with grab cursor",
    ds.position === "absolute" && ds.cursor.includes("grab"), dShape);
  record("d1 desktop label carries the drag affordance",
    ds.label === "Panel view, drag to move", `label "${ds.label}"`);

  const dBefore = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: r.left, top: r.top });
  })()`);
  const db = JSON.parse(dBefore);
  await drag(db.x, db.y, db.x - 200, db.y + 250);
  const dAfter = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    const r = n.getBoundingClientRect();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("herdr-web-options")).lensSwitchPos; } catch { saved = null; }
    const shell = document.getElementById("terminalShell");
    const sr = shell.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.left), y: Math.round(r.top),
      saved,
      inShell: r.left >= sr.left - 1 && r.right <= sr.right + 1 && r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
    });
  })()`);
  const da = JSON.parse(dAfter);
  record("d2 real drag moves the desktop pill",
    Math.abs(da.x - Math.round(db.left)) > 100, `from ${Math.round(db.left)},${Math.round(db.top)} to ${da.x},${da.y}`);
  record("d2 dragged pill stays inside the shell", da.inShell, dAfter);
  record("d2 drag persists options.lensSwitchPos",
    !!da.saved && Number.isFinite(da.saved.x) && Number.isFinite(da.saved.y),
    `saved ${JSON.stringify(da.saved)}`);

  // Reload: the stored position must survive a cold mount.
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${dWs}/tab/tab_1/pane/${dPane}` });
  await sleep(4000);
  const dReload = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    if (!n) return JSON.stringify({ missing: true });
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) });
  })()`);
  const dr = JSON.parse(dReload);
  record("d3 reload restores the dragged position",
    !dr.missing && Math.abs(dr.x - da.x) <= 2 && Math.abs(dr.y - da.y) <= 2,
    `reloaded ${dr.x},${dr.y} vs dragged ${da.x},${da.y}`);

  // Double-click resets to the anchored top-right spot and nulls the store.
  const dCenter = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  const dc = JSON.parse(dCenter);
  await mouse("mousePressed", dc.x, dc.y, { clickCount: 1 });
  await mouse("mouseReleased", dc.x, dc.y, { clickCount: 1 });
  await mouse("mousePressed", dc.x, dc.y, { clickCount: 2 });
  await mouse("mouseReleased", dc.x, dc.y, { clickCount: 2 });
  await sleep(400);
  const dReset = await evalExpr(`(() => {
    const n = document.getElementById("terminalLensSwitch");
    const r = n.getBoundingClientRect();
    const sr = document.getElementById("terminalShell").getBoundingClientRect();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("herdr-web-options")).lensSwitchPos; } catch { saved = undefined; }
    return JSON.stringify({
      x: Math.round(r.left), y: Math.round(r.top),
      // The anchor is top:10px;right:12px off the shell: compare the
      // clearances, not raw edges (the pill can overflow the shell's
      // left edge by design only after a drag).
      anchored: Math.abs(sr.right - r.right - 12) <= 2 && Math.abs(r.top - sr.top - 10) <= 2,
      saved,
    });
  })()`);
  const dz = JSON.parse(dReset);
  record("d4 dblclick resets to the anchored top-right spot", dz.anchored, dReset);
  record("d4 dblclick nulls the stored position", dz.saved === null, `saved ${JSON.stringify(dz.saved)}`);

  // A tap still toggles: Chat button click flips the lens open.
  const dLens = async () => evalExpr(`(() => { const l = document.getElementById("terminalLens"); return l && !l.hidden ? "open" : "closed"; })()`);
  let dl = await dLens();
  if (dl === "open") {
    await evalExpr(`document.getElementById("lensToggleTerminal").click()`);
    await sleep(500);
    dl = await dLens();
  }
  // A real tap (mouse press+release) on the Chat button: the click
  // suppressor must stay out of the way once the drag is over.
  const chatBtn = await evalExpr(`(() => {
    const n = document.getElementById("lensToggleChat");
    const r = n.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  const cb = JSON.parse(chatBtn);
  await mouse("mousePressed", cb.x, cb.y);
  await mouse("mouseReleased", cb.x, cb.y);
  await sleep(700);
  dl = await dLens();
  record("d5 tap on Chat opens the desktop lens after a drag and reset", dl === "open", `lens ${dl}`);

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});
