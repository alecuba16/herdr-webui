// Repro: expanding a folder in a large tree shifts the list under the user.
// Boots nothing itself: expects E2E_ORIGIN (server), CDP_PORT (chrome),
// E2E_REPO (fixture repo with many dirs). Mirrors keyboard-guards-audit-desktop.mjs
// boot: open workspace via /api/recent-workspaces, force desktop layout,
// click the Files rail, then measure.
//
// Scenarios measured (dir row expanded via caret click):
//   A. dir scrolled ABOVE the viewport top, few children below it
//   B. dir near the MIDDLE of the viewport
//   C. dir with MANY children (pushing rows far down)
// For each: scrollTop + clicked row's viewport Y before vs after expand.
import { writeFileSync } from "node:fs";
import { sleep } from "./cdp-driver-helpers.mjs";

const ORIGIN = process.env.E2E_ORIGIN;
const CDP_PORT = process.env.CDP_PORT;
const REPO = process.env.E2E_REPO;
const OUT = process.env.E2E_OUT || "expand-scroll-repro.json";

let ws;
let id = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`eval: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 300)}`);
  }
  return r.result.value;
}

async function waitFor(expr, label, timeout = 12000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

function record(results, name, pass, detail) {
  results.push({ name, pass, detail: String(detail).slice(0, 400) });
}

// ---- boot ---------------------------------------------------------------
const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onclose = () => { console.error("CDP websocket closed"); process.exit(3); };
ws.onerror = (e) => { console.error("CDP websocket error", e.type || ""); };
ws.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    return;
  }
  if (data.method === "Runtime.exceptionThrown") {
    const d = data.params.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    console.log("PAGE-EXC:", String(desc).slice(0, 400));
  }
  if (data.method === "Inspector.detached") {
    console.error("Inspector detached:", JSON.stringify(data.params).slice(0, 200));
  }
};
// Log every step so a hang leaves a trail.
const step = (msg) => console.log(`[step] ${msg}`);
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

step("workspace open");
const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
if (!open) throw new Error("workspace open failed");

step("navigate 1");
await send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2000);
step("set layout");
await evalJs(`localStorage.setItem('herdr-web-layout', 'desktop')`);
await send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2500);
step("wait boot");
await waitFor(`!!document.getElementById('settingsSearch') && !!document.querySelector('.tab')`, "desktop boot settled", 20000);

step("wait workspace");
// Create the workspace through the real API (same funnel the cwd-picker
// acceptance driver uses) and navigate to its routed URL: selection lives
// in the route, and a plain /session/default boot stays on the home default.
const made = await evalJs(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "expand-repro"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
const wsId = made && made.result ? (made.result.workspace && made.result.workspace.workspace_id) : null;
console.log("[workspace]", JSON.stringify(made).slice(0, 160));
if (!wsId) throw new Error("workspace create failed: " + JSON.stringify(made).slice(0, 300));
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "routed boot settled", 20000);
// Wait for the workspace list to load and the routed workspace to be the
// app's selection (drawer opens key off state.ws; opening before the list
// loads lands on the home default).
await waitFor(`(() => (typeof state !== 'undefined' && Array.isArray(state.workspaces) && state.workspaces.some((w) => w.workspace_id === ${JSON.stringify(wsId)})) )()`, "fixture workspace listed", 20000);
await waitFor(`(() => (typeof state !== 'undefined' && state.ws === ${JSON.stringify(wsId)}) )()`, "state.ws is fixture", 20000);
console.log("[route]", await evalJs(`location.pathname`));

