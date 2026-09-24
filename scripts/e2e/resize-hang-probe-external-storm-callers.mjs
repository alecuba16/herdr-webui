// Storm caller attribution: trace WHO constructs each WebSocket during the
// post-daemon-death reconnect storm, with per-second rate timeline.
// External stack: webui 8895 <-> scratch herdr 0.9.0 daemon (separate pid).
// Kills exactly DAEMON_PID (never ps-grep: the user's real 8787 instance
// must be structurally unreachable from this probe).
// Env: E2E_BASE_URL (default https://127.0.0.1:8895/), SESSION
// (resize-hang-test), CDP_PORT (9223), DAEMON_PID (required), KILL_AFTER (5),
// DRAG_SECONDS (14).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const KILL_AFTER = Number(process.env.KILL_AFTER || 5);
const DRAG_SECONDS = Number(process.env.DRAG_SECONDS || 14);
const DAEMON_PID = Number(process.env.DAEMON_PID || 0);
if (!DAEMON_PID) { console.error('DAEMON_PID env required (scratch daemon pid)'); process.exit(2); }

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
function progress(msg) { console.log(`JCODE_PROGRESS ${JSON.stringify({ message: msg })}`); }

process.env.CDP_PORT = String(CDP_PORT);
const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
async function evalx(expr) { return cdp.evalExpr(expr, true); }

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__probe = { ws: [], wsOpened: [], longTasks: [], apiCalls: [] };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) globalThis.__probe.longTasks.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    const OrigWS = window.WebSocket;
    const PatchedWS = function (url, protocols) {
      // Capture the REAL caller (skip our own frames).
      const stack = (new Error().stack || '')
        .split('\\n')
        .filter((l) => l.indexOf('PatchedWS') === -1 && l.indexOf('eval') !== 0)
        .slice(0, 6)
        .join(' | ');
      globalThis.__probe.ws.push({ url: String(url), t: performance.now(), stack });
      const w = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      w.addEventListener('open', () => globalThis.__probe.wsOpened.push({ url: String(url), t: performance.now() }), { once: true });
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
    localStorage.setItem('herdr-session-backend:${SESSION}', 'external-herdr');
    await fetch('/api/versions', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': '${SESSION}' } }).then(r => r.json());
    return true;
  } catch (e) { return String(e); }
})()`);
await cdp.send('Page.navigate', { url: BASE + 'session/' + encodeURIComponent(SESSION) });
await new Promise((r) => setTimeout(r, 2500));

const boot = await evalx(`(() => ({
  session: state.session, backend: currentSessionBackend(),
  compatible: state.herdrCompatible, workspaces: (state.workspaces||[]).length,
}))()`);
console.log('boot:', JSON.stringify(boot));
check('browser pinned to external-herdr', boot.backend === 'external-herdr', `backend=${boot.backend}`);

const opened = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', { headers: { 'x-herdr-backend': 'external-herdr', 'x-herdr-session': '${SESSION}' } });
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
check('terminal WS open before drag', before.wsOpen === 1, `readyState=${before.wsOpen}`);
if (before.wsOpen !== 1) { dump(); process.exit(1); }

await evalx(`(() => { const p = globalThis.__probe; p.ws = []; p.wsOpened = []; p.longTasks = []; p.apiCalls = []; return true; })()`);

// Continuous drag; kill the exact scratch daemon pid KILL_AFTER seconds in.
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
    try { process.kill(DAEMON_PID, 'SIGTERM'); } catch (e) { console.log('kill failed:', e.message); }
    await evalx(`(() => { globalThis.__probe.stormStart = performance.now(); return true; })()`);
    progress(`SIGTERM scratch daemon pid ${DAEMON_PID} at t+${KILL_AFTER}s`);
  }
  if (i % 180 === 0) progress(`drag ${Math.round((Date.now() - t0) / 1000)}s / ${DRAG_SECONDS}s`);
}
progress('drag done');

const after = await evalx(`(() => {
  const p = globalThis.__probe;
  const stormStart = p.stormStart || 0;
  const path = (u) => u.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, '');
  const byUrl = {};
  const callers = {};   // url -> { callerKey: count }
  const perSec = {};     // second -> total ws
  const perSecUrl = {};  // second -> url count
  for (const w of p.ws) {
    const k = path(w.url);
    byUrl[k] = (byUrl[k] || 0) + 1;
    // Caller key: first 2 non-internal stack frames.
    const frames = (w.stack || '').split(' | ');
    const key = frames.slice(0, 3).join(' <- ').slice(0, 220) || 'unknown';
    if (!callers[k]) callers[k] = {};
    callers[k][key] = (callers[k][key] || 0) + 1;
    const sec = stormStart ? Math.floor((w.t - stormStart) / 1000) : -1;
    perSec[sec] = (perSec[sec] || 0) + 1;
    if (!perSecUrl[sec]) perSecUrl[sec] = {};
    perSecUrl[sec][k] = (perSecUrl[sec][k] || 0) + 1;
  }
  const openedCount = {};
  for (const o of p.wsOpened) { const k = path(o.url); openedCount[k] = (openedCount[k] || 0) + 1; }
  return {
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    backendOnline: state.backendOnline,
    total: p.ws.length, byUrl, openedCount,
    callers, perSec, perSecUrl,
    apiCalls: p.apiCalls.filter(u => u.includes('session/close')).length,
    longTasks: p.longTasks.length,
  };
})()`);
console.log('after drag:', JSON.stringify(after, null, 1));

const attachCount = after.byUrl['/ws/terminal'] || 0;
const gfxCount = after.byUrl['/ws/terminal-graphics'] || 0;
check('daemon killed mid-drag', killed, `killed=${killed}`);
check('backend reported offline during drag', after.backendOnline === false, `backendOnline=${after.backendOnline}`);
check('storm: terminal WS churn after daemon death', attachCount >= 30, `attach WS=${attachCount} of ${after.total}`);
check('storm: graphics WS churn', gfxCount >= 10, `graphics WS=${gfxCount}`);
check('session/close attempted (kill-chain)', after.apiCalls >= 1, `close POSTs=${after.apiCalls}`);
check('callers captured for every WS', Object.values(after.callers).every((m) => Object.keys(m).length >= 1), 'caller keys present');

// Attribution summary: top caller per url.
console.log('\n=== CALLER ATTRIBUTION (storm) ===');
for (const [url, map] of Object.entries(after.callers)) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  console.log(`${url} (${Object.values(map).reduce((a, b) => a + b, 0)} total):`);
  for (const [caller, n] of entries.slice(0, 3)) console.log(`  ${n}x  ${caller}`);
}
console.log('\n=== PER-SECOND RATE (sec after daemon death) ===');
for (const sec of Object.keys(after.perSec).map(Number).sort((a, b) => a - b)) {
  console.log(`t+${sec}s: ${JSON.stringify(after.perSecUrl[sec])}`);
}
console.log('\nopened (handshake completed):', JSON.stringify(after.openedCount));

dump();
function dump() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(' -', f.name, f.detail);
}