// Repro v2 for "terminal resize hangs the browser": measures the real
// per-resize cost of the terminal surface at window-drag cadence, with
// realistic styled scrollback content (truecolor, OSC8 links, emoji,
// wide chars) vs plain ASCII, and reports per-resize timings from the
// adapter plus longtask/rAF-gap pressure.
// Usage: node scripts/e2e/resize-hang-probe-v2.mjs
// Env: E2E_BASE_URL (default https://127.0.0.1:8899/), CDP_PORT (9222),
//      MODE=plain|styled (default styled), SECONDS (default 6).
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const MODE = process.env.MODE || 'styled';
const SECONDS = Number(process.env.SECONDS || 6);

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

// Open the first workspace.
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

// Instrument every wterm resize: the adapter attaches itself to the
// terminal element (container.__herdrTerminalAdapter), so wrap its
// wterm.resize in place - that is the synchronous reflow+DOM-rebuild call.
const hooked = await evalx(`(() => {
  const el = document.getElementById('terminal');
  const adapter = el && el.__herdrTerminalAdapter;
  if (!globalThis.__resizeProbe && adapter && adapter.wterm && adapter.wterm.resize) {
    globalThis.__resizeProbe = { samples: [] };
    const orig = adapter.wterm.resize.bind(adapter.wterm);
    adapter.wterm.resize = function (cols, rows) {
      const t0 = performance.now();
      try { orig(cols, rows); } catch (e) {}
      const dt = performance.now() - t0;
      globalThis.__resizeProbe.samples.push({ cols, rows, ms: Math.round(dt * 10) / 10 });
    };
    return true;
  }
  return false;
})()`);
check('wterm resize instrumented', hooked === true, `hooked=${JSON.stringify(hooked)}`);