step("click files rail");
// Await the real funnel with instrumentation: capture alerts (open() errors
// surface there), then dump what the browser actually opened on.
const openInfo = await evalJs(`(async () => {
  const w = (typeof state !== 'undefined' && state.workspaces) ? state.workspaces.find((x) => x.workspace_id === state.ws) : null;
  const info = {
    wsId: (typeof state !== 'undefined' && state.ws) || null,
    found: !!w,
    wsCwd: w ? (w.cwd || w.path || null) : null,
    resolvedPath: w && (typeof workspacePath === 'function') ? workspacePath(w) : null,
  };
  const captured = [];
  const oldAlert = window.alert;
  window.alert = (m) => { captured.push(String(m)); };
  try {
    await openWorkspaceFileBrowser(info.wsId, { forceOpen: true });
  } catch (e) { info.openErr = String(e && e.message || e); }
  window.alert = oldAlert;
  info.alerts = captured;
  await new Promise((r) => setTimeout(r, 1200));
  // forceOpen preserves the global collapse flag; boot restores collapsed
  // by default, so expand the column or the browser renders at 0x0 and
  // every scroll measurement reads zero.
  if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) {
    window.HerdrRightSidebar.setCollapsed(false);
    info.expandedColumn = true;
  }
  await new Promise((r) => setTimeout(r, 400));
  const side = document.querySelector('.file-browser-side');
  info.subtitle = (document.querySelector('.file-browser-subtitle') || {}).textContent || null;
  info.firstRow = side && side.querySelector('.herdr-tree-row') ? side.querySelector('.herdr-tree-row').title : null;
  info.rowCount = side ? side.querySelectorAll('.herdr-tree-row').length : 0;
  info.box = side ? { w: side.getBoundingClientRect().width, h: side.getBoundingClientRect().height, clientHeight: side.clientHeight } : null;
  return info;
})()`);
console.log("[open]", JSON.stringify(openInfo).slice(0, 500));
if (!openInfo.box || openInfo.box.h < 100) throw new Error("file browser column not visible after expand: " + JSON.stringify(openInfo).slice(0, 300));
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "file tree rendered", 20000);
await sleep(800);

step("tree ready");
const results = [];

// Trace any re-open of the browser after ours: the tree flipped from the
// fixture to a home listing between open and the scenarios, so log every
// HerdrFileBrowser.open call (workspace id/cwd) with a timestamp.
await evalJs(`(() => {
  window.__fbOpens = [];
  const orig = window.HerdrFileBrowser.open;
  window.HerdrFileBrowser.open = function (workspace, opts) {
    window.__fbOpens.push({
      at: Date.now(),
      ws: workspace && (workspace.workspace_id || workspace.cwd || String(workspace).slice(0, 80)),
      opts: opts && opts.forceOpen ? "force" : "plain",
    });
    return orig.apply(this, arguments);
  };
  return "wrapped";
})()`);

// How many root rows / whether the fixture tree is what we see.
const treeInfo = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  const dirs = [...side.querySelectorAll('.herdr-tree-row.dir')];
  return { rows: rows.length, dirs: dirs.length, first: rows[0] ? rows[0].title : null, cwd: (window.state && state.cwd) || null, opens: window.__fbOpens || [], subtitle: (document.querySelector('.file-browser-subtitle') || {}).textContent || null };
})()`);
record(results, "fixture tree visible (dir-1..dir-40)", treeInfo.dirs >= 30, JSON.stringify(treeInfo));

// helper: pick dir row by title, scroll to a target scrollTop, click caret,
// measure before/after. Returns box metrics in the error payload so a
// zero-size scroller is visible in the report.
async function expandAndMeasure(title, scrollTarget) {
  const before = await evalJs(`(() => {
    const side = document.querySelector('.file-browser-side');
    side.scrollTop = ${scrollTarget};
    const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
    const row = rows.find((r) => (r.title || '').includes(${JSON.stringify(title)}));
    const box = { scrollHeight: side.scrollHeight, clientHeight: side.clientHeight, side: side.getBoundingClientRect() };
    if (!row) return Object.assign({ error: 'row not found', have: rows.slice(0, 5).map((r) => r.title) }, box);
    const rect = row.getBoundingClientRect();
    return { title: row.title, rowTop: rect.top, scrollTop: side.scrollTop };
  })()`);
  await sleep(200);
  const clicked = await evalJs(`(() => {
    const side = document.querySelector('.file-browser-side');
    const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
    const row = rows.find((r) => (r.title || '').includes(${JSON.stringify(title)}));
    if (!row) return { error: 'row gone' };
    const rect = row.getBoundingClientRect();
    window.__expTitle = row.title;
    window.__expBeforeTop = rect.top;
    window.__expBeforeScroll = side.scrollTop;
    row.querySelector('.herdr-tree-caret').click();
    return { ok: true, beforeTop: rect.top, beforeScroll: side.scrollTop };
  })()`);
  await sleep(1000); // children fetch + render
  const after = await evalJs(`(() => {
    const side = document.querySelector('.file-browser-side');
    const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
    const row = rows.find((r) => r.title === window.__expTitle);
    if (!row) return { error: 'row gone after expand' };
    const rect = row.getBoundingClientRect();
    return {
      title: row.title,
      rowTop: rect.top,
      scrollTop: side.scrollTop,
      deltaRow: rect.top - window.__expBeforeTop,
      deltaScroll: side.scrollTop - window.__expBeforeScroll,
      scrollHeight: side.scrollHeight,
      rowVisible: rect.top >= side.getBoundingClientRect().top && rect.bottom <= side.getBoundingClientRect().bottom,
    };
  })()`);
  return { before, clicked, after };
}

// Scenario A: dir far ABOVE the viewport. Scroll so dir-35 is off-screen
// above, then expand it via keyboard-free caret click (simulating a user
// scrolled there earlier). Realistically the user clicks a VISIBLE row, but
// the jump complaint also covers the case where the expanded dir is above
// the viewport: measure the list displacement of the visible rows.
const scrollState = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  return { scrollHeight: side.scrollHeight, clientHeight: side.clientHeight };
})()`);

