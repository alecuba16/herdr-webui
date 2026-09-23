// Live resize acceptance: resizing the browser terminal must NOT tear down
// and reopen the terminal WebSocket. The desktop terminal sends a live
// {"type":"resize"} message on the open socket instead (the reconnect path
// replays up to 8MB of scrollback and is the visible "flicker at the tail").
//
// Checks, driving the real UI in headless Chrome over CDP:
//   1. Installs a WebSocket open/close probe BEFORE the app loads.
//   2. Creates a workspace over the API and waits for its terminal to attach.
//   3. Resizes the window (grid change). Asserts:
//      - the terminal socket was NOT reconnected (zero opens after attach),
//      - the grid follows the new window size,
//      - the pty agrees with the browser grid (`stty size` output matches),
//      - the loading overlay never flashes (no re-attach).
//   4. A second resize back repeats the same checks.
// Usage: ACCEPT_REPO=... E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/live-resize-acceptance.mjs
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

// 1. Install the probe as a new-document script, BEFORE the app loads, so
// it survives the navigation into the app. The probe counts /ws/terminal
// opens/closes (exact query boundary: /ws/terminal-graphics is the Kitty
// bridge and must not be counted) and terminalLoading flashes.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__wsProbe = { opens: 0, closes: 0, loadingShows: 0 };
    const NativeWS = WebSocket;
    const WrappedWS = function (url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      // Exact terminal socket: /ws/terminal?terminal_id=... (the graphics
      // bridge uses /ws/terminal-graphics?tab_id=...).
      if (String(url).includes('/ws/terminal?')) {
        globalThis.__wsProbe.opens += 1;
        ws.addEventListener('close', () => { globalThis.__wsProbe.closes += 1; });
      }
      return ws;
    };
    try {
      WrappedWS.prototype = NativeWS.prototype;
      Object.setPrototypeOf(WrappedWS, NativeWS);
      WrappedWS.OPEN = NativeWS.OPEN;
      WrappedWS.CONNECTING = NativeWS.CONNECTING;
      WrappedWS.CLOSING = NativeWS.CLOSING;
      WrappedWS.CLOSED = NativeWS.CLOSED;
      window.WebSocket = WrappedWS;
    } catch (e) {}
  })();
` });

// 2. Load the app under the probe.
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

// Create a workspace over the API and wait for the terminal to attach.
const created = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'live-resize-e2e', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) finish();

// Select the workspace so the terminal attaches.
await evalx(`go(${JSON.stringify(wsId)})`);
await new Promise((r) => setTimeout(r, 1000));

// Wait until the terminal is attached and rendered (grid in state).
let attached = null;
for (let i = 0; i < 20 && !attached; i++) {
  attached = await evalx(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows };
  })()`);
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached with rendered rows', !!attached, `state=${JSON.stringify(attached)}`);
if (!attached) finish();

// Hook terminalLoading AFTER attach so only resize-driven flashes count.
await evalx(`(() => {
  const loading = document.getElementById('terminalLoading');
  if (loading) {
    globalThis.__wsProbe.loadingShows = 0;
    new MutationObserver(() => {
      if (loading.classList.contains('show')) globalThis.__wsProbe.loadingShows += 1;
    }).observe(loading, { attributes: true, attributeFilter: ['class'] });
  }
  return true;
})()`);

// Baseline after settle: boot/select may legitimately cycle the socket a
// few times (target changes as state populates). The regression invariant
// is the DELTA across the resizes, so reset the counters now and confirm
// the connection is stable (no further churn without user action).
await new Promise((r) => setTimeout(r, 1500));
await evalx(`(() => { globalThis.__wsProbe.opens = 0; globalThis.__wsProbe.closes = 0; return true; })()`);
await new Promise((r) => setTimeout(r, 1000));
const baseline = await evalx(`globalThis.__wsProbe`);
check('terminal connection stable after attach', baseline.opens === 0 && baseline.closes === 0,
  `opens=${baseline.opens} closes=${baseline.closes}`);
if (baseline.opens !== 0 || baseline.closes !== 0) finish();

