// Focused experiment: exact scroll behavior when expanding a folder above
// the viewport in a large tree. Boots nothing itself: E2E_ORIGIN,
// CDP_PORT, E2E_REPO. Hooks renderPreservingScroll's scroll save/restore
// by listening to scroll events + sampling after each micro-step, and
// measures:
//   - scrollTop before caret click
//   - scrollTop after render 1 (loading)
//   - scrollTop after render 2 (children inserted)
//   - marker row (visible mid-viewport) viewport-Y delta across the whole
//     expand
//   - document offset of marker before/after
// Runs two expand passes: uncached (first expand, async fetch) and cached
// (collapse then expand again, single render).
import { writeFileSync } from "node:fs";
import { sleep } from "./cdp-driver-helpers.mjs";

const ORIGIN = process.env.E2E_ORIGIN;
const CDP_PORT = process.env.CDP_PORT;
const REPO = process.env.E2E_REPO;
const OUT = process.env.E2E_OUT || "expand-jump-experiment.json";

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

async function waitFor(expr, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onclose = () => { console.error("CDP websocket closed"); process.exit(3); };
ws.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
  }
};
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Open the workspace through the same funnel the repro driver uses (node
// fetch, before any page-context calls), then navigate to the routed URL.
const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed: " + JSON.stringify(open).slice(0, 300));
await send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2500);
await evalJs(`localStorage.setItem('herdr-web-layout', 'desktop')`);
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled", 20000);
await waitFor(`(() => (typeof state !== 'undefined' && state.ws === ${JSON.stringify(wsId)}) )()`, "state.ws set", 20000);

// Open the browser, expand the sidebar column (boot restores collapsed).
await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered", 20000);
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

// Instrument: hook the panel (stable across renders) with a subtree
// observer, re-resolving `.file-browser-side` on every event, plus a
// document-level scroll capture. The marker title is set by the setup
// step below (window.__markerTitle), so install this AFTER setup.
const SCROLL = Number(process.env.E2E_SCROLL || 3000);
const setup = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  if (!target) return { error: 'dir-5 missing', titles: rows.slice(0, 6).map((r) => r.title) };
  // 200 dirs sort lexicographically: dir-5 lands at row ~146 (doc ~5490).
  // E2E_SCROLL=3000 -> dir-5 below the viewport (virtualization-only test);
  // E2E_SCROLL=6500 -> dir-5 above the viewport, marker below the insertion
  // (canonical pixel-anchor failure test).
  side.scrollTop = ${JSON.stringify(SCROLL)};
  const visible = rows.filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= side.getBoundingClientRect().top && t <= side.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  const targetDoc = target.getBoundingClientRect().top + side.scrollTop - side.getBoundingClientRect().top;
  const markerDoc = marker.getBoundingClientRect().top + side.scrollTop - side.getBoundingClientRect().top;
  window.__markerTitle = marker.title;
  return {
    target: target.title,
    marker: marker.title,
    scrollTop: side.scrollTop,
    clientHeight: side.clientHeight,
    targetAboveViewport: target.getBoundingClientRect().bottom < side.getBoundingClientRect().top,
    targetDoc,
    markerDoc,
    markerViewportY: marker.getBoundingClientRect().top,
  };
})()`);
console.log("[setup]", JSON.stringify(setup));
if (setup.error) throw new Error(JSON.stringify(setup));

await evalJs(`(() => {
  window.__scrollLog = [];
  const sample = (type) => {
    const side = document.querySelector('.file-browser-side');
    if (!side) return;
    const m = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__markerTitle);
    const first = side.querySelector('.herdr-tree-row');
    const tree = side.querySelector('.herdr-file-tree');
    window.__scrollLog.push({
      at: performance.now(),
      type,
      scrollTop: side.scrollTop,
      scrollHeight: side.scrollHeight,
      rows: side.querySelectorAll('.herdr-tree-row').length,
      markerY: m ? m.getBoundingClientRect().top : null,
      firstRowH: first ? first.getBoundingClientRect().height : null,
      markerRowH: m ? m.getBoundingClientRect().height : null,
      treeH: tree ? tree.getBoundingClientRect().height : null,
      fontsLoaded: document.fonts ? document.fonts.status : null,
      bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 60),
    });
  };
  document.addEventListener('scroll', (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains('file-browser-side')) sample('scroll');
  }, true);
  const panel = document.getElementById('fileBrowserPanel');
  const mo = new MutationObserver(() => sample('render'));
  mo.observe(panel, { childList: true, subtree: true });
  return 'instrumented';
})()`);
await sleep(300);

// Expand dir-5 (uncached path: loading render + children render).
const pass1 = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  const before = { scrollTop: side.scrollTop, scrollHeight: side.scrollHeight };
  window.__scrollLog = [];
  const markerRow = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === ${JSON.stringify(setup.marker)});
  window.__markerViewportYBefore = markerRow.getBoundingClientRect().top;
  target.querySelector('.herdr-tree-caret').click();
  return before;
})()`);
await sleep(1200);
const pass1after = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const markerRow = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === ${JSON.stringify(setup.marker)});
  const first = side.querySelector('.herdr-tree-row');
  const dirRow = side.querySelector('.herdr-tree-row.dir:not(.current)');
  const tree = side.querySelector('.herdr-file-tree');
  return {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    firstRowH: first ? first.getBoundingClientRect().height : null,
    dirRowH: dirRow ? dirRow.getBoundingClientRect().height : null,
    markerRowH: markerRow ? markerRow.getBoundingClientRect().height : null,
    treeH: tree ? tree.getBoundingClientRect().height : null,
    markerViewportY: markerRow.getBoundingClientRect().top,
    markerViewportDelta: markerRow.getBoundingClientRect().top - window.__markerViewportYBefore,
    log: window.__scrollLog,
  };
})()`);
console.log("[pass1 uncached]", JSON.stringify(pass1).slice(0, 200));
console.log("[pass1 after]", JSON.stringify({ ...pass1after, log: pass1after.log.slice(-8) }).slice(0, 900));

// Collapse dir-5, re-scroll to the same spot, expand again (cached: single render).
await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  target.querySelector('.herdr-tree-caret').click();
  return true;
})()`);
await sleep(700);
const pass2 = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  side.scrollTop = ${JSON.stringify(setup.scrollTop)};
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  const markerRow = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === ${JSON.stringify(setup.marker)});
  window.__scrollLog = [];
  window.__markerViewportYBefore = markerRow.getBoundingClientRect().top;
  const before = { scrollTop: side.scrollTop, markerDocBefore: markerRow.getBoundingClientRect().top };
  target.querySelector('.herdr-tree-caret').click();
  return before;
})()`);
await sleep(900);
const pass2after = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const markerRow = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === ${JSON.stringify(setup.marker)});
  return {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    markerViewportY: markerRow.getBoundingClientRect().top,
    markerViewportDelta: markerRow.getBoundingClientRect().top - window.__markerViewportYBefore,
    log: window.__scrollLog,
  };
})()`);
console.log("[pass2 cached]", JSON.stringify(pass2).slice(0, 200));
console.log("[pass2 after]", JSON.stringify({ ...pass2after, log: pass2after.log.slice(-8) }).slice(0, 900));

