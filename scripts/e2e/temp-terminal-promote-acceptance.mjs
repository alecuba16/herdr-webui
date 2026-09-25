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
const ROOT3 = process.env.ACCEPT_ROOT3; // third scratch folder (mobile path)
const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8791/';
if (!ROOT || !ROOT2 || !ROOT3) {
  console.error('ACCEPT_ROOT, ACCEPT_ROOT2 and ACCEPT_ROOT3 (absolute scratch dirs, must exist) are required');
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
  // Require the marker twice (typed echo + executed output): the PTY
  // echoes typed input, so a single match can be the echo alone.
  const cdMarker1 = `CD_OK_D1_${Date.now()}`;
  await evalApp(`window.__cdMarker = ${JSON.stringify(cdMarker1)};`);
  await typeText(`cd ${ROOT} && echo ${cdMarker1}`);
  await pressEnter();
  let cdConfirmed1 = false;
  for (let i = 0; i < 30 && !cdConfirmed1; i++) {
    await sleep(400);
    cdConfirmed1 = await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop .terminal');
      const txt = t ? t.textContent : '';
      const m = window.__cdMarker || '';
      let idx = -1, count = 0;
      while ((idx = txt.indexOf(m, idx + 1)) !== -1) count++;
      return count >= 2;
    })()`);
  }
  check('cd executed in live shell (marker twice)', cdConfirmed1);
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
  const cdMarker2 = `CD_OK_D2_${Date.now()}`;
  await evalApp(`window.__cdMarker = ${JSON.stringify(cdMarker2)};`);
  await typeText(`cd ${ROOT2} && echo ${cdMarker2}`);
  await pressEnter();
  let cdConfirmed2 = false;
  for (let i = 0; i < 30 && !cdConfirmed2; i++) {
    await sleep(400);
    cdConfirmed2 = await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop .terminal');
      const txt = t ? t.textContent : '';
      const m = window.__cdMarker || '';
      let idx = -1, count = 0;
      while ((idx = txt.indexOf(m, idx + 1)) !== -1) count++;
      return count >= 2;
    })()`);
  }
  check('retry cd executed in live shell (marker twice)', cdConfirmed2);
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

// ---------------------------------------------------------------- section 7
// Mobile layout: same origin, localStorage forces the mobile app. Open the
// temp terminal via the T button, cd into ROOT (the second promote left
// the current workspace at ROOT2, so this is a fresh move), tap ⤴, and
// verify selectAgent navigation (URL pushState + terminal screen).
{
  await evalApp(`(function(){
    localStorage.setItem('herdr-web-layout', 'mobile');
    return true;
  })()`);
  await cdp.send('Page.navigate', { url: URL });
  await sleep(3500);

  const mobileBoot = await evalApp(`(function(){
    return {
      isMobileApp: !!document.querySelector('.mobile-app, #mobileApp, .mobile-nav, #mobileTempTerminal'),
      toggleBtn: !!document.getElementById('mobileTempTerminal'),
    };
  })()`);
  check('mobile layout app booted', !!mobileBoot.isMobileApp && !!mobileBoot.toggleBtn,
    JSON.stringify(mobileBoot));

  // The mobile app needs a workspace too (fresh page state after reload
  // shares the same backend, so the earlier ones are still there).
  const wsCount = await evalApp(`(async function(){
    const list = await (await fetch('/api/workspaces')).json();
    return list.result.workspaces.length;
  })()`);
  check('mobile sees workspaces', Number(wsCount) > 0, `count=${wsCount}`);

  await evalApp(`(function(){
    const b = document.getElementById('mobileTempTerminal');
    if (b) b.click();
    return !!b;
  })()`);
  let mobileAttached = false;
  for (let i = 0; i < 24; i++) {
    mobileAttached = !!(await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop .terminal');
      return !!(t && t.textContent.trim().length > 0);
    })()`));
    if (mobileAttached) break;
    await sleep(500);
  }
  check('mobile temp terminal attached via T button', mobileAttached);

  // cd into ROOT3: guaranteed no workspace sits there yet, so the promote
  // always moves the tab (the mobile page reloaded onto the workspace at
  // ROOT, and a same-cwd promote would be the rejected case).
  await evalApp(`(function(){
    const t = document.querySelector('.temp-terminal-backdrop .terminal textarea, .temp-terminal-backdrop textarea');
    if (t) t.focus();
    return !!t;
  })()`);
  // The PTY echoes typed input, so waiting for the marker text alone would
  // match the typed line itself. Require two occurrences (typed echo plus
  // actual shell output) before tapping ⤴, otherwise the promote can fire
  // while the shell still sits at ROOT and gets rejected as same-workspace.
  const cdMarker = `CD_OK_MOBILE_${Date.now()}`;
  await evalApp(`window.__cdMarker = ${JSON.stringify(cdMarker)};`);
  await typeText(`cd ${ROOT3} && echo ${cdMarker}`);
  await pressEnter();
  let cdConfirmed = false;
  for (let i = 0; i < 30 && !cdConfirmed; i++) {
    await sleep(400);
    cdConfirmed = await evalApp(`(function(){
      const t = document.querySelector('.temp-terminal-backdrop #terminal, .temp-terminal-backdrop .terminal');
      const txt = t ? t.textContent : '';
      const m = window.__cdMarker || '';
      if (!m) return false;
      let idx = -1, count = 0;
      while ((idx = txt.indexOf(m, idx + 1)) !== -1) count++;
      return count >= 2;
    })()`);
  }
  check('mobile cd confirmed by executed output', cdConfirmed);

  // Tap the ⤴ button (mobile has no keyboard prefix path).
  await evalApp(`(function(){
    const b = document.querySelector('.temp-terminal-promote');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(3000);
  const mobileOverlayGone = await evalApp(`!document.querySelector('.temp-terminal-backdrop')`);
  check('mobile ⤴ tap promotes and closes overlay', !!mobileOverlayGone);
  const mobileUrl = await evalApp('location.href');
  check('mobile selectAgent navigated to the promoted workspace',
    new RegExp('/workspace/[^/]+/tab/').test(String(mobileUrl)),
    mobileUrl);
  const mobileScreen = await evalApp(`(function(){
    // Mobile terminal container is #terminal (.mobile-terminal), not the
    // desktop .terminal class.
    const term = document.getElementById('terminal');
    return !!(term && term.textContent.trim().length > 0);
  })()`);
  check('mobile shows the terminal screen after promote', !!mobileScreen);
  // The promoted shell must still be alive on mobile too: echo round-trip
  // through the reconnected terminal.
  await evalApp(`(function(){
    const t = document.querySelector('#terminal textarea, #terminal .xterm-helper-textarea');
    if (t) t.focus();
    return !!t;
  })()`);
  await typeText('echo MOBILE_PROMOTE_ALIVE');
  await pressEnter();
  await sleep(2500);
  const mobileAlive = await evalApp(`(function(){
    const t = document.getElementById('terminal');
    return t ? t.textContent.includes('MOBILE_PROMOTE_ALIVE') : false;
  })()`);
  check('mobile promoted shell alive (echo round-trip)', !!mobileAlive);
  const recents3 = await evalApp(`(async function(){
    const r = await fetch('/api/recent-workspaces');
    return await r.json();
  })()`);
  const paths3 = ((recents3 && recents3.recent) || []).map((x) => x.path);
  check('mobile promote recorded in recents',
    paths3.some((p) => p === ROOT3),
    JSON.stringify(paths3));
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