// Probe v3: does a backend death DURING a resize drag freeze the browser?
// Kills the isolated test server mid-drag (KILL_AT_MS) and keeps resizing.
// Counts the offline storm: WebSocket constructions and /api fetches per
// second, long tasks, and rAF gaps. Baseline: KILL_AT_MS=0 (never kill).
// Usage: node scripts/e2e/resize-hang-probe-offline.mjs
// Env: E2E_BASE_URL, CDP_PORT, KILL_AT_MS (default 2000), SECONDS (6),
//      PORT_TO_KILL (default 8899 - the isolated test server only).
import { connectToPage } from './cdp-driver.mjs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const KILL_AT_MS = Number(process.env.KILL_AT_MS ?? 2000);
const SECONDS = Number(process.env.SECONDS || 6);
const PORT_TO_KILL = Number(process.env.PORT_TO_KILL || 8899);
const KILL_MODE = process.env.KILL_MODE || 'kill'; // 'kill' = SIGTERM (refuse), 'stop' = SIGSTOP (hang)

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
function progress(msg) {
  console.log(`JCODE_PROGRESS ${JSON.stringify({ message: msg })}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

async function evalx(expr) {
  return cdp.evalExpr(expr, true);
}

// Main-thread stall probe + offline-storm counters, installed before any
// app script so fetch/WebSocket patches wrap the app's globals.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__hangProbe = { longTasks: [], maxGap: 0, lastTs: 0, rafSamples: 0, longTaskTotal: 0 };
    globalThis.__stormProbe = { wsCreated: 0, apiFetches: 0, loadingShown: 0 };
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
    const OrigWS = window.WebSocket;
    const PatchedWS = function (url, protocols) {
      globalThis.__stormProbe.wsCreated += 1;
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    try { PatchedWS.prototype = OrigWS.prototype; Object.setPrototypeOf(PatchedWS, OrigWS); } catch (e) {}
    window.WebSocket = PatchedWS;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(u).includes('/api/')) globalThis.__stormProbe.apiFetches += 1;
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  })();
` });

await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

const opened = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces');
    const d = await r.json();
    const list = d.result && d.result.workspaces || d.result || [];
    const first = list[0];
    if (!first) return { error: 'no workspaces' };
    const wsId = first.workspace_id || first.id;
    if (typeof go === 'function') go(wsId);
    return { wsId };
  } catch (e) { return { error: String(e) }; }
})()`);
console.log('open workspace:', JSON.stringify(opened));

let attached = null;
for (let i = 0; i < 30 && !attached; i++) {
  attached = await evalx(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) process.exit(1);

// Modest scrollback so the drag itself stays cheap (v2 proved that).
await evalx(`(async () => { sendPasteToTerminal('for i in $(seq 1 1500); do printf "line %d aaaa bbbb cccc\\n" $i; done\\n'); return true; })()`);
await new Promise((r) => setTimeout(r, 1500));

const before = await evalx(`(() => ({
  wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
  grid: { cols: state.termCols, rows: state.termRows },
  storm: { ...globalThis.__stormProbe },
  heapMB: (performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576)) || -1,
  domNodes: document.getElementsByTagName('*').length,
}))()`);
console.log('before:', JSON.stringify(before));

await evalx(`(() => {
  globalThis.__hangProbe.longTasks = []; globalThis.__hangProbe.maxGap = 0;
  globalThis.__hangProbe.rafSamples = 0; globalThis.__hangProbe.longTaskTotal = 0;
  globalThis.__stormProbe.wsCreated = 0; globalThis.__stormProbe.apiFetches = 0;
  return true;
})()`);

// Drag with optional mid-drag backend kill. The kill targets ONLY the
// isolated test server on PORT_TO_KILL (real user instances are on other
// ports and never touched).
const startW = 1600, startH = 1000;
const steps = SECONDS * 60;
const t0 = Date.now();
let killed = false;
for (let i = 0; i < steps; i++) {
  if (!killed && KILL_AT_MS > 0 && Date.now() - t0 >= KILL_AT_MS) {
    const sig = KILL_MODE === 'stop' ? '-STOP' : '-TERM';
    try {
      execFileSync('bash', ['-c', `lsof -ti :${PORT_TO_KILL} | xargs kill ${sig} 2>/dev/null || true`]);
      killed = true;
      console.log(`killed backend on port ${PORT_TO_KILL} (kill ${sig}) at +${Date.now() - t0}ms`);
    } catch (e) {
      console.log('kill failed:', String(e));
    }
  }
  const phase = Math.sin((i / steps) * Math.PI * 4);
  const w = Math.round(startW + phase * 220);
  const h = Math.round(startH + phase * 130);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false });
  await new Promise((r) => setTimeout(r, 16));
}
const dragMs = Date.now() - t0;
progress('drag done');

const after = await evalx(`(() => ({
  grid: { cols: state.termCols, rows: state.termRows },
  wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
  offlineOverlay: (() => { const m = document.getElementById('sessionManager'); return m && m.style && m.style.display !== 'none' ? true : false; })(),
  storm: { ...globalThis.__stormProbe },
  heapMB: (performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576)) || -1,
  domNodes: document.getElementsByTagName('*').length,
  probe: {
    maxGap: globalThis.__hangProbe.maxGap,
    rafSamples: globalThis.__hangProbe.rafSamples,
    longTasks: globalThis.__hangProbe.longTasks.length,
    longTaskTotal: Math.round(globalThis.__hangProbe.longTaskTotal),
    top5: globalThis.__hangProbe.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
  },
}))()`);
console.log('after:', JSON.stringify(after));
console.log('drag loop:', JSON.stringify({ steps, ms: dragMs, killed }));

if (KILL_AT_MS > 0) {
  check('backend was killed mid-drag', killed, `at +${KILL_AT_MS}ms`);
  check('storm: WS constructions exploded (>20 during drag)', after.storm.wsCreated > 20, `wsCreated=${after.storm.wsCreated}`);
  check('storm: /api fetches exploded (>30 during drag)', after.storm.apiFetches > 30, `apiFetches=${after.storm.apiFetches}`);
} else {
  check('baseline: WS constructions stayed low (<10)', after.storm.wsCreated < 10, `wsCreated=${after.storm.wsCreated}`);
  check('baseline: /api fetches stayed low (<15)', after.storm.apiFetches < 15, `apiFetches=${after.storm.apiFetches}`);
}
check('no catastrophic stall (>5s no frame)', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms raf=${after.probe.rafSamples}`);
check('long task total under 4s', after.probe.longTaskTotal < 4000, `total=${after.probe.longTaskTotal}ms n=${after.probe.longTasks}`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(' -', f.name, f.detail);
process.exit(0);