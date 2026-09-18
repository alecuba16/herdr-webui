// External-backend graphics bridge acceptance (p6).
//
// Drives the real webui end to end against an ISOLATED herdr daemon:
//   1. External-herdr backend mode: create a workspace, get a shell pane.
//   2. Emit the same 1x1 f=32 Kitty RGB transmission the p2 probe used
//      (printf typed through CDP into the pane's PTY, so Ghostty
//      captures it as a graphics placement).
//   3. Assert the bridge canvas overlay draws the red pixel (canvas
//      pixel readback over CDP) while wterm keeps rendering text.
//   4. Repeat on a mobile viewport.
//   5. Teardown: close the browser page (a real tab close via CDP
//      Target.closeTarget) and assert no zombie shell client survived:
//      while attached the daemon's client socket carries the extra
//      connections, and after the close the daemon's own log must show
//      every client id detached/disconnected — herdr's
//      remove_client_and_resize_if_needed path (geometry restore) runs
//      exactly there.
//
// Requirements (see scripts/e2e/run-external-graphics-e2e.sh):
//   - isolated `herdr server` daemon (own XDG_CONFIG_HOME + HERDR_SESSION)
//   - the webui binary with --backend-mode external-herdr on that session
//   - headless Chrome on CDP_PORT
// Env-gated by the shell wrapper; CI stays daemon-free.
import { connectToPage, currentPageTargetId, closeTargetViaBrowser } from './cdp-driver.mjs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const REPO = process.env.ACCEPT_REPO;
if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture dir) is required');
  process.exit(2);
}
const DAEMON_PID = process.env.E2E_DAEMON_PID || '';
const CLIENT_SOCK = process.env.E2E_CLIENT_SOCK || '';
const BASELINE_CONNS = parseInt(process.env.E2E_BASELINE_CONNS || '1', 10);
const DAEMON_LOG = process.env.E2E_DAEMON_LOG || '';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

// printf command carrying the exact Kitty transmission from the p2 probe
// (protocol.rs kitty_rgb_emit_bytes): 1x1 f=32 RGBA transmit with explicit
// image id 7, then the display action. printf's FORMAT string interprets
// \033, so the typed command line stays plain ASCII for the shell.
const KITTY_PRINTF =
  "printf '\\033_Ga=T,f=32,t=d,i=7,p=3,s=1,v=1,c=1,r=1,q=2;/wAA/w==\\033\\\\\\033_Ga=p,U=1,i=7,c=1,r=1,q=2\\033\\\\'\n";

