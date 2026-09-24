// External-backend mid-drag daemon death: the user's exact freeze scenario.
// Boots against a HEALTHY external-herdr daemon with a WORKING attach
// (requires socket paths <= 104 chars: macOS sun_path limit), starts a
// continuous drag, then SIGTERMs the daemon 5s in and keeps dragging.
// Measures the post-death storm: WS churn, long tasks, rAF gaps, and the
// frontend's own session/close kill-chain behavior.
// Env: E2E_BASE_URL, SESSION, CDP_PORT (default 9223), DAEMON_PID (REQUIRED:
// the scratch daemon pid to SIGTERM; never ps-grep, that could hit the
// user's real 8787 instance), KILL_AFTER (default 5), DRAG_SECONDS (default 14).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const DAEMON_PID = Number(process.env.DAEMON_PID || 0);
const KILL_AFTER = Number(process.env.KILL_AFTER || 5);
const DRAG_SECONDS = Number(process.env.DRAG_SECONDS || 14);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
function progress(msg) {
  console.log(`JCODE_PROGRESS ${JSON.stringify({ message: msg })}`);
}

if (!DAEMON_PID) {
  console.error('DAEMON_PID env required (scratch daemon pid; never ps-grep)');
  process.exit(2);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
async function evalx(expr) { return cdp.evalExpr(expr, true); }

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__probe = { ws: [], wsOpened: [], longTasks: [], maxGap: 0, lastTs: 0, rafSamples: 0, apiCalls: [] };
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
      const w = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      w.addEventListener('open', () => globalThis.__probe.wsOpened.push(String(url)), { once: true });
      return w;
    };
    try { PatchedWS.prototype = OrigWS.prototype; Object.setPrototypeOf(PatchedWS, OrigWS); } catch (e) {}
    window.WebSocket = PatchedWS;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try { globalThis.__probe.apiCalls.push(String((input && input.url) || input)); } catch (e) {}
      return origFetch.call(this, input, init);
    };
  })();
` });

await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2000));
await evalx(`(async () => {
  try {
    localStorage.setItem('herdr-session-backend:resize-hang-test', 'external-herdr');
    await fetch('/api/versions', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': 'resize-hang-test' } }).then(r => r.json());
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
    const r = await fetch('/api/workspaces', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': 'resize-hang-test' } });
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
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached (working attach)', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) { dump(); process.exit(1); }

await evalx(`(() => {
  if (typeof rememberWorkspaceShellMode === 'function') rememberWorkspaceShellMode('terminal', state.ws);
  if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));

const before = await evalx(`(() => ({
  wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
  backendOnline: state.backendOnline,
}))()`);
console.log('before drag:', JSON.stringify(before));
check('terminal WS open before drag', before.wsOpen === 1, `readyState=${before.wsOpen}`);
if (before.wsOpen !== 1) { dump(); process.exit(1); }

await evalx(`(() => { const p = globalThis.__probe; p.ws = []; p.wsOpened = []; p.longTasks = []; p.maxGap = 0; p.rafSamples = 0; p.apiCalls = []; return true; })()`);

// Continuous drag; SIGTERM the daemon KILL_AFTER seconds in.
const startW = 1600, startH = 1000;
const steps = DRAG_SECONDS * 60;
const t0 = Date.now();
let killed = false;
for (let i = 0; i < steps; i++) {
  const phase = Math.sin((i / steps) * Math.PI * 4);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(startW + phase * 220),
    height: Math.round(startH + phase * 130),
    deviceScaleFactor: 0, mobile: false,
  });
  await new Promise((r) => setTimeout(r, 16));
  if (!killed && (Date.now() - t0) >= KILL_AFTER * 1000) {
    killed = true;
    // Kill exactly the scratch daemon (env-provided pid). NEVER ps-grep:
    // that could match the user's real 8787 instance.
    try { process.kill(DAEMON_PID, 'SIGTERM'); } catch (e) { console.log('kill failed:', e.message); }
    // Mark the storm window start.
    await evalx(`(() => { globalThis.__probe.stormStart = Date.now(); return true; })()`);
    progress(`SIGTERM scratch daemon pid ${DAEMON_PID} at t+${KILL_AFTER}s`);
  }
  if (i % 180 === 0) progress(`drag ${Math.round((Date.now() - t0) / 1000)}s / ${DRAG_SECONDS}s`);
}
progress('drag done');

const after = await evalx(`(() => {
  const p = globalThis.__probe;
  const byUrl = {};
  for (const u of p.ws) { const k = u.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, ''); byUrl[k] = (byUrl[k] || 0) + 1; }
  const byOpened = {};
  for (const u of p.wsOpened) { const k = u.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, ''); byOpened[k] = (byOpened[k] || 0) + 1; }
  return {
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    backendOnline: state.backendOnline,
    total: p.ws.length, byUrl, openedTotal: p.wsOpened.length, byOpened,
    apiCalls: p.apiCalls.filter(u => u.includes('session/close')).length,
    modalPending: (typeof herdrErrorOfferPending !== 'undefined') ? herdrErrorOfferPending : 'n/a',
    probe: {
      maxGap: p.maxGap, rafSamples: p.rafSamples,
      longTasks: p.longTasks.length,
      top5: p.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
    },
  };
})()`);
console.log('after drag:', JSON.stringify(after, null, 1));

const attachCount = after.byUrl['/ws/terminal'] || 0;
const gfxCount = after.byUrl['/ws/terminal-graphics'] || 0;
check('daemon killed mid-drag', killed, `killed=${killed}`);
check('backend reported offline during drag', after.backendOnline === false, `backendOnline=${after.backendOnline}`);
check('storm: terminal-attach WS churn after daemon death', attachCount >= 30, `attach WS=${attachCount} of ${after.total}`);
check('storm includes graphics-bridge churn', gfxCount >= 10, `graphics WS=${gfxCount}`);
check('frontend attempted session/close (kill-chain active)', after.apiCalls >= 1, `close POSTs=${after.apiCalls}`);
check('no catastrophic stall in headless', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));

dump();
function dump() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(' -', f.name, f.detail);
}
process.exit(0);