// Repro for "terminal resize hangs the browser": continuous window resize
// (drag) against a terminal with real scrollback content, measuring main
// thread responsiveness. Usage:
//   node scripts/e2e/resize-hang-repro.mjs
// Requires the isolated server + headless Chrome already running:
//   scripts/e2e/run-live-resize-e2e.sh --keep  (E2E_PORT/CDP_PORT env)
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture git repo) is required');
  process.exit(2);
}

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

// Heartbeat probe: measures long-task pressure on the main thread while we
// resize. Runs entirely in the page via PerformanceObserver + rAF gaps.
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

await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

// Create + select a workspace with a terminal.
const created = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'resize-hang-repro', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) { finish(); }

await evalx(`go(${JSON.stringify(wsId)})`);
await new Promise((r) => setTimeout(r, 1000));

// Wait for terminal attach.
let attached = null;
for (let i = 0; i < 20 && !attached; i++) {
  attached = await evalx(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows,
             core: options.terminalCore, backend: state.backendMode || currentSessionBackend() };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) finish();

// Verify which core is live.
const coreInfo = await evalx(`(() => ({
  core: options.terminalCore,
  adapter: !!(document.getElementById('terminal') || {}).__herdrTerminalAdapter,
  ghostty: !!globalThis.HerdrWtermBundle && !!globalThis.HerdrWtermBundle.GhosttyCore,
}))()`);
console.log('core info:', JSON.stringify(coreInfo));

// Fill the scrollback: print ~2000 lines of colored text via the shell.
await evalx(`(async () => {
  const send = (s) => new Promise((res) => {
    try { sendPasteToTerminal(s + '\\n'); } catch (e) {}
    setTimeout(res, 0);
  });
  await send('for i in $(seq 1 40); do printf "line %d aaaa bbbb cccc dddd eeee ffff gggg %s\\n" $i $(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64); done');
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));
// Repeat a few bursts to build real scrollback.
for (let b = 0; b < 25; b++) {
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

// Reset the probe, then resize the window continuously (drag simulation).
await evalx(`(() => { globalThis.__hangProbe.longTasks = []; globalThis.__hangProbe.maxGap = 0; globalThis.__hangProbe.rafSamples = 0; return true; })()`);

const resizeStart = Date.now();
let resizeDone = null;
// ~4 seconds of continuous resize: many small window-size steps both ways.
const resizeLoop = (async () => {
  const sizes = [];
  const baseW = 1400, baseH = 900;
  for (let i = 0; i < 60; i++) {
    // sweep back and forth
    const phase = Math.sin((i / 60) * Math.PI * 4);
    const w = Math.round(baseW + phase * 200);
    const h = Math.round(baseH + phase * 120);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 0, mobile: false,
    });
    sizes.push(`${w}x${h}`);
    await new Promise((r) => setTimeout(r, 60));
  }
  resizeDone = { steps: sizes.length, ms: Date.now() - resizeStart };
  return resizeDone;
})();

const stats = await resizeLoop;
const after = await evalx(`(() => ({
  scrollback: document.getElementById('terminal').scrollHeight,
  clientHeight: document.getElementById('terminal').clientHeight,
  probe: {
    maxGap: globalThis.__hangProbe.maxGap,
    rafSamples: globalThis.__hangProbe.rafSamples,
    longTasks: globalThis.__hangProbe.longTasks.length,
    longTaskTotal: Math.round(globalThis.__hangProbe.longTaskTotal),
    top5: globalThis.__hangProbe.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
  },
  grid: { cols: state.termCols, rows: state.termRows },
  wsOpens: (() => { try { return globalThis.__wsProbe ? globalThis.__wsProbe.opens : -1; } catch (e) { return -1; } })(),
}))()`);
console.log('after resize:', JSON.stringify(after));
console.log('resize loop:', JSON.stringify(stats));

check('no catastrophic main-thread stall (>5s without a frame)', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms rafSamples=${after.probe.rafSamples}`);
check('long task total stays under 4s', after.probe.longTaskTotal < 4000, `total=${after.probe.longTaskTotal}ms count=${after.probe.longTasks}`);
check('grid tracked resize', !!after.grid.cols && !!after.grid.rows, `grid=${JSON.stringify(after.grid)}`);
console.log('top long tasks:', JSON.stringify(after.probe.top5));

finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(' -', f.name, f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}