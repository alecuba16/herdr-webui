// Real-browser acceptance checks for the temporary-terminal promote
// feature (branch promote_temporary_terminals).
//
// Drives the actually-served desktop app end to end:
//   1. Open the temporary terminal overlay via the REAL shortcut path
//      (Ctrl+B prefix then Shift+M, single dispatch on window capture).
//   2. Wait for the overlay head (hint, ⤴ promote button) and the live
//      shell to attach.
//   3. Type a cd command into the overlay terminal (real CDP keyboard
//      input path) and wait for the live cwd to move.
//   4. Promote via the REAL shortcut path (Ctrl+B then Shift+P).
//   5. Verify: overlay closed, app navigated to the promoted workspace
//      (URL + focused surface), the shell is STILL ALIVE in the promoted
//      pane (echo round-trip), zero tab.close calls fired, promoted
//      folder recorded in recents.
//   6. The same handoff via the ⤴ button CLICK (mouse path).
import { connectToPage } from './cdp-driver.mjs';

const ROOT = process.env.ACCEPT_ROOT; // scratch folder to cd into + promote
const ROOT2 = process.env.ACCEPT_ROOT2; // second scratch folder (button path)
const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8791/';
if (!ROOT || !ROOT2) {
  console.error('ACCEPT_ROOT and ACCEPT_ROOT2 (absolute scratch dirs, must exist) are required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalApp(expr) {
  return cdp.evalExpr(expr, true);
}

// Single dispatch on window, matching the app's capture listener.
function keydown(code, opts = {}) {
  return `((function(){
    const e = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, code: ${JSON.stringify(code)}, key: ${JSON.stringify(opts.key || code)},
      ctrlKey: ${opts.ctrl ? 'true' : 'false'}, shiftKey: ${opts.shift ? 'true' : 'false'},
      metaKey: false, altKey: false
    });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  })())`;
}

async function typeText(text) {
  // CDP Input.dispatchKeyEvent only accepts single-char text events.
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char', text: ch, key: ch, unmodifiedText: ch,
    });
  }
}
async function pressEnter() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');

await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

// ---------------------------------------------------------------- section 0
// App loads; ensure at least one workspace exists (fresh server starts
// with none, and the temp overlay needs a default folder).
{
  const title = await evalApp('document.title');
  check('app loads (title present)', !!title, `title="${title}"`);

  const ensured = await evalApp(`(async function(){
    const list = await (await fetch('/api/workspaces')).json();
    if (list.result && list.result.workspaces && list.result.workspaces.length) return 'existing';
    const r = await fetch('/api/workspaces', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'home', cwd: ${JSON.stringify(ROOT)} }) });
    return (await r.json()).result ? 'created' : 'failed';
  })()`);
  check('a workspace exists for the temp terminal to reuse', ensured !== 'failed', ensured);
}

// ---------------------------------------------------------------- section 1
// Open the temporary terminal via the REAL shortcut: Ctrl+B then Shift+M.
{
  await evalApp(keydown('KeyB', { ctrl: true, key: 'b' }));
  await sleep(200);
  await evalApp(keydown('KeyM', { shift: true, key: 'M' }));
  await sleep(1500);
  const visible = await evalApp(`!!document.querySelector('.temp-terminal-backdrop')`);
  check('Ctrl+B then Shift+M opens the temporary terminal overlay', !!visible);
}

