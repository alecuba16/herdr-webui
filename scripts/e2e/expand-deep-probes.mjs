// Deep-validation probes for the expand-jump findings (V5b, V6, V7, V9).
//
// V5b: prove listeners bound to .file-browser-side die on the first innerHTML
//      render (the aside is recreated) while the panel-level observer survives.
// V6:  controlled 6500 first-expand with a SETTLED baseline (wait out the
//      realization drift before clicking) to separate the second-wipe
//      contribution from the unstable-baseline confound.
// V7:  timer-frame sampling (16ms) of the post-restore slide (3000 cached
//      pass) to observe the reconvergence the doc claims (1082 -> 542 class
//      motion). rAF is avoided: headless shell can idle-skip animation frames.
// V9:  event-loop yield check: whether the cached-pass wipe+restore happens
//      with no intervening task (scrollTop restore synchronous with wipe).
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO (same contract as expand-jump-experiment.mjs).

import { readFileSync } from "node:fs";

const ORIGIN = process.env.E2E_ORIGIN || "https://127.0.0.1:8901";
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const REPO = process.env.E2E_REPO;

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onclose = () => { console.error("CDP websocket closed"); process.exit(3); };
const pending = new Map();
let nextId = 1;
ws.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
async function waitFor(expr, label, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
// Kept from the rAF experiments: a screencast request forces frame production
// in some headless builds. Harmless with timer sampling; rAF itself proved
// unreliable here (idle-skipped), which is why V7 samples on a 16ms timer.
try { await send("Page.startScreencast", { format: "jpeg", quality: 40, everyNthFrame: 1 }); } catch {}

const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed: " + JSON.stringify(open).slice(0, 300));
await send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2500);
// Wait for a same-origin document before touching localStorage (about:blank
// start page denies storage access).
for (let i = 0; i < 50; i++) {
  const url = await evalJs("location.href").catch(() => "");
  if (String(url).includes("127.0.0.1")) break;
  await sleep(200);
}
await evalJs(`try { localStorage.setItem('herdr-web-layout', 'desktop') } catch (e) { /* about:blank */ }`);
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled");
await waitFor(`(() => (typeof state !== 'undefined' && state.ws === ${JSON.stringify(wsId)}) )()`, "state.ws set");

await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

// ---------- V5b: listener death on first render ----------
await evalJs(`(() => { const side = document.querySelector('.file-browser-side'); side.scrollTop = 1200; return side.scrollTop; })()`);
await sleep(1200);

const deathSetup = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const panel = document.getElementById('fileBrowserPanel');
  window.__oldSide = side;
  window.__deadProbe = { scrollerFires: 0, panelFires: 0 };
  const onScroll = () => window.__deadProbe.scrollerFires++;
  side.addEventListener('scroll', onScroll);
  // capture-phase panel listener: survives because panel element persists.
  panel.addEventListener('scroll', (ev) => { window.__deadProbe.panelFires++; }, true);
  window.__deadOnScroll = onScroll;
  // Trigger a re-render without expanding: navigate up or use refresh; the
  // cheapest full render is a state refresh via HerdrFileBrowser.refresh().
  window.HerdrFileBrowser.refresh();
  return { oldSideIsConnected: side.isConnected };
})()`);
await sleep(1500);
const deathAfter = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  // Force scroll events on the NEW scroller.
  side.scrollTop = 1250; side.scrollTop = 1200;
  return {
    sameElement: side === window.__oldSide,
    oldSideConnected: window.__oldSide.isConnected,
    panelStillConnected: !!document.getElementById('fileBrowserPanel'),
    probe: window.__deadProbe,
  };
})()`);
await sleep(400);
const deathFinal = await evalJs(`(() => ({ probe: window.__deadProbe, sameElement: document.querySelector('.file-browser-side') === window.__oldSide }))()`);
console.log("[V5b listener-death]", JSON.stringify({ deathSetup, deathAfter, deathFinal }));

// ---------- V7: timer-sampled slide, 3000 cached pass ----------
// Get to a cached-expand state: expand dir-5 once (fetch), collapse, then
// instrument a 16ms sampling timer and re-expand from cache.
await evalJs(`(() => { const side = document.querySelector('.file-browser-side'); side.scrollTop = 3000; return side.scrollTop; })()`);
await sleep(1500);
await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  target.querySelector('.herdr-tree-caret').click();
  return 'first expand issued';
})()`);
await sleep(1500);
await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  target.querySelector('.herdr-tree-caret').click(); // collapse
  return 'collapsed';
})()`);
await sleep(1200);
await evalJs(`(() => { const side = document.querySelector('.file-browser-side'); side.scrollTop = 3000; return side.scrollTop; })()`);
await sleep(1500);

