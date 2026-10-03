// Real-browser acceptance checks for the mobile terminal input model.
// Boots the app in a mobile viewport, opens the terminal screen, and
// verifies:
//   1. The terminal surface owns a writable wterm textarea.
//   2. Tapping the terminal surface focuses that textarea for direct input.
//   3. Typed text + Enter is delivered to the PTY and echoed by the shell.
//   4. The temporary terminal uses the same direct input path.
import { connectToPage, openApp } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
async function pressEnter() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

const cdp = await connectToPage();

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
// openApp enables Page/Network/Security, ignores the self-signed cert, and
// retries navigation: headless Chrome occasionally fails the first TLS
// handshake (net_error -202), which used to flake the whole suite at startup.
await openApp(cdp, URL);

const evalx = (expr) => cdp.evalExpr(expr, true);

// Wait for the mobile shell.
let mobileReady = false;
for (let i = 0; i < 30; i++) {
  mobileReady = await evalx('!!(window.HerdrMobile && document.getElementById("mobileScreen"))');
  if (mobileReady) break;
  await new Promise((r) => setTimeout(r, 300));
}
check('mobile shell present', mobileReady);
if (!mobileReady) process.exit(1);

// Create a workspace with a shell (any cwd works; the PTY spawns there).
const ws = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'mobile-input-e2e', cwd: ${JSON.stringify(process.env.E2E_REPO || process.cwd())} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
check('workspace created', !!(ws && ws.result && ws.result.workspace), JSON.stringify(ws).slice(0, 200));
await evalx('window.location.reload()');
await new Promise((r) => setTimeout(r, 2500));

// Select the workspace -> terminal screen (same production path as taps).
const opened = await evalx(`(async () => {
  try {
    await HerdrMobile.selectWorkspace(Object.keys((await (await fetch('/api/workspaces')).json()).result.workspaces || {})[0]);
    return true;
  } catch (e) { return String(e); }
})()`);
check('terminal screen opened', opened === true, String(opened));
await new Promise((r) => setTimeout(r, 1500));

const pencilButtonPresent = await evalx('!!document.getElementById("mobileTerminalInputButton")');
check('floating pencil button removed', !pencilButtonPresent);