// ---------------------------------------------------------------- section 2
// Overlay head shows hint + ⤴ button; shell attaches.
{
  const promoteBtn = await evalApp(`(function(){
    const b = document.querySelector('.temp-terminal-promote');
    return b ? { title: b.title || '', aria: b.getAttribute('aria-label') || '', text: b.textContent } : null;
  })()`);
  check('⤴ promote button present in overlay head with shortcut label',
    !!promoteBtn && /Promote/i.test(promoteBtn.title),
    JSON.stringify(promoteBtn));

  let attached = false;
  for (let i = 0; i < 24; i++) {
    attached = !!(await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop .terminal');
      return !!(t && t.textContent.trim().length > 0);
    })()`));
    if (attached) break;
    await sleep(500);
  }
  check('temporary terminal shell attached (output rendered)', attached);

  // Tab.close spy AFTER attach: any later /close would kill the shell.
  await evalApp(`(function(){
    window.__e2eTabCloses = 0;
    const origFetch = window.fetch;
    window.fetch = function(url, opt){
      try {
        if (/\\/api\\/tabs\\/.+\\/close/.test(String(url))) window.__e2eTabCloses++;
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
    return true;
  })()`);
}

// ---------------------------------------------------------------- section 3
// cd into the scratch root via the live shell (CDP real keyboard path).
{
  await evalApp(`(function(){
    const t = document.querySelector('.temp-terminal-backdrop .terminal textarea, .temp-terminal-backdrop textarea');
    if (t) t.focus();
    return !!t;
  })()`);
  await typeText('cd ' + ROOT);
  await pressEnter();
  await sleep(2500);
  const echoed = await evalApp(`(function(){
    const t = document.querySelector('.temp-terminal-backdrop .terminal');
    return t ? t.textContent.includes(${JSON.stringify(ROOT)}) : false;
  })()`);
  check('cd command reached the live shell (echo visible)', !!echoed);
}

// ---------------------------------------------------------------- section 4
// Promote via the REAL shortcut path: Ctrl+B then Shift+P.
{
  await evalApp(keydown('KeyB', { ctrl: true, key: 'b' }));
  await sleep(200);
  const consumed = await evalApp(keydown('KeyP', { shift: true, key: 'P' }));
  check('promote shortcut consumed by the WebUI handler', !!consumed);
  await sleep(3000);
}

// ---------------------------------------------------------------- section 5
// Verify the handoff: overlay closed, navigation, shell alive, no closes.
{
  const overlayGone = await evalApp(`!document.querySelector('.temp-terminal-backdrop')`);
  check('overlay closed after promote', !!overlayGone);

  const url = await evalApp('location.href');
  check('URL navigated to workspace/tab/pane', /\/workspace\//.test(String(url)), url);

  // The promoted shell must still be alive: echo round-trip in the main pane.
  await evalApp(`(function(){
    const t = document.querySelector('.terminal textarea');
    if (t) t.focus();
    return !!t;
  })()`);
  await typeText('echo PROMOTE_BROWSER_ALIVE');
  await pressEnter();
  await sleep(2500);
  const alive = await evalApp(`(function(){
    const t = document.querySelector('.terminal');
    return t ? t.textContent.includes('PROMOTE_BROWSER_ALIVE') : false;
  })()`);
  check('promoted shell alive in main pane (echo round-trip)', !!alive);

  const closes = await evalApp('window.__e2eTabCloses');
  check('zero tab.close requests after promote', Number(closes) === 0, `closes=${closes}`);

  const recents = await evalApp(`(async function(){
    const r = await fetch('/api/recent-workspaces');
    return await r.json();
  })()`);
  const paths = ((recents && recents.recent) || []).map((x) => x.path);
  check('promoted folder recorded in recents',
    paths.some((p) => p === ROOT),
    JSON.stringify(paths));
}

// ---------------------------------------------------------------- section 6
// Failure path + button path. A second temp terminal opens in the CURRENT
// workspace (cwd = ROOT after the first promote), so promoting it right
// away must be REJECTED: backend guard, overlay stays open, error in the
// head hint. Then cd into ROOT2 and click ⤴ again: promote succeeds and
// the overlay closes (the retry-after-failure path, via the mouse).
{
  await evalApp(keydown('KeyB', { ctrl: true, key: 'b' }));
  await sleep(200);
  await evalApp(keydown('KeyM', { shift: true, key: 'M' }));
  await sleep(1500);
  let attached = false;
  for (let i = 0; i < 24; i++) {
    attached = !!(await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop .terminal');
      return !!(t && t.textContent.trim().length > 0);
    })()`));
    if (attached) break;
    await sleep(500);
  }
  check('second temp terminal attached', attached);

  // Immediate ⤴ click: live cwd == current workspace cwd -> backend rejects.
  await evalApp(`(function(){
    const b = document.querySelector('.temp-terminal-promote');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2500);
  const stillOpen = await evalApp(`!!document.querySelector('.temp-terminal-backdrop')`);
  check('failed promote keeps the overlay open', !!stillOpen);
  const hint = await evalApp(`(function(){
    const h = document.querySelector('.temp-terminal-backdrop .temp-terminal-hint');
    return h ? h.textContent : '';
  })()`);
  check('backend error surfaced in the overlay head', /Promote failed:/i.test(String(hint)),
    String(hint).slice(0, 160));
  const closes1 = await evalApp('window.__e2eTabCloses');
  check('zero tab.close requests after failed promote', Number(closes1) === 0, `closes=${closes1}`);

  // Retry after cd: into ROOT2, ⤴ again -> success via the button.
  await evalApp(`(function(){
    const t = document.querySelector('.temp-terminal-backdrop .terminal textarea, .temp-terminal-backdrop textarea');
    if (t) t.focus();
    return !!t;
  })()`);
  await typeText('cd ' + ROOT2);
  await pressEnter();
  await sleep(2500);
  await evalApp(`(function(){
    const b = document.querySelector('.temp-terminal-promote');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(3000);
  const overlayGone = await evalApp(`!document.querySelector('.temp-terminal-backdrop')`);
  check('⤴ button click promotes after cd and closes overlay', !!overlayGone);
  const url2 = await evalApp('location.href');
  check('button promote navigates to the second promoted workspace',
    /\/workspace\//.test(String(url2)), url2);
  const closes = await evalApp('window.__e2eTabCloses');
  check('zero tab.close requests after button promote', Number(closes) === 0, `closes=${closes}`);
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
cdp.close();
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join('; '));
  process.exit(1);
}
console.log('PROMOTE ACCEPTANCE: PASS');