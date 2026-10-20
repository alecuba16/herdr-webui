// Sibling-surface probe for doc section 3.3: mobile file browser (V27).
//
// The doc bullet claims: no content-visibility on mobile tree rows, and
// the expand flow cannot jump because the mobile browser navigates into
// directories rather than splicing children in place. The probe verifies
// both live in the mobile layout:
//   1. boot with herdr-web-layout=mobile, open the Files screen,
//   2. read the computed content-visibility of tree rows (expect
//      "visible": mobile boots do not load shared/file-tree.css, whose
//      .herdr-tree-row virtualization rule is desktop-only),
//   3. toggle a directory row and observe the mechanism: entry count and
//      first-row identity change wholesale (navigation), not an in-place
//      insertion; a content shift can still occur on full re-render but
//      there is no pixel-restore path to break (no scrollTop restore on
//      this screen, scroll resets with the new screen by design).
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO (same contract as other probes).

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
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function waitFor(expr, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalJs(`!!(${expr})`)) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

await send("Page.enable");
await send("Runtime.enable");
// Phone-shaped viewport for the mobile layout.
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

await evalJs(`try { localStorage.setItem('herdr-web-layout', 'mobile') } catch (e) { /* about:blank */ }`);
const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed: " + JSON.stringify(open).slice(0, 300));
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.querySelector('[data-screen="files"]')`, "mobile shell rendered");

// Open the Files screen the way a user does: the nav button.
await evalJs(`(() => { document.querySelector('[data-screen="files"]').click(); return true; })()`);
await waitFor(`!!document.querySelector('.herdr-tree-row')`, "mobile tree rows rendered");
await sleep(1000);

const styleState = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.herdr-tree-row')];
  const cs = rows.length ? getComputedStyle(rows[0]) : null;
  const scroller = document.querySelector('.mobile-screen, .screen, [class*="files"]');
  return {
    layout: document.documentElement.dataset.herdrLayout || null,
    rows: rows.length,
    cv: cs ? cs.contentVisibility : null,
    intrinsic: cs ? cs.containIntrinsicSize : null,
    firstTitles: rows.slice(0, 5).map((r) => r.getAttribute('title') || r.textContent.trim().slice(0, 24)),
  };
})()`);
console.log("[V27 mobile tree style]", JSON.stringify(styleState));

// Toggle a real directory row (user click on the row itself; the shared
// tree markup wires onclick to the callback's toggle method). The first
// .dir row is the parent-up row (titled with the parent path, a no-op at
// the repo root), so the probe picks the first row titled after a real
// child directory of the fixture root.
const before = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.herdr-tree-row.dir')];
  const dirs = rows.filter((r) => {
    const t = r.getAttribute('title') || '';
    return t && !t.startsWith('/') && !t.includes('huge-repo');
  });
  const target = dirs[0];
  if (!target) return { error: 'no dir row' };
  window.__v27FirstBefore = [...document.querySelectorAll('.herdr-tree-row')].map((r) => r.getAttribute('title') || r.textContent.trim().slice(0, 24)).slice(0, 5);
  window.__v27CountBefore = document.querySelectorAll('.herdr-tree-row').length;
  window.__v27TargetTitle = target.getAttribute('title') || target.textContent.trim().slice(0, 40);
  const scroller = document.querySelector('.mobile-screen') || document.scrollingElement;
  return {
    target: window.__v27TargetTitle,
    count: window.__v27CountBefore,
    first: window.__v27FirstBefore,
    scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight } : null,
  };
})()`);
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.herdr-tree-row.dir')];
  const dirs = rows.filter((r) => {
    const t = r.getAttribute('title') || '';
    return t && !t.startsWith('/') && !t.includes('huge-repo');
  });
  if (dirs[0]) dirs[0].click();
  return !!dirs[0];
})()`);
await sleep(1200);
const after = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.herdr-tree-row')];
  const first = rows.map((r) => r.getAttribute('title') || r.textContent.trim().slice(0, 24)).slice(0, 5);
  const scroller = document.querySelector('.mobile-screen') || document.scrollingElement;
  const targetGone = !rows.some((r) => (r.getAttribute('title') || r.textContent.trim().slice(0, 40)) === window.__v27TargetTitle);
  return {
    count: rows.length,
    first,
    wholesaleChange: JSON.stringify(first) !== JSON.stringify(window.__v27FirstBefore),
    targetVisible: !targetGone,
    scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight } : null,
  };
})()`);
console.log("[V27 mobile toggle]", JSON.stringify({ before, after }));

process.exit(0);
