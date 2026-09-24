// Post-fix validation for the terminal resize freeze (all four fixes).
//
// Runs the EXACT user scenario against a healthy external-herdr daemon:
// working attach, continuous window resize, daemon SIGTERMed mid-drag,
// drag continues. After the fixes the expectations are INVERTED vs the
// diagnostic probes:
//
//   1. Kill-chain gate: the frontend must NOT POST /api/session/close on
//      infra failures (suggest_builtin: false) — the webui server itself
//      must stay alive and the session must stay pinned to external-herdr.
//   2. Terminal backoff: after the daemon dies, resize frames must NOT
//      reattach at frame cadence — /ws/terminal attempts collapse from
//      ~85-136/s to single digits for the whole post-death drag window.
//   3. Graphics-bridge backoff: /ws/terminal-graphics attempts also stay
//      in single digits (scheduled reconnect, not per-frame churn).
//   4. No wedged main thread: rAF keeps ticking (max gap < 2s headless) —
//      the freeze was the storm's cost, not the resize itself.
//
// Env: E2E_BASE_URL (default https://127.0.0.1:8895/), SESSION (default
// resize-hang-test), CDP_PORT (default 9223), DAEMON_PID (REQUIRED: the
// scratch daemon pid to SIGTERM mid-drag; never ps-grep), KILL_AFTER
// (default 5), DRAG_SECONDS (default 14), SERVER_PID (optional: the webui
// server pid, verified alive at the end to prove the kill-chain gate).
import { connectToPage } from './cdp-driver.mjs';
import { execSync } from 'node:child_process';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const SESSION = process.env.SESSION || 'resize-hang-test';
const DAEMON_PID = Number(process.env.DAEMON_PID || 0);
const SERVER_PID = Number(process.env.SERVER_PID || 0);
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
  console.error('DAEMON_PID env required (scratch daemon pid)');
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
      const st = {};
      try { st.target = typeof terminalReconnectTarget !== 'undefined' ? terminalReconnectTarget : 'undef'; } catch (e) { st.target = 'err'; }
      try { st.delay = typeof terminalReconnectDelay !== 'undefined' ? terminalReconnectDelay : 'undef'; } catch (e) { st.delay = 'err'; }
      try { st.notBefore = typeof terminalReconnectNotBefore !== 'undefined' ? terminalReconnectNotBefore : 'undef'; } catch (e) { st.notBefore = 'err'; }
      try { st.timer = typeof terminalReconnectTimer !== 'undefined' ? !!terminalReconnectTimer : 'undef'; } catch (e) { st.timer = 'err'; }
      try { st.termId = (typeof state !== 'undefined' && state) ? state.terminalId : 'undef'; } catch (e) { st.termId = 'err'; }
      globalThis.__probe.ws.push({ url: String(url), t: Date.now(), stack: new Error().stack || '', backoff: st });
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
    localStorage.setItem('herdr-session-backend:${SESSION}', 'external-herdr');
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
check('terminal attached (working attach before kill)', !!attached, `state=${JSON.stringify(attached)}`);
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
  delay: typeof terminalReconnectDelay !== 'undefined' ? terminalReconnectDelay : 'n/a',
}))()`);
console.log('before drag:', JSON.stringify(before));
check('terminal WS open before drag', before.wsOpen === 1, `readyState=${before.wsOpen}`);
if (before.wsOpen !== 1) { dump(); process.exit(1); }

await evalx(`(() => { const p = globalThis.__probe; p.ws = []; p.wsOpened = []; p.longTasks = []; p.maxGap = 0; p.rafSamples = 0; p.apiCalls = []; return true; })()`);

// Continuous drag; SIGTERM the exact scratch daemon KILL_AFTER seconds in.
const startW = 1600, startH = 1000;
const steps = DRAG_SECONDS * 60;
const t0 = Date.now();
let killed = false;
let killFailed = false;
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
    try { process.kill(DAEMON_PID, 'SIGTERM'); } catch (e) { killFailed = true; console.log('kill failed:', e.message); }
    await evalx(`(() => { globalThis.__probe.stormStart = Date.now(); return true; })()`);
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
  const perSec = {};
  for (const w of p.ws) {
    const k = path(w.url);
    byUrl[k] = (byUrl[k] || 0) + 1;
    const sec = stormStart ? Math.floor((w.t - stormStart) / 1000) : -1;
    perSec[sec] = (perSec[sec] || 0) + 1;
  }
  const modalPending = (typeof herdrErrorOfferPending !== 'undefined') ? herdrErrorOfferPending : 'n/a';
  const inBackoff = (typeof terminalAttachInBackoff === 'function')
    ? terminalAttachInBackoff(state.session + '|' + currentSessionBackend() + '|' + state.ws + '|' + state.tab + '|' + state.pane + '|' + state.terminalId)
    : 'n/a';
  return {
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    backendOnline: state.backendOnline,
    stillExternal: currentSessionBackend(),
    total: p.ws.length, byUrl, perSec,
    closeCalls: p.apiCalls.filter(u => u.includes('session/close')).length,
    herdrErrorApiCalls: p.apiCalls.filter(u => u.includes('herdr') || u.includes('session')).slice(0, 10),
    modalPending, inBackoff,
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
const stormSecs = Object.entries(after.perSec).filter(([s]) => Number(s) >= 0);

// Debug: backoff state at the first 12 attach WS creations.
const firstAttachStates = await evalx(`(() => {
  const p = globalThis.__probe;
  return p.ws.filter((w) => w.url.includes('/ws/terminal?')).slice(0, 12).map((w) => ({
    t: w.t, backoff: w.backoff,
  }));
})()`);
console.log('first attach WS backoff states:', JSON.stringify(firstAttachStates, null, 1));

check('daemon killed mid-drag', killed && !killFailed, `killed=${killed} killFailed=${killFailed}`);
check('backend reported offline during drag', after.backendOnline === false, `backendOnline=${after.backendOnline}`);
// THE three fixes, inverted vs the diagnostic probes:
check('FIX terminal backoff: attach churn collapsed (was 85-136/s, now single digits)', attachCount >= 1 && attachCount <= 12, `attach WS=${attachCount} of ${after.total}`);
check('FIX graphics backoff: graphics churn collapsed (was 80+/drag, now single digits)', gfxCount <= 12, `graphics WS=${gfxCount}`);
check('FIX kill-chain gate: NO session/close POST during infra outage', after.closeCalls === 0, `close POSTs=${after.closeCalls}`);
check('session stays pinned to external-herdr', after.stillExternal === 'external-herdr', `backend=${after.stillExternal}`);
check('FIX no wedged main thread: rAF kept ticking', (after.probe.maxGap || 0) < 2000, `maxGap=${after.probe.maxGap}ms over ${after.probe.rafSamples} samples`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));
if (stormSecs.length) console.log('per-second WS counts post-death:', JSON.stringify(stormSecs));

if (SERVER_PID) {
  let serverAlive = null;
  try { process.kill(SERVER_PID, 0); serverAlive = true; } catch (e) { serverAlive = false; }
  check('webui server survived the whole drag (kill-chain held)', serverAlive, `pid=${SERVER_PID} alive=${serverAlive}`);
}

// 8787 real instance must be untouched (informational).
try {
  const real = execSync('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1:8787/ || true').toString().trim();
  console.log(`real 8787 instance still responding: ${real}`);
} catch (e) { console.log('real 8787 instance check skipped:', e.message); }

dump();
function dump() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(' -', f.name, f.detail);
  process.exit(failed.length ? 1 : 0);
}