// Compare a tall settled row vs the marker row: markup + computed geometry.
const rowCompare = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir:not(.current)')];
  const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
  const dist = {};
  heights.forEach((h) => { dist[h] = (dist[h] || 0) + 1; });
  const tall = rows.find((r) => Math.round(r.getBoundingClientRect().height) === Math.max(...heights));
  const short = rows.find((r) => Math.round(r.getBoundingClientRect().height) === Math.min(...heights));
  const geo = (el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { h: Math.round(rect.height), outer: el.outerHTML.slice(0, 400), padding: cs.padding, margin: cs.margin, lineHeight: cs.lineHeight, fontSize: cs.fontSize, display: cs.display, minH: cs.minHeight, classes: el.className };
  };
  const tallIdx = [];
  const shortIdx = [];
  rows.forEach((r, i) => { const h = Math.round(r.getBoundingClientRect().height); (h === Math.max(...heights) ? tallIdx : shortIdx).push(i); });
  return { dist, tallIdx: tallIdx.slice(0, 30), shortIdx: shortIdx.slice(0, 30), tallTitles: tallIdx.slice(0, 30).map((i) => rows[i].title), shortTitles: shortIdx.slice(0, 30).map((i) => rows[i].title), tall: tall ? geo(tall) : null, short: short ? geo(short) : null, total: rows.length };
})()`);
console.log("[rowCompare]", JSON.stringify(rowCompare).slice(0, 1600));

writeFileSync(OUT, JSON.stringify({ setup, pass1, pass1after, pass2, pass2after, rowCompare }, null, 2));

// Findings: the marker's viewport Y delta is the user-visible jump.
const jump1 = Math.abs(pass1after.markerViewportDelta || 0);
const jump2 = Math.abs(pass2after.markerViewportDelta || 0);
console.log(JSON.stringify({ jumpUncachedPx: jump1, jumpCachedPx: jump2, verdict: (jump1 > 40 || jump2 > 40) ? "JUMP OBSERVED" : "stable" }, null, 2));
process.exit(0);