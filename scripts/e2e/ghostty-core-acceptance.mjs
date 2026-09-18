// Ghostty core (wterm 0.5.0) acceptance check.
// Forces terminalCore=<core> via localStorage, boots a workspace, and
// verifies the terminal attaches, renders rows, shows the shell prompt,
// and (ghostty core) renders a real Kitty graphics image / (wterm core)
// substitutes the placeholder. Runs over CDP against the served app.
// Usage: ACCEPT_REPO=... TERMINAL_CORE=ghostty|wterm E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/ghostty-core-acceptance.mjs
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8893/';
const CORE = process.env.TERMINAL_CORE === 'wterm' ? 'wterm' : 'ghostty';
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
  const opts = { ...(JSON.parse(localStorage.getItem('herdr-web-options') || '{}')), terminalCore: ${JSON.stringify(CORE)} };
  localStorage.setItem('herdr-web-options', JSON.stringify(opts));
  return opts.terminalCore;
})()`);
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

const coreOption = await evalx(`(window.HerdrOptions && window.HerdrOptions.read ? window.HerdrOptions.read().terminalCore : (JSON.parse(localStorage.getItem('herdr-web-options')||'{}').terminalCore)) || '?'`);
check(`terminalCore option is ${CORE}`, coreOption === CORE, `core=${coreOption}`);

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

const adapterInfo = await evalx(`(() => {
  const el = document.getElementById('terminal');
  const a = el && el.__herdrTerminalAdapter;
  if (!a) return 'no adapter';
  return JSON.stringify({ core: a.core, allowKitty: !!(a._imageFallbackState && a._imageFallbackState.allowKittyGraphics) });
})()`);
const adapterOk = /"core":"ghostty"/.test(String(adapterInfo)) && /"allowKitty":true/.test(String(adapterInfo));
check(
  `adapter reports ${CORE} core with correct kitty gate`,
  CORE === 'ghostty' ? adapterOk : /"core":"wterm"/.test(String(adapterInfo)) && !(/"allowKitty":true/.test(String(adapterInfo))),
  String(adapterInfo),
);

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

// Emit a real Kitty graphics transmit + placement through the live shell
// (the real path: pane stdout -> ws -> adapter -> Ghostty core). Focus the
// terminal textarea, insert the printf with ANSI-C quoting (zsh turns
// $'\\033' into a raw ESC), and press Enter. The payload is the exact
// 10x5 direct-RGBA form verified live against herdr 0.9.0 in round 3:
// a=T,f=32,t=d with raw RGBA base64, then an a=p placement.
await evalx(`(() => {
  const el = document.getElementById('terminal');
  const a = el && el.__herdrTerminalAdapter;
  if (a) a.focus();
  const ta = el && el.querySelector('textarea');
  if (ta) ta.focus();
  return (document.activeElement && document.activeElement.tagName + ':' + (document.activeElement.getAttribute('tabindex') || '')) || 'none';
})()`);
await new Promise((r) => setTimeout(r, 300));
const kittyCmd = `printf '%s' $'\\033_Ga=T,f=32,t=d,i=7,p=3,s=2,v=2,c=10,r=5,q=2;/wAA//8AAP//AAD//wAA/w==\\033\\\\' $'\\033_Ga=p,i=7,p=3,c=10,r=5,z=0,C=1,q=2\\033\\\\'`;
await cdp.send('Input.insertText', { text: kittyCmd });
await new Promise((r) => setTimeout(r, 300));
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await new Promise((r) => setTimeout(r, 300));

let images = 0;
let placeholder = false;
for (let i = 0; i < 20 && images === 0 && !placeholder; i++) {
  images = await evalx(`document.querySelectorAll('#terminal .term-image').length`);
  placeholder = await evalx(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').includes('inline image omitted: Kitty')`);
  if (images === 0 && !placeholder) await new Promise((r) => setTimeout(r, 500));
}
const postEmitTail = await evalx(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-400)`);
if (CORE === 'ghostty') {
  check('kitty image rendered on ghostty core', images > 0 && !placeholder, `images=${images} placeholder=${placeholder}`);
} else {
  check('kitty placeholder substituted on wterm core', placeholder && images === 0, `images=${images} placeholder=${placeholder}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${CORE}-core image acceptance: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);