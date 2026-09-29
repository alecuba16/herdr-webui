// Real-browser acceptance checks for the mobile terminal input model.
// Boots the app in a mobile viewport, opens the terminal screen, and
// verifies:
//   1. The floating pencil button exists.
//   2. Tapping the terminal surface does NOT focus wterm's hidden textarea
//      (no spontaneous on-screen keyboard / no focus fights).
//   3. Pressing the pencil opens the input sheet and focuses its input.
//   4. Typed text + Enter is delivered to the PTY and echoed by the shell
//      (input goes via the sheet, never directly to the terminal).
//   5. Escape closes the sheet; wterm's textarea stays readonly.
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

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

const pencilPresent = await evalx('!!document.getElementById("mobileTerminalInputButton")');
check('floating pencil button present', pencilPresent);

// wterm hidden textarea is gated readonly.
const textareaState = await evalx(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (!ta) return { found: false };
  return { found: true, readOnly: ta.readOnly };
})()`);
check('wterm textarea present', !!(textareaState && textareaState.found));
check('wterm textarea readonly (input gated)', !!(textareaState && textareaState.found && textareaState.readOnly === true), JSON.stringify(textareaState));

// Tap the terminal surface: activeElement must not become the textarea.
await evalx(`(() => {
  const el = document.getElementById('terminal');
  if (el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  }
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
const activeAfterTap = await evalx('document.activeElement && document.activeElement.tagName + "#" + (document.activeElement.id || "")');
check('tap on terminal does not focus its textarea', !/TEXTAREA/i.test(String(activeAfterTap)), activeAfterTap);

// Open the input sheet via the pencil.
const sheetOpened = await evalx(`(() => {
  const btn = document.getElementById('mobileTerminalInputButton');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
check('pencil opens input sheet', sheetOpened);
const sheetState = await evalx(`(() => {
  const sheet = document.getElementById('mobileTerminalInputSheet');
  const input = document.getElementById('mobileTerminalInput');
  return {
    sheetVisible: !!sheet && !sheet.hidden,
    inputPresent: !!input,
    inputFocused: !!input && document.activeElement === input,
  };
})()`);
check('input sheet visible', !!(sheetState && sheetState.sheetVisible));
check('input field focused (keyboard intent)', !!(sheetState && sheetState.inputFocused), JSON.stringify(sheetState));

// Type a command and press Enter via the input field; verify it reached the PTY.
await cdp.send('Input.insertText', { text: 'echo HERDR_MOBILE_INPUT_OK' });
await evalx(`(() => {
  const input = document.getElementById('mobileTerminalInput');
  if (!input) return false;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
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
check('sheet input reaches PTY and echoes', echoed, tailText.slice(-160));

// Escape closes the sheet.
await evalx(`(() => {
  const input = document.getElementById('mobileTerminalInput');
  if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`);
const sheetClosed = await evalx(`(() => {
  const sheet = document.getElementById('mobileTerminalInputSheet');
  return !!sheet && sheet.hidden;
})()`);
check('Escape closes input sheet', sheetClosed);

const failures = results.filter((r) => !r.ok).length;
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);