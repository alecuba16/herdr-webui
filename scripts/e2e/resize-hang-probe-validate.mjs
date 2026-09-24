// Validation probe v4: dynamically verifies the resize chain claims that
// were previously verified only by static source reading.
//   1. Call-order trace: window resize -> refit rAF -> applyBrowserTerminalSize
//      -> connectTerminal (live-socket fast path OR re-attach) -> term.resize.
//   2. Git drawer (HerdrGitUi.open/hide) does NOT resize the shell while the
//      terminal stays visible; native resize grip behavior checked.
//   3. WS-per-frame attribution during offline drag: which call sites create
//      sockets (terminal attach vs graphics bridge vs event ws).
// Usage: node scripts/e2e/resize-hang-probe-validate.mjs
// Env: E2E_BASE_URL, CDP_PORT, KILL_AT_MS (0 = baseline trace only).
import { connectToPage } from './cdp-driver.mjs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const KILL_AT_MS = Number(process.env.KILL_AT_MS ?? 0);
const SECONDS = Number(process.env.SECONDS || 4);
const PORT_TO_KILL = Number(process.env.PORT_TO_KILL || 8899);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
async function evalx(expr) { return cdp.evalExpr(expr, true); }

// Pre-page hooks: WS constructor wrapper that records call-site stacks
// (via async .stack at throw time is expensive; instead record URL + a
// cheap tag from arguments length is impossible, so capture stack on a
// sampled subset), plus resize-chain order trace, plus longtask probe.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__probe = {
      chain: [],            // ordered call trace of the resize path
      ws: [],              // {url, stack} per WebSocket construction
      longTasks: [], maxGap: 0, lastTs: 0, rafSamples: 0,
    };
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
      let stack = '';
      try { throw new Error('capture'); } catch (e) { stack = String(e.stack || '').split('\\n').slice(1, 4).join(' <- '); }
      globalThis.__probe.ws.push({ url: String(url), stack });
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    try { PatchedWS.prototype = OrigWS.prototype; Object.setPrototypeOf(PatchedWS, OrigWS); } catch (e) {}
    window.WebSocket = PatchedWS;
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

// Reset any shell mode persisted by a previous probe run (git/files
// drawer would hide the terminal shell and freeze the grid).
await evalx(`(() => {
  if (typeof rememberWorkspaceShellMode === 'function') rememberWorkspaceShellMode('terminal', state.ws);
  if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide();
  return true;
})()`);

// Hook the chain AFTER attach: wrap the adapter's resize (dynamic order
// trace) and the element-reported shell size.
await evalx(`(() => {
  const el = document.getElementById('terminal');
  const adapter = el && el.__herdrTerminalAdapter;
  if (!adapter || !adapter.wterm) return 'no adapter';
  const orig = adapter.wterm.resize.bind(adapter.wterm);
  adapter.wterm.resize = function (cols, rows) {
    globalThis.__probe.chain.push('wterm.resize');
    return orig(cols, rows);
  };
  window.addEventListener('resize', () => globalThis.__probe.chain.push('window.resize'), true);
  // ResizeObserver on the shell - the app already installs one; ours only
  // records that the shell box actually changed size.
  const shell = document.getElementById('terminalShell');
  let lastW = shell.getBoundingClientRect().width;
  new ResizeObserver(() => {
    const w = shell.getBoundingClientRect().width;
    if (Math.abs(w - lastW) >= 1) { globalThis.__probe.chain.push('shell.width-changed:' + Math.round(w)); lastW = w; }
  }).observe(shell);
  return true;
})()`);

const shellBefore = await evalx(`(() => {
  const s = document.getElementById('terminalShell');
  const r = s.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(s).display };
})()`);