const slideSetup = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...side.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= side.getBoundingClientRect().top && t <= side.getBoundingClientRect().bottom;
  });
  window.__slideMarker = visible[Math.floor(visible.length / 2)].title;
  window.__slideSamples = [];
  const sample = () => {
    const s2 = document.querySelector('.file-browser-side');
    const m = [...s2.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__slideMarker);
    window.__slideSamples.push({
      at: Math.round(performance.now() * 10) / 10,
      y: m ? Math.round(m.getBoundingClientRect().top) : null,
      scrollTop: s2.scrollTop,
    });
  };
  // Timer sampling (16ms) rather than rAF: headless shell can idle-skip
  // animation frames, and each gBCR read forces layout anyway, so the
  // trajectory is captured identically.
  window.__slideTimer = setInterval(sample, 16);
  setTimeout(() => clearInterval(window.__slideTimer), 2400);
  // click the caret (cached expand: single render)
  target.querySelector('.herdr-tree-caret').click();
  return { marker: window.__slideMarker };
})()`);
await sleep(2600);
const slide = await evalJs(`(() => new Promise((res) => setTimeout(() => res({ marker: window.__slideMarker, samples: (window.__slideSamples || []) }), 100)))()`);
console.log("[V7 timer slide]", JSON.stringify(slideSetup), "samples:", JSON.stringify((slide.samples || []).slice(0, 12)), "... tail:", JSON.stringify((slide.samples || []).slice(-4)));

// ---------- V9: same-task wipe+restore for cached pass ----------
const yieldProbe = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  // Normalize to collapsed first so the click below is a cached expand.
  if (target.getAttribute('aria-expanded') === 'true') {
    target.querySelector('.herdr-tree-caret').click();
    return 'collapsed; caller re-arms';
  }
  return 'already collapsed';
})()`);
if (yieldProbe === 'collapsed; caller re-arms') await sleep(1200);
const yieldRun = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  window.__taskYields = [];
  const snap = (phase) => window.__taskYields.push({
    at: Math.round(performance.now() * 10) / 10,
    phase,
    scrollTop: document.querySelector('.file-browser-side').scrollTop,
    rows: document.querySelectorAll('.herdr-tree-row').length,
  });
  // setTimeout 0 checkpoints around the click: they only run if/when the
  // event loop yields; a fully synchronous cached expand produces no
  // intermediate snapshots between pre and post.
  snap('pre');
  setTimeout(() => snap('t0'), 0);
  target.querySelector('.herdr-tree-caret').click();
  snap('post-click sync');
  setTimeout(() => snap('t1'), 0);
  setTimeout(() => snap('t2'), 30);
  return 'armed';
})()`);
await sleep(100);
const yields = await evalJs(`(() => new Promise((res) => setTimeout(() => res(window.__taskYields || []), 1400)))()`);
console.log("[V9 task yields]", JSON.stringify(yieldRun), JSON.stringify(yields));

// ---------- V6: settled-baseline controlled first expand at 6500 ----------
// Fresh page reload resets expanded state so the expand is a true first expand.
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled 2");
await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered 2");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);
await evalJs(`(() => { const side = document.querySelector('.file-browser-side'); side.scrollTop = 6500; return side.scrollTop; })()`);
// KEY DIFFERENCE from the committed run: wait out the drift fully (3.5s) so the
// baseline is settled before the click, then read the actual clamped scrollTop.
await sleep(3500);
const v6 = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...side.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= side.getBoundingClientRect().top && t <= side.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__v6Marker = marker.title;
  window.__v6Before = {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    markerY: marker.getBoundingClientRect().top,
  };
  target.querySelector('.herdr-tree-caret').click();
  return window.__v6Before;
})()`);
await sleep(1600);
const v6after = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const m = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__v6Marker);
  return {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    markerY: m.getBoundingClientRect().top,
    delta: m.getBoundingClientRect().top - window.__v6Before.markerY,
  };
})()`);
console.log("[V6 settled-baseline first expand 6500]", JSON.stringify({ before: v6, after: v6after }));

process.exit(0);
