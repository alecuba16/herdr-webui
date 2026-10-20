// Fix-design validation probes (V15-V17): measure the doc's section 3 design live
// via page-level injection, without touching product source.
//
// V15: baseline re-measure of the cached expand at 6500 with the drift settled
//      (expect ~+726 like the committed run) plus computed overflow-anchor check.
// V16: inject the 3.1 CSS (explicit 29px row height, 31px current-row height,
//      intrinsic 17px content-box) and re-measure setup clamp, pre-click drift,
//      and the cached-expand delta. Mechanism B is gone iff scrollTop lands on
//      the requested value (no clamp), the marker holds before the click (no
//      drift), and the delta equals the pure inserted height above the marker.
// V17: layer the 3.2 row-anchored restore on top (page-level wrapper around
//      renderPreservingScroll implementing the design's anchor math) and
//      measure cached and first expand. Mechanism A is gone iff the marker
//      delta is ~0 in both passes.
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO (same contract as expand-jump-experiment.mjs).

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

await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

// ---------- V15: overflow-anchor + baseline cached expand (settled) ----------
const anchorStyle = await evalJs(`(() => getComputedStyle(document.querySelector('.file-browser-side')).overflowAnchor)()`);

await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(3500);
const setup0 = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  return { asked: 6500, landed: s.scrollTop, scrollHeight: s.scrollHeight };
})()`);
// expand once (first expand), collapse, re-scroll, cached expand baseline:
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1800);
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1500);
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(2500);
const v15 = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m = marker.title;
  window.__before = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m, before: window.__before, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight };
})()`);
await sleep(2000);
const v15after = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__before, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight };
})()`);
console.log("[V15 baseline cached expand]", JSON.stringify({ anchorStyle, setup0, before: v15, after: v15after }));

// ---------- V16: inject 3.1 CSS, re-measure ----------
// Reload to reset expanded state, then inject the design's CSS before the tree renders.
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled 2");
await evalJs(`(() => {
  const style = document.createElement('style');
  style.id = 'fix31';
  style.textContent = [
    '.herdr-tree-row { height: 29px; }',
    '.herdr-file-tree-current .herdr-tree-row { height: 31px; }',
    '.herdr-tree-row { contain-intrinsic-size: auto 17px; }',
  ].join('\\n');
  document.head.appendChild(style);
  return 'css injected';
})()`);
await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered 2");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

const rowHeights = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const first = s.querySelector('.herdr-tree-row');
  const dir = s.querySelector('.herdr-tree-row.dir:not(.current)');
  const cur = s.querySelector('.herdr-file-tree-current .herdr-tree-row');
  return {
    firstH: first.getBoundingClientRect().height,
    dirH: dir.getBoundingClientRect().height,
    curH: cur.getBoundingClientRect().height,
  };
})()`);

// scroll 6500: with mechanism B gone, scrollTop should land exactly on 6500 (no clamp).
const setRes = await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return { landed: s.scrollTop, scrollHeight: s.scrollHeight }; })()`);
await sleep(2500);
const settledRes = await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight }; })()`);
// drift check: marker position stability over 2s with no interaction
const driftA = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  window.__dMarker = visible[Math.floor(visible.length / 2)].title;
  return { marker: window.__dMarker, y: visible[Math.floor(visible.length / 2)].getBoundingClientRect().top };
})()`);
await sleep(2000);
const driftB = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__dMarker);
  return m.getBoundingClientRect().top;
})()`);
// cached expand under CSS fix: first expand, collapse, re-scroll, expand cached.
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1800);
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1500);
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(1500);
const v16 = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m16 = marker.title;
  window.__b16 = marker.getBoundingClientRect().top;
  const childH = s.scrollHeight;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m16, before: window.__b16, scrollTop: s.scrollTop, scrollHeightBefore: childH };
})()`);
await sleep(2000);
const v16after = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m16);
  return {
    after: m.getBoundingClientRect().top,
    delta: m.getBoundingClientRect().top - window.__b16,
    scrollTop: s.scrollTop,
    scrollHeight: s.scrollHeight,
    rows: s.querySelectorAll('.herdr-tree-row').length,
  };
})()`);
console.log("[V16 css-fix cached expand]", JSON.stringify({ rowHeights, setRes, settledRes, drift: { a: driftA, b: driftB }, before: v16, after: v16after }));

// ---------- V17: row-anchored restore wrapper on top of the CSS ----------
// Keep the CSS fix from V16 (same page). Wrap renderPreservingScroll with the
// design's anchor math: capture first visible row title + viewport offset before
// render; after render, resolve the row and pin it to the same offset.
const wrapRes = await evalJs(`(() => {
  const orig = window.renderPreservingScroll;
  if (typeof orig !== 'function') return 'renderPreservingScroll not global';
  window.__origRPS = orig;
  window.renderPreservingScroll = function () {
    const side = document.querySelector('.file-browser-side');
    if (!side) return orig.apply(this, arguments);
    const rows = [...side.querySelectorAll('.herdr-tree-row')];
    const sideTop = side.getBoundingClientRect().top;
    const first = rows.find((r) => {
      const top = r.getBoundingClientRect().top;
      return top >= sideTop - 1 && top <= sideTop + 1;
    }) || rows.find((r) => r.getBoundingClientRect().bottom > sideTop);
    if (!first) return orig.apply(this, arguments);
    const anchorTitle = first.title;
    const offset = first.getBoundingClientRect().top - sideTop;
    orig.apply(this, arguments);
    // resolve after the render pass
    const rows2 = [...side.querySelectorAll('.herdr-tree-row')];
    const row = rows2.find((r) => r.title === anchorTitle);
    if (!row) return;
    const sideTop2 = side.getBoundingClientRect().top;
    const rowDoc = row.getBoundingClientRect().top + side.scrollTop - sideTop2;
    side.scrollTop = Math.max(0, rowDoc - offset);
  };
  return 'wrapped';
})()`);
console.log("[V17 wrap]", JSON.stringify(wrapRes));

// first expand under CSS + anchor: reload-expanded state is collapsed again? No: dir-5 is
// expanded from V16. Collapse it first, then run the first-expand-equivalent measurement:
// with children cached, a fresh expand is single-render (cached class). To also test the
// two-render path we would need an uncached dir; use dir-6 (never expanded) for the true
// first-expand measurement, and dir-5 cached for the cached measurement.
const v17prep = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  // collapse dir-5 back so both targets start collapsed
  const t5 = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  if (t5.getAttribute('aria-expanded') === 'true') t5.querySelector('.herdr-tree-caret').click();
  return 'ready';
})()`);
await sleep(1500);
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(1500);

// first expand (dir-6, uncached: two renders through the wrapper)
const v17first = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-6'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m17 = marker.title;
  window.__b17 = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m17, before: window.__b17 };
})()`);
await sleep(2000);
const v17firstAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m17);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__b17, scrollTop: s.scrollTop, rows: s.querySelectorAll('.herdr-tree-row').length };
})()`);
console.log("[V17 anchored first expand]", JSON.stringify({ prep: v17prep, before: v17first, after: v17firstAfter }));

// cached expand (dir-6 again, single render through the wrapper)
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-6'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1500);
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(1500);
const v17cached = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-6'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m17c = marker.title;
  window.__b17c = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m17c, before: window.__b17c };
})()`);
await sleep(2000);
const v17cachedAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m17c);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__b17c, scrollTop: s.scrollTop, rows: s.querySelectorAll('.herdr-tree-row').length };
})()`);
console.log("[V17 anchored cached expand]", JSON.stringify({ before: v17cached, after: v17cachedAfter }));

process.exit(0);