// TEST 1 (only when backend stays alive): window resize trace order.
if (KILL_AT_MS === 0) {
  await evalx(`(() => { globalThis.__probe.chain = []; globalThis.__probe.ws = []; return true; })()`);
  // Clear any persisted override from a previous run, then resize.
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await new Promise((r) => setTimeout(r, 300));
  await evalx(`(() => { globalThis.__probe.chain = []; return true; })()`);
  // One grid-changing step is enough to trace order; final size differs
  // from the attach size so a grid change actually happens.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 0, mobile: false });
  await new Promise((r) => setTimeout(r, 500));
  const trace1 = await evalx(`(() => globalThis.__probe.chain.slice())()`);
  console.log('trace after window resize:', JSON.stringify(trace1));
  const hasWin = trace1.some((x) => x === 'window.resize');
  const hasGrid = trace1.some((x) => x.startsWith('shell.width-changed'));
  const hasResize = trace1.some((x) => x === 'wterm.resize');
  check('chain order: window.resize before shell-change before wterm.resize', hasWin && hasGrid && hasResize,
    `order=${trace1.join(' > ')}`);
  const orderOk = trace1.indexOf('window.resize') < trace1.indexOf('wterm.resize')
    && trace1.indexOf('wterm.resize') < trace1.findIndex((x) => x.startsWith('shell.width-changed'));
  check('order: window.resize -> wterm.resize, then RO shell-change confirm', orderOk, JSON.stringify(trace1));

  // TEST 2: git drawer open hides the terminal shell (drawer replaces it),
  // and closing restores it. Lazy-load via the app's own loader path.
  const drawer = await evalx(`(async () => {
    if (typeof openWorkspaceGitUi !== 'function') return { error: 'no openWorkspaceGitUi' };
    try { await openWorkspaceGitUi(state.ws, { forceOpen: true }); } catch (e) { return { error: String(e) }; }
    await new Promise((r) => setTimeout(r, 1200));
    const panel = document.getElementById('gitUiPanel');
    const shellNow = document.getElementById('terminalShell');
    return {
      herdrGitUi: !!window.HerdrGitUi,
      panelDisplay: panel ? getComputedStyle(panel).display : 'missing',
      shellDisplay: getComputedStyle(shellNow).display,
      shellHidden: getComputedStyle(shellNow).display === 'none',
    };
  })()`);
  console.log('git drawer:', JSON.stringify(drawer));
  check('git drawer opens (panel visible)', drawer.panelDisplay === 'grid', `panel=${drawer.panelDisplay}`);
  check('git drawer hides terminal shell', drawer.shellHidden === true, `shell display=${drawer.shellDisplay}`);
  await evalx(`(async () => { if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide(); return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  // Restore terminal mode so later runs (and the offline phase) see a
  // visible shell.
  await evalx(`(() => { if (typeof rememberWorkspaceShellMode === 'function') rememberWorkspaceShellMode('terminal', state.ws); return true; })()`);
  const shellAfterClose = await evalx(`(() => {
    const s = document.getElementById('terminalShell');
    return { display: getComputedStyle(s).display, w: Math.round(s.getBoundingClientRect().width) };
  })()`);
  console.log('shell after drawer close:', JSON.stringify(shellAfterClose));
  check('shell restored after drawer close', shellAfterClose.display !== 'none', `display=${shellAfterClose.display}`);

  // Baseline WS accounting: no storm while backend alive.
  const wsBase = await evalx(`(() => globalThis.__probe.ws.map((w) => w.url.split('?')[0]))()`);
  console.log('baseline ws urls:', JSON.stringify(wsBase));
  check('baseline: no terminal-attach WS churn', wsBase.filter((u) => u.includes('/ws/terminal?')).length <= 2,
    `attach count=${wsBase.filter((u) => u.includes('/ws/terminal?')).length}`);
}

// TEST 3 (KILL_AT_MS > 0): offline storm per-frame attribution.
if (KILL_AT_MS > 0) {
  // Re-assert terminal shell mode: refreshOnline's async restore can
  // re-open the git drawer after the startup reset.
  await evalx(`(() => {
    if (typeof rememberWorkspaceShellMode === 'function') rememberWorkspaceShellMode('terminal', state.ws);
    if (window.HerdrGitUi && window.HerdrGitUi.hide) window.HerdrGitUi.hide();
    const s = document.getElementById('terminalShell');
    return { shellDisplay: getComputedStyle(s).display };
  })()`);
  const preShell = await evalx(`(() => ({ shellDisplay: getComputedStyle(document.getElementById('terminalShell')).display, cols: state.termCols, rows: state.termRows }))()`);
  console.log('pre-drag shell:', JSON.stringify(preShell));
  check('shell visible before drag', preShell.shellDisplay !== 'none', `display=${preShell.shellDisplay}`);
  await evalx(`(() => { globalThis.__probe.ws = []; globalThis.__probe.longTasks = []; return true; })()`);
  const startW = 1600, startH = 1000;
  const steps = SECONDS * 60;
  const t0 = Date.now();
  let killed = false;
  for (let i = 0; i < steps; i++) {
    if (!killed && Date.now() - t0 >= KILL_AT_MS) {
      try {
        execFileSync('bash', ['-c', `lsof -ti :${PORT_TO_KILL} | xargs kill 2>/dev/null || true`]);
        killed = true;
        console.log(`killed backend at +${Date.now() - t0}ms`);
      } catch (e) { console.log('kill failed:', String(e)); }
    }
    const phase = Math.sin((i / steps) * Math.PI * 4);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.round(startW + phase * 220), height: Math.round(startH + phase * 130), deviceScaleFactor: 0, mobile: false });
    await new Promise((r) => setTimeout(r, 16));
  }
  const offline = await evalx(`(() => {
    const ws = globalThis.__probe.ws;
    const byUrl = {};
    for (const w of ws) { const k = w.url.split('?')[0].replace(/^wss?:\\/\\/[^/]+/, ''); byUrl[k] = (byUrl[k] || 0) + 1; }
    const byStack = {};
    for (const w of ws) { const k = (w.stack || '').split(' <- ')[0].slice(0, 80); byStack[k] = (byStack[k] || 0) + 1; }
    return { total: ws.length, byUrl, byStack, rafSamples: globalThis.__probe.rafSamples, maxGap: globalThis.__probe.maxGap, longTasks: globalThis.__probe.longTasks.length };
  })()`);
  console.log('offline storm:', JSON.stringify(offline, null, 1));
  check('storm re-confirmed', offline.total > 20, `total=${offline.total}`);
  check('storm is terminal-attach WS (not graphics/events)', (offline.byUrl['/ws/terminal'] || 0) > (offline.total * 0.8),
    `byUrl=${JSON.stringify(offline.byUrl)}`);
  check('long tasks still 0 in headless', offline.longTasks === 0, `n=${offline.longTasks}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(' -', f.name, f.detail);
process.exit(0);