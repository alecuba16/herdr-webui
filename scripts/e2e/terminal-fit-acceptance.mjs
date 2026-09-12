// Terminal fill + panel-switch refit acceptance checks.
// Drives the real UI in headless Chrome over CDP:
//   1. Creates a workspace over the API and waits for its terminal to attach.
//   2. The terminal surface fills the shell horizontally and vertically
//      (accounting for the 8px shell padding), with cols/rows matching.
//   3. Switching to the Git drawer and back refills the terminal.
//   4. Switching to the Files browser and back refills the terminal.
//   5. Sidebar toggle (shell width change without window resize) refits.
// Usage: ACCEPT_REPO=... E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/terminal-fit-acceptance.mjs
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
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

async function evalx(expr) {
  return cdp.evalExpr(expr, true);
}

function boxExpr(id) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display };
  })()`;
}

async function box(id) {
  return cdp.evalExpr(boxExpr(id));
}

const PAD = 16; // 8px shell padding each side
function fillChecks(tag, shell, term, cell, cols, rows) {
  const horizGap = Math.abs(shell.w - term.w - PAD);
  const vertGap = shell.h - (term.h + PAD);
  check(`${tag}: terminal fills shell horizontally`, horizGap <= 1.5, `shell=${shell.w} term=${term.w}`);
  // fitTerminalSurface aligns the surface height to whole terminal rows: at
  // most one row of reserved gap at the bottom is the designed contract
  // (it stops wterm's follow-scroll and scrollToBottom fighting on every
  // frame). Anything larger means the surface stopped filling the shell.
  check(
    `${tag}: terminal fills shell vertically`,
    vertGap >= -1 && vertGap < cell.height,
    `shell=${shell.h} term=${term.h} gap=${vertGap.toFixed(1)} row=${cell.height.toFixed(1)}`
  );
  const expectedCols = Math.floor((shell.w - PAD) / cell.width);
  const expectedRows = Math.floor((shell.h - PAD) / cell.height);
  check(`${tag}: cols match shell width`, Math.abs(cols - expectedCols) <= 1, `cols=${cols} expected≈${expectedCols}`);
  check(`${tag}: rows match shell height`, Math.abs(rows - expectedRows) <= 1, `rows=${rows} expected≈${expectedRows}`);
}

// Create a workspace over the API and wait for the terminal to attach.
const created = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'terminal-fit-e2e', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && (created.result && created.result.workspace && created.result.workspace.workspace_id);
check('workspace created', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);

await evalx(`go(${JSON.stringify(wsId)})`);
await new Promise((r) => setTimeout(r, 3000));

// Wait until the terminal surface is attached and rendered.
let state = null;
for (let i = 0; i < 20 && !state; i++) {
  state = await evalx(`(async () => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, cols: state.termCols, rows: state.termRows };
  })()`);
  if (!state) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached with rendered rows', !!state, `state=${JSON.stringify(state)}`);
if (!state) process.exit(1);

// 1. Fill checks on the pristine shell.
{
  const shell = await box('terminalShell');
  const term = await box('terminal');
  const cell = await evalx('HerdrTerminalFit.cellSize(term, document.getElementById("terminal"), { width: 9, height: 20 })');
  fillChecks('initial', shell, term, cell, state.cols, state.rows);
}

// 2. Git drawer open and back.
await evalx(`openWorkspaceGitUi(state.ws, { forceOpen: true })`);
await new Promise((r) => setTimeout(r, 1500));
let gitVisible = await evalx('!!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible())');
check('git drawer opens', gitVisible === true);
await evalx('showTerminalShellMode({})');
await new Promise((r) => setTimeout(r, 1200));
{
  const shell = await box('terminalShell');
  const term = await box('terminal');
  const after = await evalx('({ cols: state.termCols, rows: state.termRows })');
  const cell = await evalx('HerdrTerminalFit.cellSize(term, document.getElementById("terminal"), { width: 9, height: 20 })');
  fillChecks('after git drawer close', shell, term, cell, after.cols, after.rows);
}

// 3. Files browser open and back.
await evalx(`openWorkspaceFileBrowser(state.ws, { forceOpen: true })`);
await new Promise((r) => setTimeout(r, 1500));
let filesVisible = await evalx('!!(window.HerdrFileBrowser && window.HerdrFileBrowser.isVisible && window.HerdrFileBrowser.isVisible())');
check('file browser opens', filesVisible === true);
await evalx('showTerminalShellMode({})');
await new Promise((r) => setTimeout(r, 1200));
{
  const shell = await box('terminalShell');
  const term = await box('terminal');
  const after = await evalx('({ cols: state.termCols, rows: state.termRows })');
  const cell = await evalx('HerdrTerminalFit.cellSize(term, document.getElementById("terminal"), { width: 9, height: 20 })');
  fillChecks('after file browser close', shell, term, cell, after.cols, after.rows);
}

// 4. Sidebar toggle changes shell width without a window resize.
{
  const before = await box('terminalShell');
  await evalx('document.getElementById("sidebarToggle").click()');
  await new Promise((r) => setTimeout(r, 1200));
  const during = await box('terminalShell');
  const termDuring = await box('terminal');
  const after = await evalx('({ cols: state.termCols, rows: state.termRows })');
  const cell = await evalx('HerdrTerminalFit.cellSize(term, document.getElementById("terminal"), { width: 9, height: 20 })');
  check('sidebar toggle changes shell width', Math.abs(during.w - before.w) > 50, `before=${before.w} after=${during.w}`);
  fillChecks('after sidebar toggle', during, termDuring, cell, after.cols, after.rows);
  // Toggle back.
  await evalx('document.getElementById("sidebarToggle").click()');
  await new Promise((r) => setTimeout(r, 1200));
  const restored = await box('terminalShell');
  const termRestored = await box('terminal');
  const restoredState = await evalx('({ cols: state.termCols, rows: state.termRows })');
  const cell2 = await evalx('HerdrTerminalFit.cellSize(term, document.getElementById("terminal"), { width: 9, height: 20 })');
  check('sidebar restored to original width', Math.abs(restored.w - before.w) <= 1, `before=${before.w} restored=${restored.w}`);
  fillChecks('after sidebar restore', restored, termRestored, cell2, restoredState.cols, restoredState.rows);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `terminal fit acceptance: ${failed} FAILED of ${results.length}` : `terminal fit acceptance: all ${results.length} checks passed`);
// The CDP websocket keeps the node event loop alive; close it or the runner
// hangs after the last check.
cdp.close();
process.exitCode = failed ? 1 : 0;