// V17 retry: validate the 3.2 row-anchored restore at the DOM integration point.
// renderPreservingScroll is closure-scoped, so the wrapper installs an own-property
// scrollTop accessor on the .file-browser-side element: every read snapshots the
// first visible row (title + viewport offset) as anchor; every write that follows a
// DOM change (row set differs from the snapshot) resolves the anchor row and writes
// the pinned position instead of the raw pixel value. This is the same anchor math
// as design 3.2, applied at the exact integration point the real fix would touch.
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

await evalJs(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

// Install the anchor interception (design 3.2 math at the scrollTop write point).
const install = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  if (!side) return 'no side';
  if (side.__anchored) return 'already installed';
  const proto = Object.getPrototypeOf(side);
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!desc || !desc.get || !desc.set) return 'no prototype accessor';
  if (Object.getOwnPropertyDescriptor(proto, 'scrollTop')) return 'unexpected own accessor on HTMLElement.prototype';
  side.__anchor = null;
  const snapAnchor = () => {
    const rows = [...side.querySelectorAll('.herdr-tree-row')];
    if (!rows.length) return;
    const sideTop = side.getBoundingClientRect().top;
    const first = rows.find((r) => {
      const top = r.getBoundingClientRect().top;
      return top >= sideTop - 1 && top <= sideTop + 1;
    }) || rows.find((r) => r.getBoundingClientRect().bottom > sideTop);
    if (!first) return;
    side.__anchor = {
      title: first.title,
      offset: first.getBoundingClientRect().top - sideTop,
      rows: rows.map((r) => r.title),
    };
  };
  Object.defineProperty(side, 'scrollTop', {
    get() {
      snapAnchor();
      return desc.get.call(side);
    },
    set(v) {
      // If the row set changed since the anchor snapshot, the render wiped the
      // tree: pin the anchor row to its recorded offset instead of raw pixels.
      const rowsNow = [...side.querySelectorAll('.herdr-tree-row')].map((r) => r.title);
      if (side.__anchor && rowsNow.length && rowsNow.length !== side.__anchor.rows.length) {
        const row = [...side.querySelectorAll('.herdr-tree-row')].find((r) => r.title === side.__anchor.title);
        if (row) {
          const sideTop = side.getBoundingClientRect().top;
          const rowDoc = row.getBoundingClientRect().top + desc.get.call(side) - sideTop;
          desc.set.call(side, Math.max(0, rowDoc - side.__anchor.offset));
          return;
        }
      }
      desc.set.call(side, v);
    },
    configurable: true,
  });
  side.__anchored = true;
  return 'installed';
})()`);
console.log("[V17 install]", JSON.stringify(install));

// Scroll to 6500, settle, then first-expand dir-5 (uncached, two renders) and measure.
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(2500);
const v17first = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m17 = marker.title;
  window.__b17 = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m17, before: window.__b17, scrollTop: s.scrollTop };
})()`);
await sleep(2000);
const v17firstAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m17);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__b17, scrollTop: s.scrollTop, rows: s.querySelectorAll('.herdr-tree-row').length };
})()`);
console.log("[V17 anchored first expand]", JSON.stringify({ before: v17first, after: v17firstAfter }));

// Cached expand (dir-5 again), same measurement.
await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  t.querySelector('.herdr-tree-caret').click();
})()`);
await sleep(1500);
await evalJs(`(() => { const s = document.querySelector('.file-browser-side'); s.scrollTop = 6500; return s.scrollTop; })()`);
await sleep(2000);
const v17cached = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m17c = marker.title;
  window.__b17c = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m17c, before: window.__b17c, scrollTop: s.scrollTop };
})()`);
await sleep(2000);
const v17cachedAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m17c);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__b17c, scrollTop: s.scrollTop, rows: s.querySelectorAll('.herdr-tree-row').length };
})()`);
console.log("[V17 anchored cached expand]", JSON.stringify({ before: v17cached, after: v17cachedAfter }));

// Collapse round trip: anchored restore must also hold on collapse (rows removed above).
const v17collapse = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const t = [...s.querySelectorAll('.herdr-tree-row.dir')].find((r) => (r.title || '').endsWith('dir-5'));
  const visible = [...s.querySelectorAll('.herdr-tree-row')].filter((r) => {
    const top = r.getBoundingClientRect().top;
    return top >= s.getBoundingClientRect().top && top <= s.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)];
  window.__m17x = marker.title;
  window.__b17x = marker.getBoundingClientRect().top;
  t.querySelector('.herdr-tree-caret').click();
  return { marker: window.__m17x, before: window.__b17x };
})()`);
await sleep(2000);
const v17collapseAfter = await evalJs(`(() => {
  const s = document.querySelector('.file-browser-side');
  const m = [...s.querySelectorAll('.herdr-tree-row')].find((r) => r.title === window.__m17x);
  return { after: m.getBoundingClientRect().top, delta: m.getBoundingClientRect().top - window.__b17x, scrollTop: s.scrollTop, rows: s.querySelectorAll('.herdr-tree-row').length };
})()`);
console.log("[V17 anchored collapse]", JSON.stringify({ before: v17collapse, after: v17collapseAfter }));

process.exit(0);