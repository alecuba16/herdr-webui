// Step-5 E2E: a real jcode read-tool Kitty emit through a real webui pane.
// Boots the served app on an isolated server + headless Chrome, forces the
// terminal core via localStorage, starts `jcode serve` INSIDE the pane (so
// the server stdout is the pane PTY and TERM_PROGRAM=ghostty comes from the
// real pane env), then drives the real read tool over the debug socket and
// asserts the rendered result:
//   - ghostty core: a .term-image canvas appears (real Kitty render)
//   - wterm core: the [inline image omitted] placeholder appears
// Also asserts the visible grid text stays free of base64 payload leaks.
// A third LEGACY_MIGRATION=1 phase seeds a pre-Ghostty-default stored blob
// (terminalCore:"wterm" with no migration flag), asserts the app boots the
// Ghostty core anyway (one-time migration), and observes the real pane env
// (HERDR_WEBUI=1, TERM_PROGRAM=ghostty, KITTY_WINDOW_ID scrubbed) that the
// jcode-side HERDR_WEBUI protocol gate keys on for halfblocks rendering.
// Usage: TERMINAL_CORE=ghostty|wterm E2E_BASE_URL=... CDP_PORT=...
//        JCODE_IMG_E2E_RUNTIME_DIR=... PNG_PATH=... node scripts/e2e/jcode-image-flow-acceptance.mjs
//        (or LEGACY_MIGRATION=1 for the migration phase)
import { connectToPage } from './cdp-driver.mjs';
import { execFileSync } from 'node:child_process';