// wterm's textarea is the direct mobile input target.
const textareaState = await evalx(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (!ta) return { found: false };
  return { found: true, readOnly: ta.readOnly, inputMode: ta.getAttribute('inputmode') };
})()`);
check('wterm textarea present', !!(textareaState && textareaState.found));
check('wterm textarea starts gated', !!(textareaState && textareaState.found && textareaState.readOnly === true), JSON.stringify(textareaState));

// Tap the terminal surface: wterm must focus its input textarea.
await evalx(`(() => {
  const el = document.getElementById('terminal');
  if (el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  }
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
const activeAfterTap = await evalx('document.activeElement && document.activeElement.tagName + "#" + (document.activeElement.id || "")');
check('tap on terminal focuses its textarea', /TEXTAREA/i.test(String(activeAfterTap)), activeAfterTap);
const textareaAfterTap = await evalx(`(() => {
  const input = document.querySelector('#terminal textarea');
  return input ? { readOnly: input.readOnly, active: document.activeElement === input } : null;
})()`);
check('tap enables writable terminal input', !!(textareaAfterTap && textareaAfterTap.readOnly === false && textareaAfterTap.active), JSON.stringify(textareaAfterTap));

// Type a command and press Enter via the terminal textarea; verify it reached the PTY.
await cdp.send('Input.insertText', { text: 'echo HERDR_MOBILE_INPUT_OK' });
await pressEnter();
// Wait for the shell to echo and execute.
let echoed = false;
let tailText = '';
for (let i = 0; i < 25; i++) {
  tailText = await evalx(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-300)`);
  if (tailText.includes('HERDR_MOBILE_INPUT_OK') && /HERDR_MOBILE_INPUT_OK[\s\S]*HERDR_MOBILE_INPUT_OK/.test(tailText)) {
    echoed = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
check('direct terminal input reaches PTY and echoes', echoed, tailText.slice(-160));

// Switching between mobile panels must not be undone by overlapping refreshes.
// This uses the production panel creation, selection, and refresh paths.
const initialPanelIds = await evalx(`(async () => {
  const selection = HerdrMobile.currentSelection();
  const response = await fetch('/api/tabs?workspace_id=' + encodeURIComponent(selection.ws));
  const body = await response.json();
  return (body.result && body.result.tabs || []).map((tab) => tab.tab_id);
})()`);
let panelCreated = false;
await evalx('HerdrMobile.createPanel()');
for (let i = 0; i < 25; i++) {
  const currentPanelIds = await evalx(`(async () => {
    const selection = HerdrMobile.currentSelection();
    const response = await fetch('/api/tabs?workspace_id=' + encodeURIComponent(selection.ws));
    const body = await response.json();
    return (body.result && body.result.tabs || []).map((tab) => tab.tab_id);
  })()`);
  panelCreated = Array.isArray(currentPanelIds) && currentPanelIds.length > (initialPanelIds || []).length;
  if (panelCreated) break;
  await new Promise((r) => setTimeout(r, 200));
}
check('second mobile panel created for stability check', panelCreated);

if (panelCreated) {
  const panelIds = await evalx(`(async () => {
    const selection = HerdrMobile.currentSelection();
    const response = await fetch('/api/tabs?workspace_id=' + encodeURIComponent(selection.ws));
    const body = await response.json();
    return (body.result && body.result.tabs || []).map((tab) => tab.tab_id);
  })()`);
  const selection = await evalx('HerdrMobile.currentSelection()');
  const scopedPanelId = (id) => String(id).startsWith(`${selection.ws}:`) ? String(id) : `${selection.ws}:${id}`;
  const firstPanel = scopedPanelId(panelIds[0]);
  const secondPanel = scopedPanelId(panelIds[1]);
  await evalx(`HerdrMobile.selectTab(${JSON.stringify(secondPanel)})`);
  await new Promise((r) => setTimeout(r, 500));
  const selectedSecond = await evalx('HerdrMobile.currentSelection()');
  // selectTab stores the tab_id form the last refresh loaded (scoped or
  // bare), so compare scope-normalized like the refresh-stability check
  // below, not raw strings.
  check('mobile panel selection moves to second panel', scopedPanelId(selectedSecond.tab) === secondPanel, JSON.stringify(selectedSecond));

  await evalx(`HerdrMobile.selectTab(${JSON.stringify(firstPanel)})`);
  await new Promise((r) => setTimeout(r, 500));
  await evalx('Promise.all(Array.from({ length: 6 }, () => HerdrMobile.refresh()))');
  const selectedAfterRefreshes = await evalx('HerdrMobile.currentSelection()');
  check(
    'mobile panel selection stays on first panel after refreshes',
    scopedPanelId(selectedAfterRefreshes.tab) === firstPanel,
    JSON.stringify(selectedAfterRefreshes),
  );
}

// Temporary terminal on mobile uses the same direct wterm input path.
await evalx(`HerdrMobile.runAction('temp-terminal')`);
let tempOpen = false;
for (let i = 0; i < 24; i++) {
  tempOpen = await evalx(`!!document.querySelector('.temp-terminal-backdrop .terminal') && ((document.querySelector('.temp-terminal-backdrop .terminal') || {}).textContent || '').trim().length > 0`);
  if (tempOpen) break;
  await new Promise((r) => setTimeout(r, 400));
}
check('temp terminal opens on mobile', tempOpen);
const tempActive = await evalx(`document.activeElement ? document.activeElement.tagName : 'none'`);
check('temp terminal does not autofocus its textarea', !/TEXTAREA/i.test(String(tempActive)), tempActive);
const tempTextarea = await evalx(`(() => {
  const input = document.querySelector('.temp-terminal-backdrop .terminal textarea');
  return input ? { readOnly: input.readOnly } : null;
})()`);
check('temp terminal textarea starts gated', !!(tempTextarea && tempTextarea.readOnly === true), JSON.stringify(tempTextarea));
await evalx(`(() => {
  const terminal = document.querySelector('.temp-terminal-backdrop .terminal');
  if (terminal) terminal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 100));
const tempAfterTap = await evalx(`(() => {
  const input = document.querySelector('.temp-terminal-backdrop .terminal textarea');
  return input ? { readOnly: input.readOnly, active: document.activeElement === input } : null;
})()`);
check('temp terminal tap enables writable input', !!(tempAfterTap && tempAfterTap.readOnly === false && tempAfterTap.active), JSON.stringify(tempAfterTap));
await cdp.send('Input.insertText', { text: 'echo TEMP_DIRECT_INPUT_OK' });
await pressEnter();
let tempEchoed = false;
let tempTail = '';
for (let i = 0; i < 25; i++) {
  tempTail = await evalx(`((document.querySelector('.temp-terminal-backdrop .term-grid') || {}).textContent || '').trim().slice(-200)`);
  if (/TEMP_DIRECT_INPUT_OK[\s\S]*TEMP_DIRECT_INPUT_OK/.test(tempTail)) { tempEchoed = true; break; }
  await new Promise((r) => setTimeout(r, 300));
}
check('temp direct input reaches PTY and echoes', tempEchoed, tempTail.slice(-120));

// Produce enough shell output to create real scrollback before testing the
// follow control. A single echoed command may fit in the viewport.
await cdp.send('Input.insertText', {
  text: 'seq 1 120 | sed "s/^/HERDR_SCROLL_/"',
});
await pressEnter();
let scrollbackMetrics = null;
for (let i = 0; i < 25; i++) {
  scrollbackMetrics = await evalx(`(() => {
    const terminal = document.querySelector('.temp-terminal-backdrop .terminal');
    return terminal ? { scrollHeight: terminal.scrollHeight, clientHeight: terminal.clientHeight } : null;
  })()`);
  if (scrollbackMetrics && scrollbackMetrics.scrollHeight > scrollbackMetrics.clientHeight) break;
  await new Promise((r) => setTimeout(r, 300));
}
check(
  'temp terminal creates scrollback for follow control',
  !!(scrollbackMetrics && scrollbackMetrics.scrollHeight > scrollbackMetrics.clientHeight),
  JSON.stringify(scrollbackMetrics),
);

// Scrolling up still exposes the follow pill without any input overlay.
await evalx(`(() => {
  const terminal = document.querySelector('.temp-terminal-backdrop .terminal');
  if (terminal) { terminal.scrollTop = 0; terminal.dispatchEvent(new Event('scroll', { bubbles: false })); }
  return true;
})()`);
let followVisible = false;
let followDetail = '';
for (let i = 0; i < 20; i++) {
  followDetail = await evalx(`(() => {
    const b = document.querySelector('.temp-terminal-backdrop .terminal-follow-button');
    const pencil = document.querySelector('.temp-terminal-backdrop .temp-terminal-input-button');
    if (!b) return 'missing';
    return JSON.stringify({ hidden: b.hidden, pencilPresent: !!pencil });
  })()`);
  try {
    const detail = JSON.parse(followDetail);
    if (!detail.hidden && detail.pencilPresent === false) { followVisible = true; break; }
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 300));
}
check('follow pill appears without pencil overlay', followVisible, followDetail);

await evalx(`(function(){ const c = document.querySelector('.temp-terminal-close'); if (c) c.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 300));
await evalx(`(function(){ const cc = document.querySelector('.temp-terminal-confirm-close'); if (cc) cc.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 500));
const followStillVisible = await evalx(`(() => { const b = document.querySelector('.temp-terminal-backdrop .terminal-follow-button'); return b ? !b.hidden : false; })()`);
check('temp terminal closes and resets follow state', !followStillVisible);

const failures = results.filter((r) => !r.ok).length;
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