// Fill scrollback: styled, plain, or longlines.
if (MODE === 'longlines') {
  // Pathological wrapped-line profile: few logical lines but each wraps
  // into thousands of grid rows (one-line JSON dumps, minified bundles).
  // Reflow re-wraps every row segment, so cost scales with segments.
  await evalx(`(async () => { sendPasteToTerminal('for i in $(seq 1 40); do printf "line %d start " $i; head -c 40000 /dev/zero | tr "\\0" "x"; printf " end\\n"; done\\n'); return true; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  for (let b = 0; b < 10; b++) {
    await evalx(`(async () => { sendPasteToTerminal('for i in $(seq 1 10); do printf "bulk %d " $i; head -c 40000 /dev/zero | tr "\\0" "y"; printf "\\n"; done\\n'); return true; })()`);
    await new Promise((r) => setTimeout(r, 700));
  }
} else if (MODE === 'styled') {
  // Truecolor spans + OSC8 hyperlinks + emoji + wide chars per line.
  await evalx(`(async () => {
    sendPasteToTerminal('for i in $(seq 1 250); do printf "\\033[38;2;%d;%d;255mcolor %d \\033[38;2;255;180;%dmvalue\\033[39m \\033]8;;https://example.com/\\033\\\\link%d\\033]8;;\\033\\\\ 😀名前テスト wide ✓ \\n" $((i%256)) $((i*7%256)) $i $((i*3%256)) $i; done\\n');
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  for (let b = 0; b < 20; b++) {
    await evalx(`(async () => {
      sendPasteToTerminal('for i in $(seq 1 500); do printf "\\033[38;2;%d;%d;255mburst\\033[1;35m %d\\033[22;39m \\033]8;;https://example.com/p%d\\033\\\\file.rs:%d\\033]8;;\\033\\\\ 😀日本語 wide-char\\n" $((i%256)) $((i*11%256)) $i $i $i; done\\n');
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 600));
  }
} else {
  await evalx(`(async () => { sendPasteToTerminal('for i in $(seq 1 2000); do printf "line %d aaaa bbbb cccc dddd eeee\\n" $i; done\\n'); return true; })()`);
  await new Promise((r) => setTimeout(r, 1000));
  for (let b = 0; b < 20; b++) {
    await evalx(`(async () => { sendPasteToTerminal('for i in $(seq 1 500); do printf "burst %d %s\\n" $i "$(head -c 64 /dev/urandom | base64)"; done\\n'); return true; })()`);
    await new Promise((r) => setTimeout(r, 600));
  }
}

const before = await evalx(`(() => ({
  scrollbackRows: document.querySelectorAll('#terminal .term-scrollback-row').length,
  scrollHeight: document.getElementById('terminal').scrollHeight,
  grid: { cols: state.termCols, rows: state.termRows },
  resizeSamples: globalThis.__resizeProbe ? globalThis.__resizeProbe.samples.length : -1,
  probe: { maxGap: globalThis.__hangProbe.maxGap, longTasks: globalThis.__hangProbe.longTasks.length },
}))()`);
console.log(`before (${MODE}):`, JSON.stringify(before));

await evalx(`(() => { globalThis.__hangProbe.longTasks = []; globalThis.__hangProbe.maxGap = 0; globalThis.__hangProbe.rafSamples = 0; globalThis.__hangProbe.longTaskTotal = 0; if (globalThis.__resizeProbe) globalThis.__resizeProbe.samples = []; return true; })()`);

// Window drag simulation at real cadence: CDP metrics changes arrive
// back-to-back; the browser fires window resize at ~rAF frequency like a
// real drag. ~60 steps/sec for SECONDS.
const startW = 1600, startH = 1000;
const steps = SECONDS * 60;
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  const phase = Math.sin((i / steps) * Math.PI * 4);
  const w = Math.round(startW + phase * 220);
  const h = Math.round(startH + phase * 130);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false });
  await new Promise((r) => setTimeout(r, 16));
}
const dragMs = Date.now() - t0;

const after = await evalx(`(() => {
  const s = globalThis.__resizeProbe ? globalThis.__resizeProbe.samples : [];
  const sorted = s.slice().sort((a,b)=>b.ms-a.ms);
  const avg = s.length ? Math.round(s.reduce((a,x)=>a+x.ms,0)/s.length*10)/10 : 0;
  return {
    resizeCount: s.length,
    avgMs: avg,
    maxMs: s.length ? sorted[0].ms : 0,
    top10: sorted.slice(0,10).map(x=>x.ms),
    over100ms: s.filter(x=>x.ms>=100).length,
    over50ms: s.filter(x=>x.ms>=50).length,
    grid: { cols: state.termCols, rows: state.termRows },
    wsOpen: typeof termWs !== 'undefined' && termWs ? termWs.readyState : -1,
    probe: {
      maxGap: globalThis.__hangProbe.maxGap,
      rafSamples: globalThis.__hangProbe.rafSamples,
      longTasks: globalThis.__hangProbe.longTasks.length,
      longTaskTotal: Math.round(globalThis.__hangProbe.longTaskTotal),
      top5: globalThis.__hangProbe.longTasks.slice().sort((a,b)=>b-a).slice(0,5),
    },
  };
})()`);
console.log(`after (${MODE}):`, JSON.stringify(after));
console.log('drag loop:', JSON.stringify({ steps, ms: dragMs }));

check('terminal WS open through drag', after.wsOpen === 1, `readyState=${after.wsOpen}`);
check('no catastrophic stall (>5s no frame)', (after.probe.maxGap || 0) < 5000, `maxGap=${after.probe.maxGap}ms raf=${after.probe.rafSamples}`);
check('resize count tracks drag (grid changed)', after.resizeCount >= 20, `resizes=${after.resizeCount}`);
check('long task total under 4s', after.probe.longTaskTotal < 4000, `total=${after.probe.longTaskTotal}ms n=${after.probe.longTasks}`);
console.log(`per-resize: avg=${after.avgMs}ms max=${after.maxMs}ms over50ms=${after.over50ms} over100ms=${after.over100ms}`);
console.log('top resize ms:', JSON.stringify(after.top10));
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