// 3. Ground-truth the pty size by typing `stty size` into the terminal and
// reading the echoed output from the DOM. CDP key events go to the focused
// element, so focus the terminal first (the app routes focus to wterm's
// hidden textarea), then type through the real keyboard pipeline.
async function ptySizeViaStty() {
  await evalx(`(() => {
    const adapter = document.getElementById('terminal') && document.getElementById('terminal').__herdrTerminalAdapter;
    if (adapter && adapter.focus) adapter.focus();
    return !!adapter;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  for (const ch of 'stty size\r') {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      key: ch === '\r' ? 'Enter' : ch,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ch === '\r' ? 'Enter' : ch,
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 900));
  // Read the rendered rows directly: #terminal.innerText can come back
  // blank in headless Chrome even when rows have content (rows render text
  // through positioned spans), so scan .term-row textContent instead.
  // stty size prints "ROWS COLS"; find the newest row matching it.
  const rowsText = await evalx(`(() => {
    const t = document.getElementById('terminal');
    if (!t) return [];
    return Array.from(t.querySelectorAll('.term-row'))
      .map((r) => (r.textContent || '').trim())
      .filter(Boolean);
  })()`);
  // The newest `stty size` output is the LAST row matching "ROWS COLS";
  // rows after it (the next prompt) do not match the pattern.
  let m = null;
  for (let i = rowsText.length - 1; i >= 0; i--) {
    m = rowsText[i].match(/^(\d+)\s+(\d+)$/);
    if (m) break;
  }
  return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
}

// Window resize helper: Emulation.setDeviceMetricsOverride drives a real
// layout change, so the app's resize listeners fire and the grid changes.
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  // Let the RAF-debounced resize listeners settle.
  await new Promise((r) => setTimeout(r, 800));
}

// Browser-side grid straight from the app state (same page scope).
async function gridFromState() {
  return evalx(`(state.termCols && state.termRows ? { cols: state.termCols, rows: state.termRows } : null)`);
}

const gridBefore = await gridFromState();
check('grid visible before resize', !!gridBefore, `grid=${JSON.stringify(gridBefore)}`);
const ptyBefore = await ptySizeViaStty();
check('pty matches grid before resize', !!ptyBefore && !!gridBefore &&
  ptyBefore.cols === gridBefore.cols && ptyBefore.rows === gridBefore.rows,
  `pty=${ptyBefore && ptyBefore.cols + 'x' + ptyBefore.rows} grid=${gridBefore && gridBefore.cols + 'x' + gridBefore.rows}`);

// Resize 1: smaller window. Grid must follow; socket must NOT cycle.
await setViewport(1100, 800);
const probe1 = await evalx(`globalThis.__wsProbe`);
const grid1 = await gridFromState();
check('resize 1: no reconnect', probe1.opens === 0 && probe1.closes === 0,
  `opens=${probe1.opens} closes=${probe1.closes}`);
check('resize 1: grid changed', !!grid1 && !!gridBefore &&
  (grid1.cols !== gridBefore.cols || grid1.rows !== gridBefore.rows),
  `before=${gridBefore && gridBefore.cols + 'x' + gridBefore.rows} after=${grid1 && grid1.cols + 'x' + grid1.rows}`);
check('resize 1: no loading overlay flash', probe1.loadingShows === 0, `shows=${probe1.loadingShows}`);
const pty1 = await ptySizeViaStty();
check('resize 1: pty matches new grid', !!pty1 && !!grid1 &&
  pty1.cols === grid1.cols && pty1.rows === grid1.rows,
  `pty=${pty1 && pty1.cols + 'x' + pty1.rows} grid=${grid1 && grid1.cols + 'x' + grid1.rows}`);

// Resize 2: back to the original window size. Same invariants.
await setViewport(1600, 1000);
const probe2 = await evalx(`globalThis.__wsProbe`);
const grid2 = await gridFromState();
check('resize 2: no reconnect', probe2.opens === 0 && probe2.closes === 0,
  `opens=${probe2.opens} closes=${probe2.closes}`);
check('resize 2: grid changed', !!grid2 && !!grid1 &&
  (grid2.cols !== grid1.cols || grid2.rows !== grid1.rows),
  `before=${grid1 && grid1.cols + 'x' + grid1.rows} after=${grid2 && grid2.cols + 'x' + grid2.rows}`);
check('resize 2: no loading overlay flash', probe2.loadingShows === 0, `shows=${probe2.loadingShows}`);
const pty2 = await ptySizeViaStty();
check('resize 2: pty matches new grid', !!pty2 && !!grid2 &&
  pty2.cols === grid2.cols && pty2.rows === grid2.rows,
  `pty=${pty2 && pty2.cols + 'x' + pty2.rows} grid=${grid2 && grid2.cols + 'x' + grid2.rows}`);

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('FAILED checks:');
    for (const f of failed) console.error(` - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}
finish();