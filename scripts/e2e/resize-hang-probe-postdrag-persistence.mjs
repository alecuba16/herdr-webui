// Post-drag storm persistence: does the WS churn continue AFTER the user
// stops dragging? This matches the user's freeze symptom (browser stuck
// until Chrome's kill-page modal, not just during the drag).
// External stack: webui 8895 <-> scratch herdr 0.9.0 daemon.
// Sequence: attach -> drag 6s (kill daemon at t+4s) -> STOP dragging ->
// observe 15s idle. WS rate timeline split into drag-window vs post-drag,
// backendOnline, session/close attempts, rAF stalls, caller attribution.
// Env: E2E_BASE_URL, SESSION, CDP_PORT (9223), DAEMON_PID (required),
// KILL_AFTER (4), DRAG_SECONDS (6), IDLE_SECONDS (15).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const KILL_AFTER = Number(process.env.KILL_AFTER || 4);
const DRAG_SECONDS = Number(process.env.DRAG_SECONDS || 6);
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 15);
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
    globalThis.__probe = { ws: [], longTasks: [], apiCalls: [], maxGap: 0, lastTs: 0, rafSamples: 0 };
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
      const stack = (new Error().stack || '')
        .split('\\n')
        .filter((l) => l.indexOf('PatchedWS') === -1 && l.indexOf('eval') !== 0)
        .slice(0, 6)
        .join(' | ');
      globalThis.__probe.ws.push({ url: String(url), t: performance.now(), stack });
      const w = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
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
    return { terminalId: state.terminalId };
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
}))()`);
check('terminal WS open before drag', before.wsOpen === 1, `readyState=${before.wsOpen}`);
if (before.wsOpen !== 1) { dump(); process.exit(1); }

await evalx(`(() => { const p = globalThis.__probe; p.ws = []; p.longTasks = []; p.apiCalls = []; p.maxGap = 0; p.rafSamples = 0; p.lastTs = 0; return true; })()`);

// Drag with daemon kill mid-way, then STOP and watch.
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
    await evalx(`(() => { globalThis.__probe.stormStart = performance.now(); globalThis.__probe.dragEnd = null; return true; })()`);
    progress(`SIGTERM scratch daemon pid ${DAEMON_PID} at t+${KILL_AFTER}s (mid-drag)`);
  }
}
await evalx(`(() => { globalThis.__probe.dragEnd = performance.now(); return true; })()`);
progress('drag stopped; observing idle window');

for (let s = 0; s < IDLE_SECONDS; s++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (s % 5 === 0) {
    const mid = await evalx(`(() => ({ ws: globalThis.__probe.ws.length, online: state.backendOnline }))()`);
    progress(`idle ${s + 1}s: ws=${mid.ws} backendOnline=${mid.online}`);
  }
}
progress('idle window done');

const after = await evalx(`(() => {
  const p = globalThis.__probe;
  const path = (u) => u.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, '');
  const stormStart = p.stormStart || 0;
  const dragEnd = p.dragEnd || 0;
  const byUrl = {};
  const callers = {};
  const perSecDrag = {};   // second after daemon death, while still dragging
  const perSecIdle = {};   // second after drag stopped
  for (const w of p.ws) {
    const k = path(w.url);
    byUrl[k] = (byUrl[k] || 0) + 1;
    const frames = (w.stack || '').split(' | ');
    const key = frames.slice(0, 3).join(' <- ').slice(0, 200) || 'unknown';
    if (!callers[k]) callers[k] = {};
    callers[k][key] = (callers[k][key] || 0) + 1;
    const sec = stormStart ? Math.floor((w.t - stormStart) / 1000) : -1;
    if (dragEnd && w.t <= dragEnd) perSecDrag[sec] = (perSecDrag[sec] || 0) + 1;
    else {
      const idleSec = dragEnd ? Math.floor((w.t - dragEnd) / 1000) : sec;
      perSecIdle[idleSec] = (perSecIdle[idleSec] || 0) + 1;
    }
  }
  return {
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    backendOnline: state.backendOnline,
    total: p.ws.length, byUrl, callers,
    perSecDrag, perSecIdle,
    apiCalls: p.apiCalls.filter(u => u.includes('session/close')).length,
    apiTotal: p.apiCalls.length,
    maxGap: p.maxGap, rafSamples: p.rafSamples,
    longTasks: p.longTasks.length,
    top5: p.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
    modalVisible: (typeof sessionManagerVisible === 'function') ? sessionManagerVisible() : 'n/a',
  };
})()`);
console.log('after idle:', JSON.stringify(after, null, 1));

check('daemon killed mid-drag', killed, `killed=${killed}`);
check('backend offline after daemon death', after.backendOnline === false, `backendOnline=${after.backendOnline}`);
const dragTotal = Object.values(after.perSecDrag).reduce((a, b) => a + b, 0);
const idleTotal = Object.values(after.perSecIdle).reduce((a, b) => a + b, 0);
check('storm during drag window', dragTotal >= 20, `drag-window WS=${dragTotal}`);
check('storm persists after drag stops', idleTotal >= 20, `post-drag WS=${idleTotal} over ${IDLE_SECONDS}s idle`);
console.log('\n=== DRAG-WINDOW RATE (s after death) ===');
for (const sec of Object.keys(after.perSecDrag).map(Number).sort((a, b) => a - b)) console.log(`t+${sec}s: ${after.perSecDrag[sec]}`);
console.log('\n=== POST-DRAG IDLE RATE (s after drag stop) ===');
for (const sec of Object.keys(after.perSecIdle).map(Number).sort((a, b) => a - b)) console.log(`idle+${sec}s: ${after.perSecIdle[sec]}`);
console.log('\n=== CALLER ATTRIBUTION ===');
for (const [url, map] of Object.entries(after.callers)) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  console.log(`${url} (${Object.values(map).reduce((a, b) => a + b, 0)} total):`);
  for (const [caller, n] of entries.slice(0, 3)) console.log(`  ${n}x  ${caller}`);
}

dump();
function dump() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(' -', f.name, f.detail);
}