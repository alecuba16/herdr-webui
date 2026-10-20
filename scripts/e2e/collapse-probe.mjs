// V12 probe: collapse-above-viewport measurement. Doc section 2A says the same
// failure moves content UP on collapse when the collapsed folder is above the
// viewport, listed as a claim with no dedicated measurement. This probe measures it.
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

// Scroll to 6500, wait out the drift, expand dir-5 (above viewport), wait, then
// measure the collapse with the same marker methodology as the committed harness.
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(3500);

const expandRes = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const rows = [...s.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  target.querySelector('.herdr-tree-caret').click();
  return 'expanded';
})()`);
await sleep(1800);

const collapse = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const rows = [...s.querySelectorAll('.herdr-tree-row.dir')];
  const target = rows.find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= s.getBoundingClientRect().top && t <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__cMarker = marker.title;
  window.__cBefore = {
    scrollTop: s.scrollTop,
    scrollHeight: s.scrollHeight,
    markerY: marker.getBoundingClientRect().top,
    rows: s.querySelectorAll('.herdr-tree-row').length,
  };
  target.querySelector('.herdr-tree-caret').click();
  return window.__cBefore;
})()`);
await sleep(1800);
const collapseAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__cMarker);
  return {
    scrollTop: s.scrollTop,
    scrollHeight: s.scrollHeight,
    markerY: m ? m.getBoundingClientRect().top : null,
    rows: s.querySelectorAll('.herdr-tree-row').length,
    delta: m ? m.getBoundingClientRect().top - window.__cBefore.markerY : null,
  };
})()`);
console.log("[V12 collapse above viewport]", JSON.stringify({ expandRes, before: collapse, after: collapseAfter }));
process.exit(0);
