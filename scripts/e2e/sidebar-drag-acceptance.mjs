// Real-DOM acceptance for the preview-driven sidebar width drag. Unit
// tests pin the drag math; this driver runs the actually served bundle
// in headless Chrome and drives the toggle strip with REAL CDP input
// events (mouse press/move/release), so listeners, capture, click
// suppression, and the commit transition run the exact user path.
//
//   s1  mid-drag the grid is frozen and the ghost column is visible,
//       sized to the pending width, anchored to the viewport edge
//   s2  release commits the width (css var + localStorage) and rides
//       the sidebar-resizing class; the ghost fades out after
//   s3  an inward release below the stock minimum snaps to whichever
//       edge is closer to the pointer: far drags collapse (stored width
//       untouched), short drags hold the minimum
//   s4  an outward drag from a collapsed strip previews the reopen and
//       commits it on release
//   s5  a plain click on the strip still toggles after a drag (the
//       drag's trailing click is suppressed)
//
// Server + Chrome are started by run-sidebar-drag-e2e.sh.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9231";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8895/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/sidebar_drag_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-sidebar-drag-e2e.sh)");
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
  // pipeline, so thresholds, capture, and the trailing click behave as
  // they do for a user.
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
  const drag = async (fromX, fromY, toX, toY, hops = 3) => {
    await mouse("mousePressed", fromX, fromY);
    await mouse("mouseMoved", fromX + 2, fromY + 2);
    for (let i = 1; i <= hops; i++) {
      const t = i / hops;
      await mouse("mouseMoved", fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
    }
    await mouse("mouseReleased", toX, toY);
  };

  await evalExpr(`localStorage.setItem("herdr-web-layout", "desktop")`);
  await evalExpr(`localStorage.setItem("herdr-web-theme", "dark")`);
  await evalExpr(`localStorage.removeItem("herdr-web-sidebar-collapsed")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3000);
  // A workspace with a live pane so the desktop shell mounts.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "sidebar-drag", open_terminal: true})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  await sleep(1500);
  const paneInfo = await evalExpr(`fetch("/api/panes").then((r) => r.json()).then((d) => JSON.stringify(((d && d.result && d.result.panes) || []).map((p) => p.pane_id))).catch((e) => "err:" + e)`);
  let paneId = null;
  try { paneId = JSON.parse(paneInfo)[0] || null; } catch { paneId = null; }
  if (!paneId) throw new Error("open_terminal created no pane: " + paneInfo);
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${wsId}/tab/tab_1/pane/${paneId}` });
  await sleep(4000);

  const stripState = () => evalExpr(`(() => {
    const app = document.getElementById("app");
    const strip = document.getElementById("sidebarToggle");
    const ghost = document.getElementById("sidebarPreview");
    const r = strip.getBoundingClientRect();
    const g = ghost.getBoundingClientRect();
    const cs = getComputedStyle(ghost);
    return JSON.stringify({
      stripX: Math.round(r.x + r.width / 2), stripY: Math.round(r.y + r.height / 2),
      width: app.style.getPropertyValue("--sidebar-width"),
      ghostHidden: ghost.hidden,
      ghostClass: ghost.className,
      ghostW: Math.round(g.width), ghostLeft: Math.round(g.left),
      ghostBorderRight: cs.borderRightWidth !== "0px",
      ghostOpacity: cs.opacity,
      resizing: app.classList.contains("sidebar-resizing"),
      collapsed: app.classList.contains("sidebar-collapsed"),
      dragging: strip.classList.contains("dragging"),
      stored: (() => { try { return JSON.parse(localStorage.getItem("herdr-web-options")).sidebarWidth; } catch { return null; } })(),
    });
  })()`);

  // ---------- s1: mid-drag the grid is frozen, the ghost previews ----------
  let st = JSON.parse(await stripState());
  if (st.collapsed) {
    await evalExpr(`document.getElementById("sidebarToggle").click()`);
    await sleep(400);
    st = JSON.parse(await stripState());
  }
  const startX = st.stripX;
  const startY = st.stripY;
  const widthBefore = st.width;
  const targetX = startX + 260;

  await mouse("mousePressed", startX, startY);
  await mouse("mouseMoved", startX + 2, startY + 2);
  await mouse("mouseMoved", targetX, startY);
  let mid = JSON.parse(await stripState());
  record("s1 grid frozen mid-drag", mid.width === widthBefore, `width mid-drag ${mid.width}, expected ${widthBefore}`);
  record("s1 ghost visible mid-drag", mid.ghostHidden === false && mid.ghostW > 0, JSON.stringify(mid));
  record("s1 ghost sized to the pending width", Math.abs(mid.ghostW - (Number(widthBefore.replace("px", "")) + 260)) <= 2, `ghost ${mid.ghostW}`);
  record("s1 ghost anchored to the viewport edge", mid.ghostLeft === 0, `left ${mid.ghostLeft}`);
  record("s1 dragging class rides the strip", mid.dragging === true, JSON.stringify(mid));

  // ---------- s2: release commits and the ghost fades out ----------
  await mouse("mouseReleased", targetX, startY);
  await sleep(150);
  let rel = JSON.parse(await stripState());
  const expectedW = Number(widthBefore.replace("px", "")) + 260;
  record("s2 release commits the width", rel.width === `${expectedW}px`, `width ${rel.width}`);
  record("s2 commit persists to options", rel.stored === expectedW, `stored ${rel.stored}`);
  record("s2 commit rides the resize class", rel.resizing === true, JSON.stringify(rel));
  record("s2 ghost fades on release", rel.ghostClass.includes("fading") || rel.ghostHidden === true, `class ${rel.ghostClass}`);
  await sleep(400);
  let after = JSON.parse(await stripState());
  record("s2 resize class clears after the transition", after.resizing === false, JSON.stringify(after));
  record("s2 ghost hidden after the fade", after.ghostHidden === true, JSON.stringify(after));

  // The drag's trailing click must not have toggled the sidebar.
  record("s2 drag trailing click suppressed", rel.collapsed === false, JSON.stringify(rel));

  // ---------- s3: inward snaps to the closer edge ----------
  // Short inward drag: release lands below the stock minimum but closer
  // to it than to closed (590 - 280 = 310; 20px to the floor, 310 to
  // closed), so the commit floors at 330px.
  st = JSON.parse(await stripState());
  await drag(st.stripX, st.stripY, st.stripX - 280, st.stripY);
  await sleep(200);
  let held = JSON.parse(await stripState());
  record("s3 short inward release floors at the stock minimum", held.width === "330px", `width ${held.width}`);
  record("s3 short inward release never collapses", held.collapsed === false, JSON.stringify(held));

  // Far inward drag: closed is closer than the minimum, so the release
  // collapses and the stored width survives untouched.
  st = JSON.parse(await stripState());
  const storedBefore = st.stored;
  await mouse("mousePressed", st.stripX, st.stripY);
  await mouse("mouseMoved", st.stripX + 2, st.stripY + 2);
  await mouse("mouseMoved", st.stripX - 300, st.stripY);
  let snap = JSON.parse(await stripState());
  record("s3 far inward drag hides the ghost mid-drag", snap.ghostClass.includes("fading") || snap.ghostHidden === true, `class ${snap.ghostClass}`);
  record("s3 collapse lands on release, not mid-drag", snap.collapsed === false, JSON.stringify(snap));
  await mouse("mouseReleased", st.stripX - 300, st.stripY);
  await sleep(250);
  let closed = JSON.parse(await stripState());
  record("s3 far inward release snaps to collapsed", closed.collapsed === true, JSON.stringify(closed));
  record("s3 snap-close keeps the stored width untouched", closed.stored === storedBefore, `stored ${closed.stored}, before ${storedBefore}`);

  // ---------- s4: outward drag from the collapsed strip ----------
  st = JSON.parse(await stripState());
  const reopenX = 420;
  const expectedReopen = Math.max(330, Math.round(reopenX - st.stripX));
  await mouse("mousePressed", st.stripX, st.stripY);
  await mouse("mouseMoved", st.stripX + 2, st.stripY + 2);
  await mouse("mouseMoved", reopenX, st.stripY);
  let grow = JSON.parse(await stripState());
  record("s4 collapsed bar stays collapsed mid-drag", grow.collapsed === true, JSON.stringify(grow));
  record("s4 ghost previews the reopen mid-drag", grow.ghostHidden === false && grow.ghostW > 0, JSON.stringify(grow));
  await mouse("mouseReleased", reopenX, st.stripY);
  await sleep(250);
  let reopened = JSON.parse(await stripState());
  record("s4 release expands from the collapsed strip", reopened.collapsed === false, JSON.stringify(reopened));
  record("s4 reopen commits the dragged width", reopened.width === `${expectedReopen}px`, `width ${reopened.width}, expected ${expectedReopen}px`);

  // ---------- s5: a plain click still toggles ----------
  await evalExpr(`document.getElementById("sidebarToggle").click()`);
  await sleep(400);
  let toggled = JSON.parse(await stripState());
  record("s5 plain click toggles after a drag", toggled.collapsed === true, JSON.stringify(toggled));

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});