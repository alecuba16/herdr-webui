// V18 probe: live-measure the search palette bug family (doc section 3.3 claims the
// same pixel-restore-over-virtualized-rows pattern from source only). This probe
// measures it: fill the palette with enough results to virtualize, scroll deep,
// trigger a preserveScroll re-render (loadMoreContent path), and measure the marker
// row shift plus the realized-vs-placeholder height split.
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO.

const ORIGIN = process.env.E2E_ORIGIN;
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const REPO = process.env.E2E_REPO;

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
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

const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed");
await send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2500);
for (let i = 0; i < 50; i++) {
  const url = await evalJs("location.href").catch(() => "");
  if (String(url).includes("127.0.0.1")) break;
  await sleep(200);
}
await evalJs(`try { localStorage.setItem('herdr-web-layout', 'desktop') } catch (e) {}`);
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled");
await waitFor(`(() => (typeof state !== 'undefined' && state.ws === ${JSON.stringify(wsId)}) )()`, "state.ws set");

// Open the search palette via the header search button (openSearchPalette is
// module-scoped; the button click reaches it) and run a content search that
// returns many rows (the fixture repo has 200 dirs x 20 files, all "file N").
const opened = await evalJs(`(() => {
  const btn = document.getElementById('headerActionsButton');
  if (!btn || btn.hidden) return 'no header button';
  btn.click();
  const modal = document.getElementById('searchPalette');
  return modal && modal.style.display !== 'none' ? 'opened' : 'modal not shown';
})()`);
console.log("[V18 open]", JSON.stringify(opened));
await sleep(800);

// Type a query that matches many files, wait for results.
const typed = await evalJs(`(() => {
  const input = document.getElementById('searchPaletteInput') || document.querySelector('.search-palette input');
  if (!input) return 'no input';
  input.value = 'file';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
console.log("[V18 type]", JSON.stringify(typed));
await sleep(3000);

const paletteState = await evalJs(`(() => {
  const container = document.getElementById('searchPaletteResults');
  if (!container) return { error: 'no results container' };
  const rows = [...container.querySelectorAll('.search-result')];
  return {
    rows: rows.length,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    rowClasses: rows.slice(0, 2).map((r) => r.className),
  };
})()`);
console.log("[V18 palette state]", JSON.stringify(paletteState));
if (paletteState.error) process.exit(1);

// Scroll deep into the results and settle.
const scrolled = await evalJs(`(() => {
  const c = document.getElementById('searchPaletteResults');
  const target = Math.min(3000, c.scrollHeight - c.clientHeight);
  c.scrollTop = target;
  return { asked: target, landed: c.scrollTop };
})()`);
await sleep(1500);
const settled = await evalJs(`(() => {
  const c = document.getElementById('searchPaletteResults');
  const rows = [...c.querySelectorAll('.search-result')];
  const cTop = c.getBoundingClientRect().top;
  const visible = rows.filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= cTop && t <= c.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__sm = marker ? marker.textContent.trim().slice(0, 60) : null;
  window.__smEl = marker || null;
  // height split: realized vs placeholder
  const heights = {};
  rows.forEach((r) => { const h = Math.round(r.getBoundingClientRect().height); heights[h] = (heights[h] || 0) + 1; });
  return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, marker: window.__sm, heightDist: heights };
})()`);
console.log("[V18 scrolled]", JSON.stringify({ scrolled, settled }));

// Trigger a preserveScroll re-render: the loadMoreContent path. If not reachable,
// re-type the same query (renderSearchPalettePreservingScroll runs on content arrival).
const retrig = await evalJs(`(() => {
  const markerEl = window.__smEl;
  if (!markerEl) return 'no marker';
  window.__smY = markerEl.getBoundingClientRect().top;
  const c = document.getElementById('searchPaletteResults');
  window.__smScroll = c.scrollTop;
  // Force a preserveScroll re-render through the same code path loadMore uses.
  const helper = window.HerdrWorkspaceSearch;
  if (typeof renderSearchPalettePreservingScroll === 'function') {
    renderSearchPalettePreservingScroll();
    return 'direct call';
  }
  if (window.HerdrSearch && typeof window.HerdrSearch.loadMoreContent === 'function') {
    window.HerdrSearch.loadMoreContent();
    return 'loadMoreContent';
  }
  const input = document.getElementById('searchPaletteInput');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'input re-fire';
})()`);
await sleep(2500);
const after = await evalJs(`(() => {
  const c = document.getElementById('searchPaletteResults');
  const rows = [...c.querySelectorAll('.search-result')];
  const cTop = c.getBoundingClientRect().top;
  const marker = [...rows].find((r) => r.textContent.trim().slice(0, 60) === window.__sm);
  const heights = {};
  rows.forEach((r) => { const h = Math.round(r.getBoundingClientRect().height); heights[h] = (heights[h] || 0) + 1; });
  return {
    retrigger: true,
    markerY: marker ? marker.getBoundingClientRect().top : null,
    markerDelta: marker ? marker.getBoundingClientRect().top - window.__smY : null,
    scrollTop: c.scrollTop,
    scrollHeight: c.scrollHeight,
    rows: rows.length,
    heightDist: heights,
  };
})()`);
console.log("[V18 re-render]", JSON.stringify({ retrigger: retrig, before: { y: null }, after }));

// Also capture the before-Y for the delta: stored in window.__smY, re-read now for the record.
const beforeY = await evalJs(`(() => window.__smY)()`);
console.log("[V18 delta]", JSON.stringify({ beforeY, afterY: after.markerY, delta: after.markerDelta, retrigger: retrig }));

process.exit(0);