// Scroll to bottom third, then expand a dir that is visible mid-viewport
// with many siblings below it (dir near the end of the list).
step("scenario B");
const scenarioB = await expandAndMeasure("dir-3", 1200);
record(results,
  "B: visible dir (scrolled list) keeps its viewport Y on expand",
  scenarioB.after && !scenarioB.after.error && Math.abs(scenarioB.after.deltaRow) < 40,
  JSON.stringify(scenarioB));

// Collapse it to restore the tree, then scroll so dir-1 (top of list) sits
// above the viewport and expand dir-2 (also above) - the classic "expanded
// folder above the viewport" case. What the user SEES is the visible rows
// jump: measure a marker row's Y.
const collapsedB = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const row = rows.find((r) => r.title === window.__expTitle);
  if (row && row.querySelector('.herdr-tree-caret')) { row.querySelector('.herdr-tree-caret').click(); return true; }
  return false;
})()`);
await sleep(700);

// Scenario A: expand a dir that is ABOVE the viewport, few children.
// Marker = first row visible at current scroll (dir-25). After expanding
// dir-5 (above viewport, adds 20 rows below dir-5 => marker shifts DOWN in
// document => with pixel-anchored restore the visible content jumps UP).
step("scenario A");
const scenarioA = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  // expand dir-5 which is above the viewport when scrolled to 1000
  side.scrollTop = 1000;
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  if (!target) return { error: 'dir-5 not found' };
  // marker: a row currently visible
  const visible = rows.filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t > 0 && t < side.clientHeight;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  if (!marker) return { error: 'no visible dir row', rows: rows.length, scrollTop: side.scrollTop, opens: window.__fbOpens || [] };
  window.__markerTitle = marker.title;
  window.__markerTop = marker.getBoundingClientRect().top;
  target.querySelector('.herdr-tree-caret').click();
  return { target: target.title, marker: marker.title, markerTop: window.__markerTop, scrollTop: side.scrollTop };
})()`);
await sleep(1000);
const scenarioAResult = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  const marker = rows.find((r) => r.title === window.__markerTitle);
  if (!marker) return { error: 'marker gone' };
  const top = marker.getBoundingClientRect().top;
  return { marker: marker.title, markerTop: top, delta: top - window.__markerTop, scrollTop: side.scrollTop };
})()`);
record(results,
  "A: dir expanded above viewport keeps visible marker stable",
  scenarioAResult && !scenarioAResult.error && Math.abs(scenarioAResult.delta) < 40,
  JSON.stringify({ scenarioA, scenarioAResult }));

// Scenario C: many children. Expand dir-30 (20+1 children incl. nested).
// dir-30 sits below the current viewport: scroll it into view first.
step("scenario C");
const scenarioC = await expandAndMeasure("dir-30", 2600);
record(results,
  "C: dir with many children keeps its viewport Y on expand",
  scenarioC.after && !scenarioC.after.error && Math.abs(scenarioC.after.deltaRow) < 40,
  JSON.stringify(scenarioC));

writeFileSync(OUT, JSON.stringify({ results, scrollState, treeInfo }, null, 2));
console.log(JSON.stringify({ results }, null, 2));
const failed = results.filter((r) => !r.pass);
process.exit(failed.length ? 1 : 0);