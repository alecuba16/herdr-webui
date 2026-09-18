// Ghostty core (wterm 0.5.0) acceptance check.
// Forces terminalCore=ghostty via localStorage, boots a workspace, and
// verifies the terminal attaches with the Ghostty core, renders rows,
// and shows the shell prompt. Runs over CDP against the served app.
// Usage: ACCEPT_REPO=... E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/ghostty-core-acceptance.mjs
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8893/';
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

// First load to reach localStorage, then force the ghostty core and reload.
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 1500));
await evalx(`(() => {
  const opts = { ...(JSON.parse(localStorage.getItem('herdr-web-options') || '{}')), terminalCore: 'ghostty' };
  localStorage.setItem('herdr-web-options', JSON.stringify(opts));
  return opts.terminalCore;
})()`);
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

const coreOption = await evalx(`(window.HerdrOptions && window.HerdrOptions.read ? window.HerdrOptions.read().terminalCore : (JSON.parse(localStorage.getItem('herdr-web-options')||'{}').terminalCore)) || '?'`);
check('terminalCore option is ghostty', coreOption === 'ghostty', `core=${coreOption}`);

// Create a workspace and enter it, like terminal-fit-acceptance.mjs.
const created = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ghostty-core-e2e', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('workspace created', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);

await evalx(`go(${JSON.stringify(wsId)})`);

// Wait until the terminal surface is attached and rendered.
let state = null;
for (let i = 0; i < 20 && !state; i++) {
  state = await evalx(`(async () => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
    return { terminalId: state.terminalId, rows: rows.length, text: text.slice(0, 200) };
  })()`);
  if (!state) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached with rendered rows', !!state, `state=${JSON.stringify(state)}`);
if (!state) process.exit(1);

let promptOk = false;
for (let i = 0; i < 20 && !promptOk; i++) {
  promptOk = await evalx(`(() => {
    const text = (document.querySelector('#terminal .term-grid') || {}).textContent || '';
    // zsh/starship prompts may use any of these glyphs.
    return text.includes('$') || text.includes('%') || text.includes('#') || text.includes('❯') || text.includes('➜');
  })()`);
  if (!promptOk) await new Promise((r) => setTimeout(r, 500));
}
const tailText = await evalx(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-160)`);
check('shell prompt rendered', promptOk === true, `tail=${JSON.stringify(String(tailText))}`);

const imageLayer = await evalx(`(() => {
  const layer = document.querySelector('#terminal .term-images');
  return layer ? 'present' : 'absent';
})()`);
check('ghostty graphics layer container present (0.5.0)', imageLayer === 'present', `layer=${imageLayer}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`ghostty-core acceptance: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);