async function runViewport(label, cdp, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    mobile: width < 900,
    deviceScaleFactor: 1,
  });
  await cdp.send('Page.navigate', { url: BASE });
  await new Promise((r) => setTimeout(r, 2500));
  const title = await cdp.evalExpr('document.title');
  check(`${label}: app loads`, !!title, `title="${title}"`);

  // Backend must really be external for this server.
  const versions = await cdp.evalExpr(`fetch('/api/versions').then(r => r.json())`, true);
  check(
    `${label}: server runs external-herdr backend`,
    versions && versions.current_backend === 'external-herdr',
    `current_backend=${versions && versions.current_backend}`,
  );

  // Pin the browser to the external backend before creating anything.
  await cdp.evalExpr(`localStorage.setItem('herdr-session-backend', 'external-herdr')`);
  await cdp.send('Page.navigate', { url: BASE });
  await new Promise((r) => setTimeout(r, 2500));

  // Create the workspace on the fixture dir through the real API.
  const created = await cdp.evalExpr(`(async () => {
    try {
      const r = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'ext-graphics', cwd: ${JSON.stringify(REPO)} }),
      });
      return await r.json();
    } catch (e) { return { error: String(e) }; }
  })()`, true);
  const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
  if (!wsId) {
    // Maybe a workspace already exists from a prior run; reuse it.
    const existing = await cdp.evalExpr(`(async () => {
      const r = await fetch('/api/workspaces').then(x => x.json());
      const ws = (r.workspaces || r.result || []).filter(w => w.workspace_id);
      return ws.length ? ws[0].workspace_id : null;
    })()`, true);
    check(`${label}: workspace available`, !!existing, `create=${JSON.stringify(created).slice(0, 120)}`);
    if (!existing) return;
    // Navigate to the workspace by URL path; works on desktop and mobile.
    await cdp.send('Page.navigate', { url: BASE + 'workspace/' + encodeURIComponent(existing) });
  } else {
    check(`${label}: workspace created`, !!wsId, `ws=${wsId}`);
    // Navigate to the workspace by URL path; works on desktop and mobile.
    await cdp.send('Page.navigate', { url: BASE + 'workspace/' + encodeURIComponent(wsId) });
  }
  await new Promise((r) => setTimeout(r, 3000));

  // Mobile: the app boots on the Home screen; open the Terminal screen
  // (parseRoute also auto-selects it when the URL carries a tab/pane).
  if (width < 900) {
    await cdp.evalExpr(`(() => {
      const btn = document.querySelector('[data-screen="terminal"]');
      if (btn) btn.click();
      return !!btn;
    })()`, true);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Wait for a shell prompt in the attach terminal.
  let promptOk = false;
  for (let i = 0; i < 20 && !promptOk; i++) {
    promptOk = await cdp.evalExpr(`(() => {
      const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
      return text.includes('$') || text.includes('%') || text.includes('#') || text.includes('❯') || text.includes('➜');
    })()`, true);
    if (!promptOk) await new Promise((r) => setTimeout(r, 500));
  }
  check(`${label}: shell prompt rendered in attach terminal`, promptOk === true);
  if (!promptOk) return;

  // The bridge overlay must exist before the image is emitted.
  const pre = await cdp.evalExpr(`(() => {
    const overlay = document.querySelector('.term-graphics-overlay');
    return { overlay: !!overlay, w: overlay ? overlay.width : 0, h: overlay ? overlay.height : 0 };
  })()`, true);
  check(`${label}: graphics bridge overlay attached`, pre.overlay === true,
    `size=${pre.w}x${pre.h}`);
  if (!pre.overlay) return;

  // Type the printf command into the pane through the real input path.
  await cdp.evalExpr(`(() => {
    const a = document.getElementById('terminal').__herdrTerminalAdapter;
    if (a) a.focus();
    const ta = document.getElementById('terminal').querySelector('textarea');
    if (ta) ta.focus();
  })()`, true);
  await new Promise((r) => setTimeout(r, 200));
  await cdp.send('Input.insertText', { text: KITTY_PRINTF.slice(0, -1) });
  await new Promise((r) => setTimeout(r, 300));
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

  // Wait for the scene to arrive and the overlay to draw the red pixel.
  let stats = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    stats = await cdp.evalExpr(`(() => {
      const canvas = document.querySelector('.term-graphics-overlay');
      if (!canvas) return { overlay: false, painted: 0 };
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let painted = 0;
      let sample = null;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] !== 0) {
          painted++;
          if (!sample) sample = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        }
      }
      return { overlay: true, painted, sample };
    })()`, true);
    if (stats.painted > 0) break;
  }
  check(`${label}: overlay drew the kitty image`, stats && stats.painted > 0,
    `painted=${stats ? stats.painted : 0}`);
  check(
    `${label}: drawn pixel is the red RGBA asset`,
    !!stats && !!stats.sample &&
      stats.sample[0] === 255 && stats.sample[1] === 0 &&
      stats.sample[2] === 0 && stats.sample[3] === 255,
    `sample=${JSON.stringify(stats && stats.sample)}`,
  );

  // The rendered command line legitimately contains the printf source, but
  // the RAW escape payload (actual \u001b_G bytes) must never leak into
  // the visible grid: the pane's PTY consumes the transmission.
  const leak = await cdp.evalExpr(`(() => {
    const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
    return { leaked: text.includes('\u001b_G'), rows: document.querySelectorAll('#terminal .term-row').length };
  })()`, true);
  check(`${label}: wterm text still renders without escape leak`,
    leak.rows > 0 && !leak.leaked, `rows=${leak.rows} leaked=${leak.leaked}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

// Daemon-side connection count on the client socket. lsof on macOS shows
// EVERY fd (the listener, accepted connections, AND dup'd writer clones)
// with the socket path, so raw line counts overcount: the same connection
// appears once per fd. Dedupe by the unix-socket device address (the NODE
// column): one distinct address = one socket endpoint on the daemon side.
function daemonConnCount() {
  if (!DAEMON_PID || !CLIENT_SOCK) return -1;
  try {
    const out = execFileSync('lsof', ['-U', '-a', '-p', DAEMON_PID], { encoding: 'utf8' });
    const nodes = new Set();
    for (const line of out.split('\n')) {
      if (!line.includes(CLIENT_SOCK)) continue;
      // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME.
      // The socket's device address is field 5 (e.g. 0x8ce5...): distinct
      // per socket endpoint, shared by dup'd fds of the same connection.
      const fields = line.trim().split(/\s+/);
      const node = fields[5];
      if (node) nodes.add(node);
    }
    return nodes.size;
  } catch (_) {
    return -1;
  }
}

await runViewport('desktop', cdp, { width: 1600, height: 1000 });
await runViewport('mobile', cdp, { width: 414, height: 896 });

// Teardown acceptance: closing the browser page drops the attach WS and the
// graphics WS. The webui forwards ClientMessage::Detach on both, herdr
// removes the clients (restoring tab geometry), and the sockets close.
//
// Two oracles:
//  1. lsof fd count on the daemon's client socket WHILE attached: the
//     listener + attach + graphics bridge connections must be live
//     (proves the measurement point is really attached).
//  2. The daemon's own server log after the close: every client id that
//     ever connected must have a matching "client detached" or
//     "client disconnected" line — herdr's remove_client_and_resize_if_
//     needed path runs exactly there, so a missing line means a zombie
//     shell client still holds the pinned tab's geometry. (fd-level state
//     on the daemon side is upstream hygiene and out of scope: the webui
//     drops all of its own fds either way.)
//
// Measure while the mobile page is still attached (BEFORE clearing the
// device-metrics override: clearing it re-layouts the page and cycles the
// WS connections, which would race the count).
if (DAEMON_PID && CLIENT_SOCK) {
  const duringCount = daemonConnCount();
  check('teardown: browser holds daemon connections while attached',
    duringCount >= BASELINE_CONNS + 2,
    `conns=${duringCount} baseline=${BASELINE_CONNS} (+attach +graphics)`);

  // Close the page target itself (a real tab close — Page.navigate can be
  // deferred by the page, which would keep the WSes alive). Both browser
  // WS connections drop and the webui must tear its daemon connections
  // down. The daemon processes each Detach asynchronously (page close ->
  // WS close -> webui reader wakes -> Detach -> daemon select loop), so
  // poll the log until every client id that ever connected shows a
  // removal line.
  const targetId = await currentPageTargetId();
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  if (targetId) {
    await closeTargetViaBrowser(targetId);
  } else {
    console.log('no page target id found; falling back to navigation teardown');
    await cdp.send('Page.navigate', { url: 'about:blank' });
  }
  await new Promise((r) => setTimeout(r, 500));

  if (DAEMON_LOG) {
    const readLog = () => {
      try {
        return execFileSync('tail', ['-c', '1048576', DAEMON_LOG], { encoding: 'utf8' });
      } catch (e) {
        console.log('daemon log unreadable: ' + e.message);
        return '';
      }
    };
    const zombiesIn = (logTail) => {
      const connected = new Set();
      const removed = new Set();
      for (const m of logTail.matchAll(/client connected client_id=(\d+)/g)) {
        connected.add(m[1]);
      }
      for (const m of logTail.matchAll(/client (?:detached|disconnected) client_id=(\d+)/g)) {
        removed.add(m[1]);
      }
      return { connected, removed, zombies: [...connected].filter((id) => !removed.has(id)) };
    };
    let state = zombiesIn(readLog());
    for (let i = 0; i < 20 && state.zombies.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      state = zombiesIn(readLog());
    }
    check('teardown: every daemon client detached after page close',
      state.zombies.length === 0,
      `connected=${state.connected.size} removed=${state.removed.size} zombies=${state.zombies.length}` +
        (state.zombies.length ? ` ids=${state.zombies.join(',')}` : ''));
  } else {
    console.log('zombie-client log check skipped (E2E_DAEMON_LOG not set)');
  }
} else {
  console.log('teardown check skipped (E2E_DAEMON_PID/E2E_CLIENT_SOCK not set)');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

const failed = results.filter((r) => !r.ok);
console.log(`\nexternal graphics bridge acceptance: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED checks:');
  failed.forEach((f) => console.error(`  - ${f.name} ${f.detail}`));
  process.exit(1);
}
process.exit(0);