const MIGRATION = process.env.LEGACY_MIGRATION === '1';
const CORE = process.env.TERMINAL_CORE === 'wterm' && !MIGRATION ? 'wterm' : 'ghostty';
const LABEL = MIGRATION ? 'migrate-legacy' : CORE;
const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8895/';
const RUNTIME_DIR = process.env.JCODE_IMG_E2E_RUNTIME_DIR;
const PNG = process.env.PNG_PATH;
const JCODE = process.env.JCODE_BIN || '/Users/alejandro.blanco/.local/bin/jcode';
if (!RUNTIME_DIR || !PNG) {
  console.error('JCODE_IMG_E2E_RUNTIME_DIR and PNG_PATH are required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
function jcodeDebug(cmd, timeoutMs = 60000) {
  return execFileSync(JCODE, ['debug', cmd], {
    env: { ...process.env, JCODE_RUNTIME_DIR: RUNTIME_DIR },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

// First load to reach localStorage, then force the core and reload. The
// migration phase instead seeds the exact blob a pre-Ghostty-default
// browser carries: terminalCore "wterm" with no migration flag.
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 1500));
if (MIGRATION) {
  await cdp.evalExpr(`(() => {
    localStorage.setItem('herdr-web-options', JSON.stringify({ terminalCore: 'wterm' }));
    return 'seeded legacy wterm blob (no migration flag)';
  })()`, true);
} else {
  await cdp.evalExpr(`(() => {
    const opts = { ...(JSON.parse(localStorage.getItem('herdr-web-options') || '{}')), terminalCore: ${JSON.stringify(CORE)} };
    localStorage.setItem('herdr-web-options', JSON.stringify(opts));
    return opts.terminalCore;
  })()`, true);
}
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

if (MIGRATION) {
  // The running app must have migrated the legacy blob: the boot-time
  // normalize/save persists terminalCore:"ghostty" plus the migration
  // flag, and the Settings select agrees. The mounted adapter core is
  // proven later by the ghostty image render after the full flow runs.
  const mig = await cdp.evalExpr(`(() => {
    const blob = JSON.parse(localStorage.getItem('herdr-web-options') || '{}');
    const select = document.getElementById('optTerminalCore');
    return JSON.stringify({
      selectValue: select ? select.value : null,
      blobCore: blob.terminalCore,
      blobFlag: blob.terminalCoreGhosttyMigrated === true,
    });
  })()`, true);
  const m = JSON.parse(mig);
  check('legacy wterm blob migrated to ghostty default', m.blobCore === 'ghostty' && m.blobFlag === true && m.selectValue === 'ghostty', mig);
}

// Create a workspace on the scratch dir and enter it.
const created = await cdp.evalExpr(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'jcode-image-flow', cwd: ${JSON.stringify(RUNTIME_DIR)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`, true);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('workspace created', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);
await cdp.evalExpr(`go(${JSON.stringify(wsId)})`, true);
await new Promise((r) => setTimeout(r, 3000));

// Wait for a rendered prompt.
let promptOk = false;
for (let i = 0; i < 20 && !promptOk; i++) {
  promptOk = await cdp.evalExpr(`(() => {
    const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
    return text.includes('$') || text.includes('%') || text.includes('#') || text.includes('❯') || text.includes('➜');
  })()`, true);
  if (!promptOk) await new Promise((r) => setTimeout(r, 500));
}
check('shell prompt rendered', promptOk === true);

if (MIGRATION) {
  // Observe the real pane env before starting the server: the builtin
  // backend exports exactly the pair the jcode-side HERDR_WEBUI protocol
  // gate keys on (HERDR_WEBUI=1 + TERM_PROGRAM=ghostty, KITTY_WINDOW_ID
  // scrubbed), which is what keeps mermaid/math on halfblocks in panes.
  await cdp.evalExpr(`(() => {
    const el = document.getElementById('terminal');
    const a = el && el.__herdrTerminalAdapter;
    if (a) a.focus();
    const ta = el && el.querySelector('textarea');
    if (ta) ta.focus();
  })()`, true);
  await new Promise((r) => setTimeout(r, 200));
  // Plain string (not a template literal) so the shell parameter expansion
  // ${KITTY_WINDOW_ID:-unset} reaches the pane shell literally.
  await cdp.send('Input.insertText', { text: 'echo GATE=$HERDR_WEBUI TP=$TERM_PROGRAM KITTY=${KITTY_WINDOW_ID:-unset}' });
  await new Promise((r) => setTimeout(r, 300));
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise((r) => setTimeout(r, 1500));
  let gateText = '';
  for (let i = 0; i < 10; i++) {
    gateText = await cdp.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '')`, true);
    if (/GATE=1\b/.test(gateText)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const gateOk = /GATE=1\b/.test(gateText) && /TP=ghostty\b/.test(gateText) && /KITTY=unset/.test(gateText);
  check('pane env carries HERDR_WEBUI gate (TERM_PROGRAM=ghostty, no KITTY_WINDOW_ID)', gateOk,
    (gateText.match(/GATE=[^\s]* TP=[^\s]* KITTY=[^\s]*/) || ['not found']).toString());
}

// Start the real jcode server inside the pane. Its stdout IS the pane PTY,
// and TERM_PROGRAM=ghostty comes from the real pane env (step 4), not from
// the harness - the exact production relationship.
await cdp.evalExpr(`(() => {
  const el = document.getElementById('terminal');
  const a = el && el.__herdrTerminalAdapter;
  if (a) a.focus();
  const ta = el && el.querySelector('textarea');
  if (ta) ta.focus();
})()`, true);
await new Promise((r) => setTimeout(r, 200));
await cdp.send('Input.insertText', { text: `JCODE_RUNTIME_DIR=${JSON.stringify(RUNTIME_DIR)} JCODE_DEBUG_CONTROL=1 ${JCODE} serve --socket ${JSON.stringify(RUNTIME_DIR + '/jcode.sock')}` });
await new Promise((r) => setTimeout(r, 300));
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

// Wait host-side for the debug socket.
let socketUp = false;
for (let i = 0; i < 100 && !socketUp; i++) {
  try {
    jcodeDebug('server:info', 5000);
    socketUp = true;
  } catch (_) {
    if (i % 20 === 19) {
      // Timeline trace so serve failures are debuggable from the log.
      const tail = await cdp.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').slice(-150)`, true);
      console.log(`      [wait ${i}] pane tail: ${String(tail).replace(/\n/g, ' | ')}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!socketUp) {
  // Diagnosability: show what the pane actually rendered so serve failures
  // are debuggable from the log alone (mangled input, crash output, etc.).
  const paneDump = await cdp.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').slice(-400)`, true);
  check('jcode serve started inside pane (debug socket up)', false, `pane tail: ${String(paneDump).replace(/\n/g, ' | ')}`);
} else {
  check('jcode serve started inside pane (debug socket up)', true);
}
if (!socketUp) process.exit(1);

// Drive the REAL read tool over the debug socket. Its Kitty escapes land on
// the pane PTY -> webui ws -> adapter -> terminal core.
let readOk = false;
let readDetail = '';
try {
  const session = jcodeDebug(`create_session:${RUNTIME_DIR}`);
  check('debug session created', !!session, String(session).slice(0, 80));
  const out = jcodeDebug(`tool:read ${JSON.stringify({ file_path: PNG })}`);
  readOk = /Displayed in terminal/.test(String(out));
  readDetail = String(out).slice(0, 160);
} catch (e) {
  readDetail = String(e).slice(0, 160);
}
check('real read tool displayed the PNG in terminal', readOk, readDetail);
if (!readOk) process.exit(1);

// Wait for the browser to render (or substitute) the image.
let images = 0;
let placeholder = false;
for (let i = 0; i < 30 && images === 0 && !placeholder; i++) {
  ({ images, placeholder } = await cdp.evalExpr(`(() => {
    const grid = document.querySelector('#terminal .term-grid');
    const text = grid ? grid.textContent : '';
    return {
      images: document.querySelectorAll('#terminal .term-image').length,
      placeholder: /inline image omitted/.test(text),
    };
  })()`, true));
  if (images === 0 && !placeholder) await new Promise((r) => setTimeout(r, 500));
}

if (CORE === 'ghostty') {
  check('ghostty core rendered jcode PNG as image', images >= 1, `images=${images}`);
} else {
  check('wterm core substituted placeholder for jcode PNG', placeholder && images === 0, `placeholder=${placeholder} images=${images}`);
}

// The visible grid text must not leak base64 payload or escape framing.
const leakScan = await cdp.evalExpr(`(() => {
  const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
  return JSON.stringify({
    b64: /iVBORw0KGgo/.test(text),
    escG: text.includes('\\u001b_G') || text.includes('_Ga=T'),
  });
})()`, true);
const leaks = JSON.parse(leakScan);
check('no base64/escape leak in visible text', !leaks.b64 && !leaks.escG, leakScan);

// Agent-status hygiene: pane must still register sane status events (the
// server runs in the pane; the webui marks panes running known agents).
const paneStatus = await cdp.evalExpr(`(async () => {
  try {
    const r = await fetch('/api/panes');
    const j = await r.json();
    const panes = (j && (j.result && j.result.panes || j.panes)) || [];
    return JSON.stringify(panes.map((p) => ({ id: p.pane_id || p.id, status: p.agent_status })));
  } catch (e) { return 'err:' + e; }
})()`, true);
check('pane status API responds', !String(paneStatus).startsWith('err:'), String(paneStatus).slice(0, 120));

const failed = results.filter((r) => !r.ok);
console.log(`jcode-image-flow (${LABEL}): ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);