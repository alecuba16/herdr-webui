// Repro for "terminal resize hangs the browser" against an EXTERNAL herdr
// daemon (ClientShell path): navigates to a session URL that pins
// external-herdr, attaches the existing pane, fills scrollback via the
// daemon-backed shell, then continuously resizes the window while measuring
// main-thread responsiveness.
// Env: E2E_BASE_URL (default https://127.0.0.1:8895/), SESSION (default
// resize-hang-test), CDP_PORT (default 9223), BURSTS (default 25).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const BURSTS = Number(process.env.BURSTS || 25);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

async function evalx(expr) {
  return cdp.evalExpr(expr, true);
}

// Heartbeat probe: long tasks + rAF gaps on the main thread.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__hangProbe = { longTasks: [], maxGap: 0, lastTs: 0, rafSamples: 0, longTaskTotal: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          globalThis.__hangProbe.longTasks.push(Math.round(e.duration));
          globalThis.__hangProbe.longTaskTotal += e.duration;
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    const tick = (ts) => {
      const p = globalThis.__hangProbe;
      if (p.lastTs) {
        const gap = ts - p.lastTs;
        if (gap > p.maxGap) p.maxGap = Math.round(gap);
        p.rafSamples += 1;
      }
      p.lastTs = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
` });

// Pin the backend per session before app JS reads localStorage, then open
// the session route directly (goSession would be needed otherwise).
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2000));
await evalx(`(async () => {
  try {
    localStorage.setItem('herdr-session-backend:${JSON.stringify(SESSION)}', 'external-herdr');
    // Read versions to populate state.herdrCompatible / backendsEnabled.
    await fetch('/api/versions', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': ${JSON.stringify(SESSION)} } }).then(r => r.json());
    return true;
  } catch (e) { return String(e); }
})()`);

// Navigate to the session route with backend + session pinned via storage.
await cdp.send('Page.navigate', { url: BASE + 'session/' + encodeURIComponent(SESSION) });
await new Promise((r) => setTimeout(r, 2500));

const boot = await evalx(`(() => ({
  session: state.session, backend: currentSessionBackend(), herdrCompatible: state.herdrCompatible,
  backendsEnabled: state.backendsEnabled, ws: state.ws, workspaces: state.workspaces.length,
}))()`);
console.log('boot:', JSON.stringify(boot));
check('browser pinned to external-herdr', boot.backend === 'external-herdr', `backend=${boot.backend}`);

// Open the workspace: click through via the app's own go() using the first
// workspace id from the daemon snapshot.
const opened = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': ${JSON.stringify(SESSION)} } });
    const d = await r.json();
    const list = d.result && d.result.workspaces || d.result || [];
    const first = list[0];
    if (!first) return { error: 'no workspaces', raw: JSON.stringify(d).slice(0, 200) };
    const wsId = first.workspace_id || first.id;
    if (typeof go === 'function') go(wsId);
    return { wsId };
  } catch (e) { return { error: String(e) }; }
})()`);
console.log('open workspace:', JSON.stringify(opened));
await new Promise((r) => setTimeout(r, 1500));

// Wait for terminal attach.
let attached = null;
for (let i = 0; i < 30 && !attached; i++) {
  attached = await evalx(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows,
             core: options.terminalCore, backend: currentSessionBackend() };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached (external backend)', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) finish();

// Fill scrollback through the daemon-backed shell.
await evalx(`(async () => {
  try { sendPasteToTerminal('echo hello-from-external\\n'); } catch (e) {}
  return true;
})()`);
await new Promise((r) => setTimeout(r, 800));
for (let b = 0; b < BURSTS; b++) {
  await evalx(`(async () => {
    sendPasteToTerminal('for i in $(seq 1 400); do printf "burst %d %s\\n" $i "$(head -c 64 /dev/urandom | base64)"; done\\n');
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 700));
}

const before = await evalx(`(() => ({
  scrollback: (document.getElementById('terminal') || {scrollHeight:0}).scrollHeight,
  clientHeight: document.getElementById('terminal').clientHeight,
  probe: { maxGap: globalThis.__hangProbe.maxGap, longTasks: globalThis.__hangProbe.longTasks.length, longTaskTotal: Math.round(globalThis.__hangProbe.longTaskTotal) },
}))()`);
console.log('before resize:', JSON.stringify(before));

await evalx(`(() => { globalThis.__hangProbe.longTasks = []; globalThis.__hangProbe.maxGap = 0; globalThis.__hangProbe.rafSamples = 0; return true; })()`);

const resizeStart = Date.now();
const sizes = [];
for (let i = 0; i < 60; i++) {
  const phase = Math.sin((i / 60) * Math.PI * 4);
  const w = Math.round(1400 + phase * 200);
  const h = Math.round(900 + phase * 120);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false });
  sizes.push(`${w}x${h}`);
  await new Promise((r) => setTimeout(r, 60));
}
const resizeMs = Date.now() - resizeStart;

const after = await evalx(`(() => ({
  scrollback: document.getElementById('terminal').scrollHeight,
  clientHeight: document.getElementById('terminal').clientHeight,
  wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
  eventsOpen: typeof eventWs !== 'undefined' && eventWs ? eventWs.readyState : -1,
  probe: {
    maxGap: globalThis.__hangProbe.maxGap,
    rafSamples: globalThis.__hangProbe.rafSamples,
    longTasks: globalThis.__hangProbe.longTasks.length,
    longTaskTotal: Math.round(globalThis.__hangProbe.longTaskTotal),
    top5: globalThis.__hangProbe.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
  },
  grid: { cols: state.termCols, rows: state.termRows },
}))()`);
console.log('after resize:', JSON.stringify(after));
console.log('resize loop:', JSON.stringify({ steps: sizes.length, ms: resizeMs }));

check('terminal WS still open after resize', after.wsOpen === 1, `termWs.readyState=${after.wsOpen} eventsWs.readyState=${after.eventsOpen}`);
check('no catastrophic main-thread stall (>5s without a frame)', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms rafSamples=${after.probe.rafSamples}`);
check('long task total stays under 4s', after.probe.longTaskTotal < 4000, `total=${after.probe.longTaskTotal}ms count=${after.probe.longTasks}`);
check('grid tracked resize', !!after.grid.cols && !!after.grid.rows, `grid=${JSON.stringify(after.grid)}`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));

finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(' -', f.name, f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}