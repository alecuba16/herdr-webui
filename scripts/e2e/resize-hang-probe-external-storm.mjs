// External-backend storm validation: reproduce the user's actual scenario -
// the external herdr daemon dies (its known bug) DURING a resize drag - and
// verify the browser-side storm (per-frame terminal-WS re-attach churn).
// Unlike the builtin probes (manual SIGTERM), this uses the real
// external-herdr ClientShell path and the daemon's natural death as trigger.
// Requires: webui server with XDG_CONFIG_HOME pointing at the scratch dir
// (so the session routes to the external daemon), a herdr daemon for SESSION,
// and the pty holder (keep-tui.py) keeping a TUI client attached.
// Env: E2E_BASE_URL (default https://127.0.0.1:8895/), SESSION
// (default resize-hang-test), CDP_PORT (default 9223), SECONDS (default 14).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const SECONDS = Number(process.env.SECONDS || 14);

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
async function evalx(expr) { return cdp.evalExpr(expr, true); }

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__probe = { ws: [], longTasks: [], maxGap: 0, lastTs: 0, rafSamples: 0 };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) globalThis.__probe.longTasks.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    const tick = (ts) => {
      const p = globalThis.__probe;
      if (p.lastTs) { const g = ts - p.lastTs; if (g > p.maxGap) p.maxGap = Math.round(g); p.rafSamples++; }
      p.lastTs = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const OrigWS = window.WebSocket;
    const PatchedWS = function (url, protocols) {
      globalThis.__probe.ws.push(String(url));
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    try { PatchedWS.prototype = OrigWS.prototype; Object.setPrototypeOf(PatchedWS, OrigWS); } catch (e) {}
    window.WebSocket = PatchedWS;
  })();
` });

await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2000));
await evalx(`(async () => {
  try {
    localStorage.setItem('herdr-session-backend:resize-hang-test', 'external-herdr');
    await fetch('/api/versions', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': ${JSON.stringify(SESSION)} } }).then(r => r.json());
    return true;
  } catch (e) { return String(e); }
})()`);
await cdp.send('Page.navigate', { url: BASE + 'session/' + encodeURIComponent(SESSION) });
await new Promise((r) => setTimeout(r, 2500));

const boot = await evalx(`(() => ({
  session: state.session, backend: currentSessionBackend(),
  compatible: state.herdrCompatible, ws: state.ws, workspaces: (state.workspaces||[]).length,
}))()`);
console.log('boot:', JSON.stringify(boot));
check('browser pinned to external-herdr', boot.backend === 'external-herdr', `backend=${boot.backend}`);

const opened = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': ${JSON.stringify(SESSION)} } });
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
for (let i = 0; i < 40 && !attached; i++) {
  attached = await evalx(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows, backend: currentSessionBackend() };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached (external backend)', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) { dump(); process.exit(1); }

// Reset any shell mode persisted by a previous probe run.
await evalx(`(() => {
  if (typeof rememberWorkspaceShellMode === 'function') rememberWorkspaceShellMode('terminal', state.ws);
  if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide();
  return true;
})()`);

// Light paste (enough to make re-attach replay non-trivial, small enough to
// avoid paste volume being a confounder - BURSTS=0 isolation found paste
// volume was not the daemon-death trigger, but keep it minimal anyway).
await evalx(`(async () => { try { sendPasteToTerminal('echo storm-validation\\n'); } catch (e) {} return true; })()`);
await new Promise((r) => setTimeout(r, 800));

const before = await evalx(`(() => ({
  wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
  eventsOpen: typeof eventWs !== 'undefined' && eventWs ? eventWs.readyState : -1,
  grid: { cols: state.termCols, rows: state.termRows },
  session: state.session,
}))()`);
console.log('before drag:', JSON.stringify(before));
check('terminal WS open before drag', before.wsOpen === 1, `readyState=${before.wsOpen}`);

await evalx(`(() => { globalThis.__probe.ws = []; globalThis.__probe.longTasks = []; globalThis.__probe.maxGap = 0; globalThis.__probe.rafSamples = 0; return true; })()`);

// Continuous drag for SECONDS at rAF cadence. The daemon's known bug kills
// it 6-10s after web attach; the drag outlives the death by design.
const startW = 1600, startH = 1000;
const steps = SECONDS * 60;
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  const phase = Math.sin((i / steps) * Math.PI * 4);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(startW + phase * 220),
    height: Math.round(startH + phase * 130),
    deviceScaleFactor: 0, mobile: false,
  });
  await new Promise((r) => setTimeout(r, 16));
  if (i % 120 === 0) progress(`drag ${Math.round((Date.now() - t0) / 1000)}s / ${SECONDS}s`);
}
progress('drag done');

const after = await evalx(`(() => {
  const ws = globalThis.__probe.ws;
  const byUrl = {};
  for (const u of ws) { const k = u.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, ''); byUrl[k] = (byUrl[k] || 0) + 1; }
  return {
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    backendOnline: state.backendOnline,
    grid: { cols: state.termCols, rows: state.termRows },
    total: ws.length, byUrl,
    probe: {
      maxGap: globalThis.__probe.maxGap,
      rafSamples: globalThis.__probe.rafSamples,
      longTasks: globalThis.__probe.longTasks.length,
      top5: globalThis.__probe.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
    },
  };
})()`);
console.log('after drag:', JSON.stringify(after));

check('backend went offline during drag (daemon death reproduced)', after.backendOnline === false, `backendOnline=${after.backendOnline}`);
const attachCount = after.byUrl['/ws/terminal'] || 0;
check('storm: terminal-attach WS churn during offline drag', attachCount >= 50, `attach WS=${attachCount} of ${after.total}`);
check('storm is terminal-attach dominated', attachCount > (after.total - attachCount), `byUrl=${JSON.stringify(after.byUrl)}`);
check('no catastrophic stall in headless', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));

dump();
function dump() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(' -', f.name, f.detail);
}
process.exit(0);